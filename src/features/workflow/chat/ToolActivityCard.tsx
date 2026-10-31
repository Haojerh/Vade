import React, { useRef } from 'react';
import type { AnchorBox } from '../canvas/WorkflowEdgesSvg';
import type { LiveTool } from '../../../hooks/workflow/useLiveGraphActivity';
import { Icon } from '../../../components/ui/Icon';
import { Popover } from '../../../components/ui/Popover';
import { usePopoverState } from '../../../hooks/ui/usePopoverState';
import type { ToolEditPreview } from '../../../../shared/contracts';

export function ToolEditDiff({ edits, hideCaption }: {
  edits: (ToolEditPreview & { totalAdded?: number; totalRemoved?: number })[];
  hideCaption?: boolean;
}) {
  return <div className="tool-edit-diffs">
    {edits.map((edit, index) => {
      const added = edit.totalAdded ?? edit.lines.filter(l => l.kind === 'add').length;
      const removed = edit.totalRemoved ?? edit.lines.filter(l => l.kind === 'remove').length;
      const displayPath = edit.path.replace(/\\/g, '/');
      return <div className="tool-edit-file" key={`${edit.path}:${index}`}>
        <div className="tool-edit-header">
          <span className="tool-edit-path" title={edit.path}>{displayPath}</span>
          {(added > 0 || removed > 0) && <span className="tool-edit-stats">
            {added > 0 && <span className="tool-edit-stat-add">+{added}</span>}
            {removed > 0 && <span className="tool-edit-stat-remove">-{removed}</span>}
          </span>}
        </div>
        {edit.location && <div className="tool-edit-location">{edit.location}</div>}
        <pre className="tool-edit-code" aria-label={`Edit preview for ${edit.path}`}>
          {edit.lines.map((line, row) => <span key={row} className={`tool-edit-line tool-edit-${line.kind}`}>
            <code>{line.text || ' '}</code>
          </span>)}
        </pre>
        {!hideCaption && edit.truncated && <div className="tool-edit-caption">Show more</div>}
      </div>;
    })}
  </div>;
}

export function ToolActivityCard({ tool, box, onHold }: { tool: LiveTool; box: AnchorBox; onHold?: (id: string, held: boolean) => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const preview = usePopoverState();
  const close = () => { preview.close(); onHold?.(tool.id, false); };
  const open = () => { if (!preview.present || preview.closing) preview.toggle(); onHold?.(tool.id, true); };
  const leave = (event: React.MouseEvent | React.FocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof globalThis.Node && (trigger.current?.contains(next) || content.current?.contains(next))) return;
    close();
  };
  const separator = tool.label.indexOf(': ');
  const action = separator < 0 ? tool.label : tool.label.slice(0, separator);
  const detail = separator < 0 ? 'Tool call' : tool.label.slice(separator + 2);
  return <>
    <button ref={trigger} type="button" className="tool-activity-node" style={{ left: box.x, top: box.y }} aria-label={tool.label} aria-expanded={preview.present}
      onMouseEnter={open} onMouseLeave={leave} onFocus={open} onBlur={leave} onClick={open} onPointerDown={(event) => event.stopPropagation()}>
      <span className="tool-activity-icon"><Icon name={action === 'Edit' ? 'edit' : action === 'Read' ? 'folder' : 'terminal'} size={14} /></span>
      <span className="tool-activity-text"><span className="tool-activity-action">{action}</span><span className="tool-activity-detail">{detail}</span></span>
    </button>
    <Popover isOpen={preview.present} isClosing={preview.closing} onClose={close} triggerRef={trigger} contentRef={content}
      floating portal className="tool-activity-preview" onMouseEnter={() => onHold?.(tool.id, true)} onMouseLeave={leave} onBlur={leave}
      aria-label="Tool call details">
      <div className="tool-activity-preview-heading">{action}</div>
      {tool.edits?.length ? <ToolEditDiff edits={tool.edits} /> : <pre>{tool.detail ?? tool.label}</pre>}
      {tool.at && <time dateTime={tool.at}>{new Date(tool.at).toLocaleString()}</time>}
    </Popover>
  </>;
}
