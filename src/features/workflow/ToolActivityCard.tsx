import React, { useRef } from 'react';
import type { AnchorBox } from './WorkflowEdgesSvg';
import type { LiveTool } from './useLiveGraphActivity';
import { Icon } from '../../components/ui/Icon';
import { Popover } from '../../components/ui/Popover';
import { usePopoverState } from '../../hooks/usePopoverState';

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
      <pre>{tool.detail ?? tool.label}</pre>
      {tool.at && <time dateTime={tool.at}>{new Date(tool.at).toLocaleString()}</time>}
    </Popover>
  </>;
}
