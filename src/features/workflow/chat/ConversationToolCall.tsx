import { useState } from 'react';
import { FileText, FilePenLine, Terminal, Search, Globe, Wrench } from 'lucide-react';
import type { ToolActivity, ToolEditPreview } from '../../../../shared/contracts';
import { Disclosure } from '../../../components/ui/Disclosure';
import { ToolEditDiff } from './ToolActivityCard';

export function compactEditLines(lines: ToolEditPreview['lines']) {
  if (lines.length <= 8) return lines;
  const removes = lines.filter(line => line.kind === 'remove').slice(0, 3);
  const adds = lines.filter(line => line.kind === 'add').slice(0, 3);
  if (!removes.length || !adds.length) return lines.slice(0, 8);
  // Keep one line of native context above the change so the excerpt reads as a real
  // hunk, then a balanced pair of removed and added rows.
  const first = lines.findIndex(line => line.kind !== 'context');
  const before = first > 0 ? [lines[first - 1]] : [];
  return [...before, ...removes, ...adds];
}

export function ConversationToolCall({ tool }: { tool: ToolActivity }) {
  const [more, setMore] = useState(false);
  const edit = tool.label.startsWith('Edit');
  const edits = tool.edits ?? [];
  const separator = tool.label.indexOf(': ');
  const action = separator < 0 ? tool.label : tool.label.slice(0, separator);
  const detail = separator < 0 ? '' : tool.label.slice(separator + 2);
  const ToolIcon = edit || edits.length ? FilePenLine : /read|view/i.test(action) ? FileText
    : /run|exec|shell|terminal|bash/i.test(action) ? Terminal : /search|find|grep/i.test(action) ? Search
    : /web|browse|fetch/i.test(action) ? Globe : Wrench;
  const summary = <span className="conversation-tool-summary" title={tool.label}>
    <ToolIcon size={13} aria-hidden="true" />
    <span className="conversation-tool-action">{action}</span>
    {detail && <span className="conversation-tool-target">{detail}</span>}
  </span>;
  const expandable = edits.some(edit => edit.lines.length > 8 || edit.truncated) || (tool.detail?.length ?? 0) > 500;
  const body = edits.length || tool.children?.length || (tool.detail && tool.detail !== tool.label);
  if (!body) return <div className="conversation-tool-call conversation-tool-call-plain" data-history-row data-tool-id={tool.id}>{summary}</div>;
  const showMore = expandable ? <button type="button" className="btn-read-more tool-edit-more" aria-expanded={more} onClick={() => setMore(value => !value)}>{more ? 'Show less' : 'Show more'}</button> : null;
  return <div className="conversation-tool-call" data-history-row data-tool-id={tool.id}>
    <Disclosure title={tool.label} triggerContent={summary} compact chevronEnd lazy defaultOpen={edit || edits.length > 0}>
      <div className="conversation-tool-details">
      {tool.children?.length ? <div className="conversation-tool-children">{tool.children.map(child => <ConversationToolCall key={child.id} tool={child} />)}</div> : null}
      {edits.length ? <ToolEditDiff hideCaption={expandable} footer={showMore} edits={edits.map(edit => ({
        ...edit,
        lines: more ? edit.lines : compactEditLines(edit.lines),
        totalAdded: edit.lines.filter(l => l.kind === 'add').length,
        totalRemoved: edit.lines.filter(l => l.kind === 'remove').length,
      }))} />
        : tool.detail && tool.detail !== tool.label ? <pre className="conversation-tool-input">{tool.detail.slice(0, more ? 2000 : 500)}</pre> : null}
      {!edits.length && showMore}
      </div>
    </Disclosure>
  </div>;
}
