import { useCallback, useEffect, useRef, useState } from 'react';
import type { Node } from '../../../shared/contracts';
import { createWorktreeAgent, fetchInbox, fetchSnapshot, sendNodeMessage } from '../../api/client';
import { assignmentProblem, automaticAssignmentProblem, buildCardPrompt, claimQueuedLaunch, createCardId, observeCard, observeCardResults, queuedCards, type KanbanCard, type KanbanTarget } from '../../features/kanban/kanban';
import { readBoard, updateBoard } from '../../features/kanban/storage';
import { automaticKanban, useAutomaticKanban } from '../../features/kanban/kanbanPreferences';

const dispatchLock = 'vade:kanban-dispatch';

export function useKanban(enabled: boolean) {
  const [cards, setCards] = useState<KanbanCard[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const automatic = useAutomaticKanban();
  const current = useRef(cards);
  const sending = useRef(new Set<string>());
  const mounted = useRef(false);
  const publish = useCallback((next: KanbanCard[]) => {
    current.current = next;
    if (mounted.current) setCards(next);
  }, []);
  useEffect(() => {
    mounted.current = true;
    readBoard().then(rows => { if (mounted.current) { publish(rows); setReady(true); } })
      .catch(() => { if (mounted.current) setError('Board storage could not open. Reload to retry.'); });
    return () => { mounted.current = false; };
  }, [publish]);
  const save = useCallback(async (update: (rows: KanbanCard[]) => KanbanCard[]) => {
    try { const next = await updateBoard(update); publish(next); return next; }
    catch (cause) { if (mounted.current) setError('Board changes could not be saved. Check available browser storage.'); throw cause; }
  }, [publish]);

  const dispatch = useCallback(async (id: string, projectId: string, node: Node, runId: string | null, message: string, files: File[], automaticSend = false) => {
    if (automaticSend && !automaticKanban()) return { ok: false, message: 'Automatic Kanban is paused.' };
    if (!enabled || !ready || sending.current.has(id)) return { ok: false, message: 'This board task is unavailable or already sending.' };
    sending.current.add(id);
    try {
      await save(rows => {
        const card = rows.find(item => item.id === id && item.projectId === projectId);
        if (!card) throw new Error('This task has been removed.');
        if (automaticSend && (!automaticKanban() || card.error || card.target?.kind !== 'existing' || card.target.nodeId !== node.id))
          throw new Error('This task is no longer queued for this agent.');
        const problem = assignmentProblem(card, node, rows);
        if (problem) throw new Error(problem);
        return rows.map(item => item.id === id ? { ...item, status: 'pending', error: undefined,
          assignment: { nodeId: node.id, label: node.label, runId, sentAt: new Date().toISOString(), sawWorking: false } } : item);
      });
    } catch (cause) {
      sending.current.delete(id);
      return { ok: false, message: cause instanceof Error ? cause.message : 'Task assignment could not be saved. Nothing was sent.' };
    }
    try {
      const response = await sendNodeMessage(projectId, node.id, message, undefined, files, false, automaticSend);
      if (!response.ok) throw new Error(response.message || 'Message was not accepted.');
      return response;
    } catch (cause) {
      const message = `Delivery not confirmed: ${cause instanceof Error ? cause.message : 'Connection lost'}. Check the agent before retrying; it may have received the task.`;
      await save(rows => rows.map(item => item.id === id ? { ...item, error: message } : item)).catch(() => {});
      if (mounted.current) setError(message);
      return { ok: false, message };
    } finally { sending.current.delete(id); }
  }, [enabled, ready, save]);

  useEffect(() => {
    if (!enabled || !ready) return;
    const controller = new AbortController();
    let busy = false;
    const collect = async () => {
      if (controller.signal.aborted) return;
      publish(await readBoard());
      const groups = new Map<string, { projectId: string; runId: string | null }>();
      for (const card of current.current) {
        if (card.status === 'pending' && card.assignment && !sending.current.has(card.id))
          groups.set(`${card.projectId}:${card.assignment.runId}`, { projectId: card.projectId, runId: card.assignment.runId });
        if (automaticKanban() && card.status === 'todo' && card.target && !card.error)
          groups.set(`${card.projectId}:null`, { projectId: card.projectId, runId: null });
      }
      const snapshots = new Map<string, Node[]>();
      for (const group of groups.values()) {
        try {
          const snapshot = await fetchSnapshot(group.projectId, group.runId, controller.signal);
          if (controller.signal.aborted) return;
          if (snapshot.graph.meta.stale || snapshot.graph.meta.availability !== 'ready' || !snapshot.graph.data) continue;
          const nodes = snapshot.graph.data.nodes;
          if (group.runId === null) snapshots.set(group.projectId, nodes);
          await save(rows => rows.map(card => card.projectId === group.projectId && card.assignment?.runId === group.runId
            && !sending.current.has(card.id) ? observeCard(card, nodes) : card));
        } catch { /* Unavailable observations cannot settle or dispatch tasks. */ }
      }
      if (groups.size && !controller.signal.aborted) {
        try {
          const results = await fetchInbox(controller.signal);
          if (controller.signal.aborted) return;
          if (!results.meta.stale && results.meta.availability === 'ready' && results.data)
            await save(rows => rows.map(card => sending.current.has(card.id) ? card : observeCardResults(card, results.data!.items)));
        } catch { /* Retain pending work when results are unavailable. */ }
      }
      if (!automaticKanban() || controller.signal.aborted) return;
      // One action per tick: subsequent decisions require a new snapshot.
      for (const queued of queuedCards(current.current)) {
        const nodes = snapshots.get(queued.projectId);
        if (!nodes) continue;
        const target = queued.target!;
        if (target.kind === 'new') {
          if (queued.launchAttemptedAt) continue;
          const worktree = nodes.find(node => node.id === target.worktreeNodeId && node.kind === 'worktree' && !node.stale);
          if (!worktree) continue;
          const occupied = nodes.some(node => node.kind !== 'worktree' && node.worktreeId === worktree.worktreeId && (node.workflow || ['working', 'waiting', 'blocked'].includes(node.state)))
            || current.current.some(card => card.status === 'pending' && nodes.find(node => node.id === card.assignment?.nodeId)?.worktreeId === worktree.worktreeId);
          const earlierLaunch = queuedCards(current.current).some(card => {
            const target = card.target;
            return card.id !== queued.id && card.createdAt <= queued.createdAt && card.launchAttemptedAt && target?.kind === 'existing'
              && nodes.find(node => node.id === target.nodeId)?.worktreeId === worktree.worktreeId;
          });
          if (occupied || earlierLaunch) continue;
          let claimed = false;
          // Persist before launch; never retry an interrupted/uncertain creation.
          await save(rows => rows.map(card => {
            if (card.id !== queued.id || !automaticKanban()) return card;
            const next = claimQueuedLaunch(card, new Date().toISOString());
            claimed = next !== card; return next;
          }));
          if (!claimed || !automaticKanban() || controller.signal.aborted) return;
          try {
            const result = await createWorktreeAgent(queued.projectId, worktree.id, target.command, queued.title.slice(0, 100));
            if (!result.ok || !result.handle) throw new Error(result.message || 'No session identity was returned.');
            await save(rows => rows.map(card => card.id === queued.id && card.target?.kind === 'new' ? { ...card,
              target: { kind: 'existing', nodeId: result.handle!, label: result.title || target.agentLabel } } : card));
          } catch (cause) {
            await save(rows => rows.map(card => card.id === queued.id && card.target?.kind === 'new' ? { ...card,
              error: `Session creation not confirmed. Check your agent tabs before removing or reassigning this task. ${cause instanceof Error ? cause.message : ''}` } : card));
          }
          return;
        }
        const node = nodes.find(node => node.id === target.nodeId);
        if (!node || automaticAssignmentProblem(queued, node, current.current, nodes)) continue;
        await dispatch(queued.id, queued.projectId, node, null, buildCardPrompt(queued), queued.files, true);
        return;
      }
    };
    const poll = async () => {
      if (busy || (!automaticKanban() && document.visibilityState !== 'visible')) return;
      busy = true;
      try {
        // Elect one dispatcher across windows. Saved claims provide a second fence.
        if (navigator.locks) await navigator.locks.request(dispatchLock, { ifAvailable: true }, lock => lock ? collect() : Promise.resolve());
        else if (!automaticKanban()) await collect();
        else setError('Automatic Kanban requires a secure local connection. Open Vade on localhost or HTTPS.');
      } catch { /* Leave saved work intact on storage/network failures. */ }
      finally { busy = false; }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [enabled, ready, automatic, save, publish, dispatch]);

  const add = async (projectId: string, title: string, prompt: string, files: File[], target?: KanbanTarget) => {
    await save(rows => {
      if (rows.length >= 200) throw new Error('Board limit reached (200 cards). Remove old cards first.');
      if (target && buildCardPrompt({ title, prompt, status: 'todo' } as KanbanCard).length > 10000) throw new Error('Queued task title and prompt must fit within the 10,000 character message limit.');
      return [...rows, { id: createCardId(), projectId, title, prompt, files, status: 'todo', createdAt: new Date().toISOString(), target }];
    });
  };
  const assign = async (id: string, projectId: string, node: Node, runId: string | null, message: string, files: File[]) =>
    navigator.locks ? await navigator.locks.request(dispatchLock, () => dispatch(id, projectId, node, runId, message, files))
      : await dispatch(id, projectId, node, runId, message, files);
  const unqueue = (id: string) => save(rows => rows.map(card => card.id === id && card.status === 'todo' ? { ...card, target: undefined, error: undefined } : card));
  const remove = (id: string) => save(rows => rows.filter(item => item.id !== id));
  const clear = (projectId: string) => save(rows => rows.filter(item => item.projectId !== projectId));
  return { cards, ready, error, automatic, add, assign, unqueue, remove, clear, dismissError: () => setError(null) };
}
