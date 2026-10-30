import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ConversationMessage, ConversationPage, ToolActivity } from '../../../shared/contracts';
import { fetchNodeDetails } from '../../api/client';
import { MessageMarkdown } from './MessageMarkdown';
import { ResponseActions,UserMessageMeta } from './ResponseActions';
import { useHistoryRendering } from '../../hooks/useHistoryRendering';
import { ConversationPositionRail } from './ConversationPositionRail';
import { ConversationImages } from './ConversationImages';
import {ConversationRoundGroup,ConversationRoundActivity,ConversationRoundState,groupSettledRounds,mergeRoundObservations,type RoundEntry} from './conversationRounds';
import { ConversationToolGroup, conversationTimeline, groupConversationTimeline } from './toolGroups';

export { ConversationToolGroup, classifyToolActivity, conversationTimeline, formatToolClause, groupConversationTimeline, summarizeToolGroup, toolGroupClauses, toolGroupIcon } from './toolGroups';

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

export function ConversationHistory({ projectId, nodeId, runId, page, scrollContainerRef, tools = [],active=false }: {
  projectId: string; nodeId: string; runId: string | null; page: ConversationPage;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  tools?: ToolActivity[];
  active?:boolean;
}) {
  const [messages, setMessages] = useState(page.messages);
  const [rounds,setRounds]=useState(page.rounds??[]);
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
    setRounds(page.rounds??[]);
    setExpanded(new Set()); anchor.current = null; resetScroll.current = true;
    return () => { request.current?.abort(); request.current = null; };
  }, [page.sourceIdentity, projectId, nodeId, runId]);

  useLayoutEffect(() => {
    const element = scrollContainerRef?.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 100) resetScroll.current = true;
    setMessages(current => mergeLiveConversation(current, page.messages));
    setRounds(current=>mergeRoundObservations(current,page.rounds??[]));
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
      setRounds(current=>mergeRoundObservations(current,next.data!.rounds??[]));
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

  const timeline = conversationTimeline(messages, tools, Boolean(cursor));
  const entries = groupSettledRounds(groupConversationTimeline(timeline),rounds,active);
  const publicMessages = timeline.flatMap(item => item.message&&!item.message.kind ? [item.message] : []);
  const renderEntry=(entry:RoundEntry):React.ReactNode=>{
    if(entry.kind==='round-activity')return <ConversationRoundActivity key={entry.id} round={entry.round} entryId={entry.id}>{renderEntry(entry.entry)}</ConversationRoundActivity>;
    if(entry.kind==='round')return <ConversationRoundGroup key={entry.id} scope={`${projectId}:${nodeId}:${page.sourceIdentity}`} round={entry.round} activityIds={entry.distributed?entry.activities.map(activity=>activity.id):undefined} hasActivities={entry.activities.length>0}>{entry.distributed?null:entry.activities.map(renderEntry)}</ConversationRoundGroup>;

        if (entry.kind === 'tools') return <ConversationToolGroup key={`${page.sourceIdentity}:${entry.id}`} tools={entry.tools} />;
        const message = entry.message;
        if(message.kind==='compaction'){const label=message.text==='Context checkpoint'?'Context checkpoint':'Context compacted';return <div key={message.id} className="conversation-compaction" data-history-row role="separator" aria-label={label}><span>{label}</span></div>;}
        return <div key={message.id} role="article" tabIndex={message.role === 'user' ? -1 : undefined} data-conversation-position={message.role === 'user' ? message.id : undefined} aria-label={message.role==='agent'?'Agent response':'Your message'} className={`chat-bubble-row ${message.role === 'agent' ? 'row-agent' : 'row-user'}`}>
        <div className={`chat-bubble ${message.role === 'agent' ? 'bubble-agent' : 'bubble-user'}`}>
          <ConversationImages projectId={projectId} nodeId={nodeId} source={page.sourceIdentity} images={message.images} />
          {message.text.trim() && <div data-history-row className={`chat-bubble-text message-markdown ${message.role==='user'&&message.text.length > 800 && !expanded.has(message.id) ? 'message-collapsed' : ''}`}><MessageMarkdown text={message.text} /></div>}
          {message.role==='user'&&message.text.length > 800 && <button type="button" className="btn-read-more" aria-expanded={expanded.has(message.id)} onClick={() => setExpanded(current => {
            const next = new Set(current); if (next.has(message.id)) next.delete(message.id); else next.add(message.id); return next;
          })}>{expanded.has(message.id) ? 'Read Less' : 'Read More'}</button>}
        </div>
        {message.role==='user'&&<UserMessageMeta message={message}/>}
        {message.role==='agent'&&<ResponseActions message={message}/>}
      </div>;

  };
  return <div ref={history} className={`conversation-history-content${scrollContainerRef && messages.some(message => message.role === 'user') ? ' has-position-rail' : ''}`} aria-label="Conversation history">
    <ConversationPositionRail key={`${projectId}:${nodeId}:${runId}:${page.sourceIdentity}`} messages={publicMessages} historyRef={history} scrollRef={scrollContainerRef} hasOlder={Boolean(cursor)} loadingOlder={busy} onLoadOlder={() => { void loadOlder(); }} />
    {(cursor || error) && <div className="conversation-history-pagination">
      {cursor && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { void loadOlder(); }}>{busy ? 'Loading…' : error ? 'Retry loading older messages' : 'Load more'}</button>}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </div>}
    <ConversationRoundState scope={`${projectId}:${nodeId}:${page.sourceIdentity}`}><div className="conversation-thread" role="log" aria-label="Conversation turns" aria-live="off">
      {entries.map(renderEntry)}
    </div></ConversationRoundState>
  </div>;
}
