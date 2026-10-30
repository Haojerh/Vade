import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ConversationMessage, NodeDetails, Subagent } from '../../../shared/contracts';
import { fetchNodeDetails, fetchSubagentConversation } from '../../api/client';
import { latestAgentMessage } from './conversation';
import { useDismissLayer } from '../../hooks/useDismissLayer';

export function NodeMessagePreview({ projectId, runId, nodeId, subagent, anchor, onLeave }: {
  projectId: string; runId: string | null; nodeId: string; subagent?: Subagent | null; anchor: HTMLElement; onLeave: () => void;
}) {
  const [details, setDetails] = useState<NodeDetails | null>(null);
  const [child, setChild] = useState<{ messages: ConversationMessage[]; state: 'ready' | 'empty' | 'unavailable' } | null>(null);
  const [error, setError] = useState(false);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  useDismissLayer(visible, ref, onLeave, anchorRef);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const subagentId = subagent?.id ?? null;
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(() => {
      setVisible(true);
      // A child agent's own newest reply, never the parent session's.
      if (subagentId) {
        void fetchSubagentConversation(projectId, nodeId, subagentId, { limit: 20, direction: 'older' }, abort.signal).then((next) => {
          if (abort.signal.aborted) return;
          const availability = next.conversation.meta.availability;
          setChild({ messages: next.conversation.data?.messages ?? [],
            state: availability === 'ready' || availability === 'empty' ? availability : 'unavailable' });
        }).catch(() => { if (!abort.signal.aborted) setError(true); });
        return;
      }
      void fetchNodeDetails(projectId, nodeId, { runId, limit: 200 }, abort.signal).then((next) => {
        if (!abort.signal.aborted) setDetails(next);
      }).catch(() => { if (!abort.signal.aborted) setError(true); });
    }, 250);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [projectId, runId, nodeId, subagentId]);

  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const card = anchor.getBoundingClientRect();
      const height = ref.current?.getBoundingClientRect().height ?? 100;
      const width = Math.min(380, window.innerWidth - 24);
      const top = card.bottom + height + 10 < window.innerHeight ? card.bottom + 10 : card.top - height - 10;
      setPosition({ left: Math.max(12, Math.min(card.left, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(top, window.innerHeight - height - 12)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [visible, details, child, error, anchor, onLeave]);

  if (!visible) return null;
  const message = latestAgentMessage(child ? child.messages : details?.conversation.data?.messages ?? []);
  const heading = subagent ? 'Latest Subagent Message' : details?.node.kind === 'terminal' ? 'Latest Terminal Output' : 'Latest Agent Message';
  const unavailable = subagent ? child?.state === 'unavailable' : false;
  return createPortal(
    <div ref={ref} className="node-message-preview" id="node-message-preview" role="tooltip"
      style={position} onPointerLeave={(event) => { if (!(event.relatedTarget instanceof globalThis.Node) || !anchor.contains(event.relatedTarget)) onLeave(); }}>
      <div className="latest-message-heading">{heading}</div>
      {!subagent && details?.node.kind === 'terminal' ? <p className="node-message-preview-text font-mono">{details.terminalPreview || 'No terminal output yet.'}</p> : message ? <>
        <p className="node-message-preview-text">{message.text}</p>
        {message.at && <time className="text-xs text-muted" dateTime={message.at}>{new Date(message.at).toLocaleTimeString()}</time>}
        {!subagent && details?.conversation.meta.stale && <span className="badge-stale-tag">Stale</span>}
      </> : <p className="text-xs text-muted">{error || unavailable
        ? (subagent ? 'Subagent message unavailable.' : 'Agent message unavailable.')
        : subagent ? (child ? 'No agent reply recorded for this subagent yet.' : 'Loading latest reply…')
        : details ? 'No agent reply in recent history.' : 'Loading latest reply…'}</p>}
    </div>, document.body,
  );
}
