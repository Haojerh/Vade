import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ConversationMessage, ConversationPage } from '../../../shared/contracts';
import { fetchNodeDetails } from '../../api/client';
import { MessageMarkdown } from './MessageMarkdown';

export function mergeConversationMessages(older: ConversationMessage[], current: ConversationMessage[]): ConversationMessage[] {
  const seen = new Set<string>();
  return [...older, ...current].filter(message => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

export function ConversationHistory({ projectId, nodeId, runId, page, scrollContainerRef }: {
  projectId: string; nodeId: string; runId: string | null; page: ConversationPage;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const [messages, setMessages] = useState(page.messages);
  const [cursor, setCursor] = useState(page.nextCursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(new Set<string>());
  const request = useRef<AbortController | null>(null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const resetScroll = useRef(true);

  useLayoutEffect(() => {
    request.current?.abort(); request.current = null;
    setMessages(page.messages); setCursor(page.nextCursor); setError(null); setBusy(false);
    setExpanded(new Set()); anchor.current = null; resetScroll.current = true;
    return () => { request.current?.abort(); request.current = null; };
  }, [page, projectId, nodeId, runId]);

  useLayoutEffect(() => {
    const element = scrollContainerRef?.current;
    if (!element) return;
    if (resetScroll.current) { element.scrollTop = element.scrollHeight; resetScroll.current = false; }
    else if (anchor.current) {
      element.scrollTop = anchor.current.top + element.scrollHeight - anchor.current.height;
      anchor.current = null;
    }
  }, [messages]);

  const loadOlder = useCallback(async () => {
    if (!cursor || request.current) return;
    const abort = new AbortController(); request.current = abort;
    setBusy(true); setError(null);
    try {
      const details = await fetchNodeDetails(projectId, nodeId, { runId, cursor, direction: 'older', limit: 20 }, abort.signal);
      if (abort.signal.aborted) return;
      const next = details.conversation;
      if (!next.data || next.meta.issue || next.data.sourceIdentity !== page.sourceIdentity) throw new Error(next.meta.issue?.message || 'Conversation changed. Refresh to load its current history.');
      const element = scrollContainerRef?.current;
      if (element) anchor.current = { height: element.scrollHeight, top: element.scrollTop };
      setMessages(current => mergeConversationMessages(next.data!.messages, current));
      setCursor(next.data.nextCursor === cursor ? null : next.data.nextCursor);
    } catch (err) {
      if (!abort.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load older messages.');
    } finally {
      if (request.current === abort) { request.current = null; setBusy(false); }
    }
  }, [cursor, projectId, nodeId, runId, page.sourceIdentity, scrollContainerRef]);

  useEffect(() => {
    const element = scrollContainerRef?.current;
    if (!element) return;
    const scroll = () => {
      if (element.scrollTop <= 24 && element.scrollHeight > element.clientHeight + 24 && !error && !resetScroll.current) void loadOlder();
    };
    element.addEventListener('scroll', scroll, { passive: true });
    return () => element.removeEventListener('scroll', scroll);
  }, [scrollContainerRef, error, loadOlder]);

  return <div className="conversation-history-content" aria-label="Conversation history">
    <div className="conversation-history-pagination">
      {cursor ? <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { void loadOlder(); }}>{busy ? 'Loading…' : error ? 'Retry loading older messages' : 'Load more'}</button> : <span className="text-xs text-muted">Start of conversation</span>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>
    <div className="conversation-thread" role="log" aria-label="Conversation turns" aria-live="off">
      {messages.map(message => <div key={message.id} className={`chat-bubble-row ${message.role === 'agent' ? 'row-agent' : 'row-user'}`}>
        <div className={`chat-bubble ${message.role === 'agent' ? 'bubble-agent' : 'bubble-user'}`}>
          <div className="chat-bubble-header"><span className="bubble-role font-semibold text-xs">{message.role === 'agent' ? 'Agent' : 'User'}</span>
            <time className="bubble-time font-mono text-xs text-muted" dateTime={message.at ?? undefined}>{message.at ? new Date(message.at).toLocaleString() : ''}</time></div>
          <div className={`chat-bubble-text message-markdown ${message.text.length > 800 && !expanded.has(message.id) ? 'message-collapsed' : ''}`}><MessageMarkdown text={message.text} /></div>
          {message.text.length > 800 && <button type="button" className="btn-read-more" aria-expanded={expanded.has(message.id)} onClick={() => setExpanded(current => {
            const next = new Set(current); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next;
          })}>{expanded.has(message.id) ? 'Read Less' : 'Read More'}</button>}
        </div>
      </div>)}
    </div>
  </div>;
}
