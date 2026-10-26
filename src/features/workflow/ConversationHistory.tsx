import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ConversationMessage, ConversationPage, ToolActivity } from '../../../shared/contracts';
import { fetchNodeDetails } from '../../api/client';
import { MessageMarkdown } from './MessageMarkdown';
import { ConversationToolCall } from './ConversationToolCall';
import { ResponseActions,UserMessageMeta } from './ResponseActions';
import { useHistoryRendering } from '../../hooks/useHistoryRendering';

export function conversationTimeline(messages: ConversationMessage[], tools: ToolActivity[], limited: boolean) {
  const first = messages.find(message => message.at)?.at;
  const cutoff = limited && first ? Date.parse(first) : -Infinity;
  const items = [...messages.map(message => ({ id: message.id, at: message.at, message, tool: null as ToolActivity | null })),
    ...tools.filter(tool => !tool.at || Date.parse(tool.at) >= cutoff).map(tool => ({ id: tool.id, at: tool.at, message: null as ConversationMessage | null, tool }))];
  return items.sort((a, b) => (a.at ? Date.parse(a.at) : Infinity) - (b.at ? Date.parse(b.at) : Infinity));
}

export function mergeConversationMessages(older: ConversationMessage[], current: ConversationMessage[]): ConversationMessage[] {
  const seen = new Set<string>();
  return [...older, ...current].filter(message => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

export function mergeLiveConversation(current: ConversationMessage[], incoming: ConversationMessage[]): ConversationMessage[] {
  const messages = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()];
}

export function ConversationHistory({ projectId, nodeId, runId, page, scrollContainerRef, tools = [] }: {
  projectId: string; nodeId: string; runId: string | null; page: ConversationPage;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  tools?: ToolActivity[];
}) {
  const [messages, setMessages] = useState(page.messages);
  const [cursor, setCursor] = useState(page.nextCursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(new Set<string>());
  const request = useRef<AbortController | null>(null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const resetScroll = useRef(true);
  const history = useRef<HTMLDivElement>(null);
  useHistoryRendering(history, messages.length + tools.length > 80);

  useLayoutEffect(() => {
    request.current?.abort(); request.current = null;
    setMessages(page.messages); setCursor(page.nextCursor); setError(null); setBusy(false);
    setExpanded(new Set()); anchor.current = null; resetScroll.current = true;
    return () => { request.current?.abort(); request.current = null; };
  }, [page.sourceIdentity, projectId, nodeId, runId]);

  useLayoutEffect(() => {
    const element = scrollContainerRef?.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 100) resetScroll.current = true;
    setMessages(current => mergeLiveConversation(current, page.messages));
  }, [page]);

  useLayoutEffect(() => {
    const element = scrollContainerRef?.current;
    if (!element) return;
    if (resetScroll.current) { element.scrollTop = element.scrollHeight; resetScroll.current = false; }
    else if (anchor.current) {
      element.scrollTop = anchor.current.top + element.scrollHeight - anchor.current.height;
      anchor.current = null;
    }
  }, [messages, tools]);

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

  return <div ref={history} className="conversation-history-content" aria-label="Conversation history">
    {(cursor || error) && <div className="conversation-history-pagination">
      {cursor && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { void loadOlder(); }}>{busy ? 'Loading…' : error ? 'Retry loading older messages' : 'Load more'}</button>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>}
    <div className="conversation-thread" role="log" aria-label="Conversation turns" aria-live="off">
      {conversationTimeline(messages, tools, Boolean(cursor)).map((item, index, timeline) => {
        if (item.tool) {
          if (timeline[index - 1]?.tool) return null;
          const group: ToolActivity[] = [];
          for (let next = index; next < timeline.length && timeline[next].tool; next++) group.push(timeline[next].tool!);
          return <div className="conversation-tool-group" key={item.id} aria-label="Tool activity">
            {group.map(tool => <ConversationToolCall key={tool.id} tool={tool} />)}
          </div>;
        }
        const message = item.message;
        if (!message) return null;
        return <div key={message.id} role="article" aria-label={message.role==='agent'?'Agent response':'Your message'} className={`chat-bubble-row ${message.role === 'agent' ? 'row-agent' : 'row-user'}`}>
        <div className={`chat-bubble ${message.role === 'agent' ? 'bubble-agent' : 'bubble-user'}`}>
          <div data-history-row className={`chat-bubble-text message-markdown ${message.role==='user'&&message.text.length > 800 && !expanded.has(message.id) ? 'message-collapsed' : ''}`}><MessageMarkdown text={message.text} /></div>
          {message.role==='user'&&message.text.length > 800 && <button type="button" className="btn-read-more" aria-expanded={expanded.has(message.id)} onClick={() => setExpanded(current => {
            const next = new Set(current); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next;
          })}>{expanded.has(message.id) ? 'Read Less' : 'Read More'}</button>}
        </div>
        {message.role==='user'&&<UserMessageMeta message={message}/>}
        {message.role==='agent'&&<ResponseActions message={message}/>}
      </div>;
      })}
    </div>
  </div>;
}
