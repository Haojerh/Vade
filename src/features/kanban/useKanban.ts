import { useCallback, useEffect, useRef, useState } from 'react';
import type { Node } from '../../../shared/contracts';
import { fetchInbox, fetchSnapshot, sendNodeMessage } from '../../api/client';
import { assignmentProblem, createCardId, observeCard, observeCardResults, type KanbanCard } from './kanban';
import { readBoard, writeBoard } from './storage';

export function useKanban(enabled: boolean) {
  const [cards, setCards] = useState<KanbanCard[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(cards);
  const queue = useRef(Promise.resolve());
  const sending = useRef(new Set<string>());
  useEffect(() => {
    let active = true;
    readBoard().then(rows => { if (active) { current.current = rows; setCards(rows); setReady(true); } })
      .catch(() => { if (active) setError('Board storage could not open. Reload to retry.'); });
    return () => { active = false; };
  }, []);
  const save = useCallback((next: KanbanCard[]) => {
    const previous = current.current;
    current.current = next;
    setCards(next);
    const saved = queue.current.then(() => writeBoard(next));
    queue.current = saved.catch(() => {
      if (current.current === next) { current.current = previous; setCards(previous); }
      setError('Board changes could not be saved. Check available browser storage.');
    });
    return saved;
  }, []);
  useEffect(() => {
    if (!enabled || !ready) return;
    const controller = new AbortController();
    let busy = false;
    const poll = async () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const groups = new Map<string, KanbanCard>();
        for (const card of current.current) if (card.status === 'pending' && card.assignment && !sending.current.has(card.id)) {
          groups.set(`${card.projectId}:${card.assignment.runId}`, card);
        }
        for (const card of groups.values()) {
          try {
            const snapshot = await fetchSnapshot(card.projectId, card.assignment!.runId, controller.signal);
            if (controller.signal.aborted) return;
            if (snapshot.graph.meta.stale || snapshot.graph.meta.availability !== 'ready' || !snapshot.graph.data) continue;
            const next = current.current.map(item => item.projectId === card.projectId && item.assignment?.runId === card.assignment!.runId
              && !sending.current.has(item.id) ? observeCard(item, snapshot.graph.data!.nodes) : item);
            if (next.some((item, index) => item !== current.current[index])) await save(next);
          } catch { /* Retain pending cards when observations are unavailable. */ }
        }
        if (groups.size && !controller.signal.aborted) {
          try {
            const results = await fetchInbox(controller.signal);
            if (controller.signal.aborted || results.meta.stale || results.meta.availability !== 'ready' || !results.data) return;
            const next = current.current.map(card => sending.current.has(card.id) ? card : observeCardResults(card, results.data!.items));
            if (next.some((card, index) => card !== current.current[index])) await save(next);
          } catch { /* A missing result is not a failure. */ }
        }
      } finally { busy = false; }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [enabled, ready, save]);
  const add = async (projectId: string, title: string, prompt: string, files: File[]) => {
    if (current.current.length >= 200) throw new Error('Board limit reached (200 cards). Remove old cards first.');
    await save([...current.current, { id: createCardId(), projectId, title, prompt, files, status: 'todo', createdAt: new Date().toISOString() }]);
  };
  const assign = async (id: string, projectId: string, node: Node, runId: string | null, message: string, files: File[]): Promise<{ ok: boolean; message?: string }> => {
    const card = current.current.find(item => item.id === id && item.projectId === projectId);
    if (!enabled || !ready || !card || sending.current.has(id)) return { ok: false, message: 'This board task is unavailable or already sending.' };
    const problem = assignmentProblem(card, node, current.current);
    if (problem) { setError(problem); return { ok: false, message: problem }; }
    sending.current.add(id);
    setError(null);
    const pending: KanbanCard = { ...card, status: 'pending', error: undefined,
      assignment: { nodeId: node.id, label: node.label, runId, sentAt: new Date().toISOString(), sawWorking: false } };
    try {
      // Persist before dispatch: never silently resend after a reload or uncertain response.
      await save(current.current.map(item => item.id === id ? pending : item));
    } catch {
      current.current = current.current.map(item => item.id === id ? card : item);
      setCards(current.current);
      sending.current.delete(id);
      return { ok: false, message: 'Task assignment could not be saved. Nothing was sent.' };
    }
    try {
      const response = await sendNodeMessage(projectId, node.id, message, undefined, files);
      if (!response.ok) throw new Error(response.message || 'Message was not accepted.');
      return response;
    } catch (cause) {
      const message = `Delivery not confirmed: ${cause instanceof Error ? cause.message : 'Connection lost'}. Check the agent before retrying; it may have received the task.`;
      await save(current.current.map(item => item.id === id ? { ...item, error: message } : item)).catch(() => {});
      setError(message);
      return { ok: false, message };
    } finally { sending.current.delete(id); }
  };
  const remove = (id: string) => save(current.current.filter(item => item.id !== id));
  const clear = (projectId: string) => save(current.current.filter(item => item.projectId !== projectId));
  return { cards, ready, error, add, assign, remove, clear, dismissError: () => setError(null) };
}
