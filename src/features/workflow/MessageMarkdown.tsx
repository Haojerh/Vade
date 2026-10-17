import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MessageMarkdown({ text }: { text: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => href && /^https?:\/\//i.test(href)
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span className="message-file-reference">{children}</span>,
    img: ({ alt }) => <span>{alt}</span>,
  }}>{text}</Markdown>;
}
