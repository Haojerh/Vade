import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NodeDetails } from '../../shared/contracts';
import { fetchNodeDetails } from '../api';
import { latestAgentMessage } from '../conversation';

export function NodeMessagePreview({ projectId, runId, nodeId, anchor, onLeave }: {
  projectId: string; runId: string | null; nodeId: string; anchor: HTMLElement; onLeave: () => void;
}) {
  const [details, setDetails] = useState<NodeDetails | null>(null);
  const [error, setError] = useState(false);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(() => {
      setVisible(true);
      void fetchNodeDetails(projectId, nodeId, { runId, limit: 200 }, abort.signal).then((next) => {
        if (!abort.signal.aborted) setDetails(next);
      }).catch(() => { if (!abort.signal.aborted) setError(true); });
    }, 250);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [projectId, runId, nodeId]);

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
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onLeave(); };
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('keydown', escape);
    };
  }, [visible, details, error, anchor, onLeave]);

  if (!visible) return null;
  const message = latestAgentMessage(details?.conversation.data?.messages ?? []);
  return createPortal(
    <div ref={ref} className="node-message-preview" id="node-message-preview" role="tooltip"
      style={position} onPointerLeave={(event) => { if (!(event.relatedTarget instanceof globalThis.Node) || !anchor.contains(event.relatedTarget)) onLeave(); }}>
      <div className="latest-message-heading">Latest Agent Message</div>
      {message ? <>
        <p className="node-message-preview-text">{message.text}</p>
        {message.at && <time className="text-xs text-muted" dateTime={message.at}>{new Date(message.at).toLocaleTimeString()}</time>}
        {details?.conversation.meta.stale && <span className="badge-stale-tag">Stale</span>}
      </> : <p className="text-xs text-muted">{error || details?.conversation.meta.availability === 'unsupported' || details?.conversation.meta.availability === 'unavailable'
        ? 'Agent message unavailable.' : details ? 'No agent reply in recent history.' : 'Loading latest reply…'}</p>}
    </div>, document.body,
  );
}
