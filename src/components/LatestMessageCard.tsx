import { useId, useLayoutEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ConversationMessage } from '../../shared/contracts';

export function LatestMessageCard({ message, stale }: { message: ConversationMessage; stale: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => setOverflowing(body.scrollHeight > 210);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [message.text]);
  return <div className="latest-message-card">
    <div ref={bodyRef} id={bodyId} className={`message-markdown ${expanded ? 'message-expanded' : 'message-collapsed'}`}>
      <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
        a: ({ href, children }) => href && /^https?:\/\//i.test(href)
          ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          : <span className="message-file-reference">{children}</span>,
        img: ({ alt }) => <span>{alt}</span>,
      }}>{message.text}</Markdown>
    </div>
    <div className="latest-message-footer">
      {message.at ? <time dateTime={message.at}>{new Date(message.at).toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })}</time> : <span>Time unavailable</span>}
      {stale && <span className="badge-stale-tag">Stale</span>}
      {overflowing && <button type="button" className="btn btn-secondary btn-xs" aria-expanded={expanded}
        aria-controls={bodyId} onClick={() => setExpanded((value) => !value)}>{expanded ? 'Show less' : 'Read more'}</button>}
    </div>
  </div>;
}
