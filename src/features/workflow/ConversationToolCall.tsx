import { useState } from 'react';
import type { ToolActivity, ToolEditPreview } from '../../../shared/contracts';
import { Disclosure } from '../../components/ui/Disclosure';
import { ToolEditDiff } from './ToolActivityCard';

export function compactEditLines(lines: ToolEditPreview['lines']) {
  if (lines.length <= 6 || !lines.some(line => line.kind === 'add') || !lines.some(line => line.kind === 'remove')) return lines.slice(0, 6);
  let added = 0, removed = 0;
  return lines.filter(line => line.kind === 'add' ? added++ < 3 : line.kind === 'remove' ? removed++ < 3 : false);
}

export function ConversationToolCall({ tool }: { tool: ToolActivity }) {
  const [more, setMore] = useState(false);
  const edit = tool.label.startsWith('Edit');
  const edits = tool.edits ?? [];
  const expandable = edits.some(edit => edit.lines.length > 6) || (tool.detail?.length ?? 0) > 500;
  const body = edits.length || (tool.detail && tool.detail !== tool.label);
  if (!body) return <div className="conversation-tool-call conversation-tool-call-plain" data-tool-id={tool.id}><span className="conversation-tool-summary">{tool.label}</span></div>;
  return <div className="conversation-tool-call" data-tool-id={tool.id}>
    <Disclosure title={tool.label} compact defaultOpen={edit}>
      {edits.length ? <ToolEditDiff edits={edits.map(edit => ({ ...edit, lines: more ? edit.lines : compactEditLines(edit.lines) }))} />
        : <pre className="conversation-tool-input">{(tool.detail ?? '').slice(0, more ? 2000 : 500)}</pre>}
      {expandable && <button type="button" className="btn-read-more" aria-expanded={more} onClick={() => setMore(value => !value)}>{more ? 'Show less' : 'Show more'}</button>}
    </Disclosure>
  </div>;
}
