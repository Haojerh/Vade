import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationMessage, ConversationPage, Section, Subagent, ToolActivity } from '../../../../shared/contracts';
import { fetchSubagentConversation, fetchSubagents } from '../../../api/client';
import { ProviderIcon } from '../../../components/providers/ProviderIcon';
import { Icon } from '../../../components/ui/Icon';
import { Modal } from '../../../components/ui/Modal';
import { OverlayCloseButton } from '../../../components/ui/OverlayCloseButton';
import { useConfirmationState } from '../../../hooks/ui/useConfirmationState';
import { ConversationToolGroup, conversationTimeline, groupConversationTimeline } from './toolGroups';
import { MessageMarkdown } from './MessageMarkdown';

const POLL_MS = 5000;

function relative(at: string | null): string {
  if (!at) return '';
  const value = Date.parse(at);
  if (!Number.isFinite(value)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function stateLabel(state: Subagent['state']): string {
  return state === 'working' ? 'working' : state === 'waiting' ? 'waiting' : state === 'completed' ? 'done'
    : state === 'failed' ? 'failed' : state === 'idle' ? 'idle' : 'unknown';
}

export interface SubagentTrayProps {
  projectId: string;
  nodeId: string;
  provider: string | null;
  subagents: Section<Subagent[]> | undefined;
  onOpen: (subagent: Subagent) => void;
}

/** Chevron section above the composer listing the native child agents of this session. */
export function SubagentTray({ projectId, nodeId, provider, subagents, onOpen }: SubagentTrayProps) {
  const [expanded, setExpanded] = useState(false);
  const [live, setLive] = useState<Section<Subagent[]> | undefined>(subagents);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => { setLive(subagents); }, [subagents]);
  useEffect(() => { setExpanded(false); setError(null); }, [projectId, nodeId]);

  const refresh = useCallback(async () => {
    requestRef.current?.abort();
    const abort = new AbortController();
    requestRef.current = abort;
    try {
      const next = await fetchSubagents(projectId, nodeId, abort.signal);
      if (!abort.signal.aborted) { setLive(next); setError(null); }
    } catch (err) {
      if (!abort.signal.aborted) setError(err instanceof Error ? err.message : 'Child agents could not be read.');
    }
  }, [projectId, nodeId]);

  useEffect(() => {
    if (!expanded) { requestRef.current?.abort(); return; }
    void refresh();
    const timer = setInterval(() => { void refresh(); }, POLL_MS);
    return () => { clearInterval(timer); requestRef.current?.abort(); };
  }, [expanded, refresh]);

  const children = live?.data ?? [];
  const working = children.filter(child => child.state === 'working').length;
  // A provider that records no child agents shows nothing at all rather than an empty
  // "unsupported" affordance in the composer.
  if (!children.length) return null;

  return (
    <div className={`subagent-tray${expanded ? ' is-expanded' : ''}`}>
      <button type="button" className="subagent-tray-header" aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}>
        <span className={`subagent-tray-chevron${expanded ? ' is-open' : ''}`} aria-hidden="true">
          <Icon name="chevron-right" size={12} />
        </span>
        <span className="subagent-tray-title">
          {children.length ? `${children.length} subagent${children.length === 1 ? '' : 's'}` : 'Subagents'}
          {working > 0 && <span className="subagent-tray-working"> · {working} working</span>}
        </span>
        <span className="subagent-tray-icons" aria-hidden="true">
          {children.slice(0, 4).map(child => <span key={child.id} className={`subagent-dot state-${child.state}`} />)}
        </span>
      </button>
      <div className={`subagent-tray-body${expanded ? ' is-open' : ''}`} aria-hidden={!expanded} inert={!expanded ? true : undefined}>
        <div className="subagent-tray-body-inner">
          <div className="subagent-tray-list">
            {error && <p className="subagent-tray-note text-danger">{error}</p>}
            {children.map(child => (
              <button type="button" key={child.id} className="subagent-row" tabIndex={expanded ? 0 : -1} onClick={() => onOpen(child)}>
                <span className={`subagent-dot state-${child.state}`} aria-hidden="true" />
                <ProviderIcon provider={provider} size={13} />
                <span className="subagent-row-label">{child.label}</span>
                {child.role && <span className="subagent-row-role font-mono text-xs">{child.role}</span>}
                <span className="subagent-row-meta font-mono text-xs">
                  {stateLabel(child.state)}{child.lastActivityAt ? ` · ${relative(child.lastActivityAt)}` : ''}
                </span>
                <Icon name="chevron-right" size={11} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface SubagentDetailsDialogProps {
  projectId: string;
  nodeId: string;
  provider: string | null;
  subagent: Subagent | null;
  onClose: () => void;
}

/** Read-only child view: recorded public turns and tool calls in the same thread, grouping
 *  and bubble styles as native chat, or an explicit statement that the provider keeps none. */
export function SubagentDetailsDialog({ projectId, nodeId, provider, subagent, onClose }: SubagentDetailsDialogProps) {
  // The overlay keeps its own presence so the shared exit animation can run after the parent
  // clears the selected child. Only the parent's selection drives it: reacting to the overlay
  // phase here would reopen the dialog while it is still animating out.
  const overlay = useConfirmationState<Subagent>({ onClosed: onClose });
  const shown = overlay.data ?? subagent;
  const previous = useRef<Subagent | null>(null);
  const openOverlay = useRef(overlay.open); openOverlay.current = overlay.open;
  const closeOverlay = useRef(overlay.close); closeOverlay.current = overlay.close;
  useEffect(() => {
    if (subagent) { if (previous.current?.id !== subagent.id) openOverlay.current(subagent); }
    else if (previous.current) closeOverlay.current();
    previous.current = subagent;
  }, [subagent]);

  const [page, setPage] = useState<Section<ConversationPage> | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const [state, setState] = useState<Subagent['state'] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const childId = shown?.id ?? null;

  const load = useCallback(async (cursor?: string | null) => {
    if (!childId) return;
    requestRef.current?.abort();
    const abort = new AbortController();
    requestRef.current = abort;
    setLoading(true);
    try {
      const next = await fetchSubagentConversation(projectId, nodeId, childId, { cursor: cursor ?? null, limit: 20, direction: 'older' }, abort.signal);
      if (abort.signal.aborted) return;
      setPage(next.conversation);
      setTools(current => cursor ? [...next.tools, ...current] : next.tools);
      setError(null);
      const incoming = next.conversation.data?.messages ?? [];
      setMessages(current => cursor ? [...incoming, ...current] : incoming);
    } catch (err) {
      if (!abort.signal.aborted) setError(err instanceof Error ? err.message : 'The child transcript could not be read.');
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  }, [projectId, nodeId, childId]);

  useEffect(() => {
    setPage(null); setMessages([]); setTools([]); setError(null); setState(shown?.state ?? null);
    if (childId) void load(null);
    return () => { requestRef.current?.abort(); };
  }, [childId, load]);

  // The recorded state can move while the child runs; re-read the parent's child list instead
  // of guessing from transcript growth.
  useEffect(() => {
    if (!childId) return;
    const abort = new AbortController();
    const poll = async () => {
      try {
        const next = await fetchSubagents(projectId, nodeId, abort.signal);
        const current = next.data?.find(child => child.id === childId);
        if (!abort.signal.aborted && current) setState(current.state);
      } catch { /* Keep the last observed state. */ }
    };
    const timer = setInterval(() => { void poll(); }, POLL_MS);
    return () => { abort.abort(); clearInterval(timer); };
  }, [projectId, nodeId, childId]);

  const unavailable = shown?.transcript === 'unavailable' || page?.meta.availability === 'unavailable';
  const reason = page?.meta.issue?.message ?? shown?.reason ?? 'This provider keeps no separate transcript for the child agent.';
  const nextCursor = page?.data?.nextCursor ?? null;
  const observedState = state ?? shown?.state ?? 'unknown';
  const entries = useMemo(() => groupConversationTimeline(conversationTimeline(messages, tools, Boolean(nextCursor))), [messages, tools, nextCursor]);

  const header = useMemo(() => shown && (
    <header className="subagent-details-header">
      <ProviderIcon provider={provider} size={18} />
      <div className="subagent-details-titles">
        <span className="subagent-details-label">{shown.label}</span>
        <span className="subagent-details-sub font-mono text-xs">
          {[shown.role, shown.model, relative(shown.lastActivityAt)].filter(Boolean).join(' · ') || 'recorded child agent'}
        </span>
      </div>
      <span className={`subagent-state-badge state-${observedState}`}>
        <span className={`subagent-dot state-${observedState}`} aria-hidden="true" />
        {stateLabel(observedState)}
      </span>
      <OverlayCloseButton onClick={overlay.close} aria-label="Close subagent details" />
    </header>
  ), [shown, provider, observedState, overlay.close]);

  return (
    <Modal isOpen={overlay.present || Boolean(subagent)} isClosing={overlay.closing} onClose={overlay.close} className="subagent-details-dialog"
      aria-label={shown ? `Subagent ${shown.label}` : 'Subagent'}>
      <div className="subagent-details">
        {header}
        <div className="subagent-details-body">
          {unavailable ? (
            <p className="subagent-details-note">{reason}</p>
          ) : (
            <div className="conversation-thread" role="log" aria-label="Child agent conversation" aria-live="off">
              {nextCursor && (
                <div className="conversation-history-pagination">
                  <button type="button" className="btn btn-secondary btn-sm" disabled={loading} onClick={() => { void load(nextCursor); }}>
                    {loading ? 'Loading…' : 'Load older turns'}
                  </button>
                </div>
              )}
              {entries.map(entry => entry.kind === 'tools'
                ? <ConversationToolGroup key={`${page?.data?.sourceIdentity}:${entry.id}`} tools={entry.tools} />
                : (
                  <div key={entry.message.id} role="article" className={`chat-bubble-row ${entry.message.role === 'agent' ? 'row-agent' : 'row-user'}`}
                    aria-label={entry.message.role === 'agent' ? 'Child agent response' : 'Prompt sent to the child agent'}>
                    <div className={`chat-bubble ${entry.message.role === 'agent' ? 'bubble-agent' : 'bubble-user'}`}>
                      <div className="chat-bubble-text message-markdown"><MessageMarkdown text={entry.message.text} /></div>
                    </div>
                  </div>
                ))}
              {!messages.length && !tools.length && !loading && !error && <p className="subagent-details-note">No public turns recorded for this child yet.</p>}
              {loading && !messages.length && <p className="subagent-details-note" role="status">Loading child transcript…</p>}
              {error && <p className="subagent-details-note text-danger" role="alert">{error}</p>}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
