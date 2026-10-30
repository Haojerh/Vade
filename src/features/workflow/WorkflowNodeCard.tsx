import React from 'react';
import type { Node } from '../../../shared/contracts';
import { ProviderIcon } from '../../components/providers/ProviderIcon';
import { Icon } from '../../components/ui/Icon';
import { MessageAttachments } from './MessageAttachments';

export interface NodeChatExtensionProps {
  node: Node;
  files: File[];
  status: { type: 'success' | 'error'; text: string } | null | undefined;
  isSending: boolean;
  currentMsg: string;
  onChangeFiles: (files: File[]) => void;
  onChangeMessage: (msg: string) => void;
  onSendMessage: () => void;
  onClose: () => void;
}

export const NodeChatExtension: React.FC<NodeChatExtensionProps> = ({
  node,
  files,
  status,
  isSending,
  currentMsg,
  onChangeFiles,
  onChangeMessage,
  onSendMessage,
  onClose,
}) => {
  return (
    <div
      className="node-card-chat-extension"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <MessageAttachments
        files={files}
        disabled={isSending}
        onChange={onChangeFiles}
        renderControls={(attachButton) => (
          <div className="node-card-chat-actions">
            {attachButton}
            {status?.type === 'error' && (
              <span
                className={`font-mono text-xs font-semibold ${
                  status.type === 'error' ? 'text-danger' : 'text-success'
                }`}
              >
                {status.text}
              </span>
            )}
            <div className="node-card-chat-actions-right">
              <button
                type="button"
                className="btn btn-secondary btn-xs"
                onClick={onClose}
                disabled={isSending}
              >
                Close
              </button>
              <button
                type="button"
                className="btn btn-primary btn-xs btn-chat-send"
                onClick={onSendMessage}
                disabled={isSending || (!currentMsg.trim() && !files.length)}
              >
                {isSending ? (
                  <span>Sending…</span>
                ) : (
                  <>
                    <Icon name="send" size={12} />
                    <span>Send</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      >
        <textarea
          className="node-card-chat-textarea"
          placeholder={`Message ${node.label}... (Enter to send)`}
          value={currentMsg}
          onChange={(e) => onChangeMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSendMessage();
            }
          }}
          rows={currentMsg.includes('\n') ? 5 : 2}
          disabled={isSending}
        />
      </MessageAttachments>
    </div>
  );
};

export interface WorktreeDropPreviewSlotProps {
  draggedNode: Pick<Node, 'agentType' | 'label'> | null | undefined;
  targetNode?: Pick<Node, 'label'>;
  position: 'before' | 'after';
  pending?: boolean;
}

export const WorktreeDropPreviewSlot: React.FC<WorktreeDropPreviewSlotProps> = ({
  draggedNode,
  targetNode,
  position,
  pending = false,
}) => {
  return (
    <div className="worktree-drop-preview-slot" aria-hidden="true">
      <div className="worktree-drop-preview-card">
        <div className="node-card-top">
          <div className="agent-title-row">
            <span className="drag-grip-icon" aria-hidden="true">⋮⋮</span>
            <ProviderIcon provider={draggedNode?.agentType} size={15} />
            <span className="agent-label font-semibold">{draggedNode?.label}</span>
          </div>
          <span className="node-badge-state preview-pill">
            <Icon name={position === 'before' ? 'arrow-up' : 'arrow-down'} size={10} />
            <span>{pending ? 'Resuming...' : 'Move here'}</span>
          </span>
        </div>
        <div className="preview-hint-text font-mono text-xs">
          {targetNode ? `Drop to position ${position} ${targetNode.label}` : 'Drop to resume in this worktree'}
        </div>
      </div>
    </div>
  );
};

export interface WorkflowNodeCardBodyProps {
  node: Node;
  gripTitle: string;
  iconSize: number;
  showPreviewText?: boolean;
  showStaleTag?: boolean;
  chatExtension?: React.ReactNode;
  onOpenSubagent?: (subagent: import('../../../shared/contracts').Subagent) => void;
  onSubagentPreview?: (subagent: import('../../../shared/contracts').Subagent, anchor: HTMLElement) => void;
  onSubagentPreviewLeave?: () => void;
}

/** Native child agents render as a connected stack under their parent card. */
const SubagentStack: React.FC<{
  subagents: import('../../../shared/contracts').Subagent[];
  onOpen?: (subagent: import('../../../shared/contracts').Subagent) => void;
  onPreview?: (subagent: import('../../../shared/contracts').Subagent, anchor: HTMLElement) => void;
  onPreviewLeave?: () => void;
}> = ({ subagents, onOpen, onPreview, onPreviewLeave }) => {
  if (!subagents.length) return null;
  return (
    <div className="node-subagent-stack">
      {subagents.map(subagent => (
        <button
          type="button"
          key={subagent.id}
          className="node-subagent-card"
          onPointerDown={event => event.stopPropagation()}
          onPointerEnter={event => { if (event.pointerType !== 'touch') onPreview?.(subagent, event.currentTarget); }}
          onPointerLeave={event => {
            // Moving between sibling child cards keeps the same preview host.
            if (!(event.relatedTarget instanceof Element) || !event.relatedTarget.closest('.node-subagent-card')) onPreviewLeave?.();
          }}
          onFocus={event => onPreview?.(subagent, event.currentTarget)}
          onBlur={onPreviewLeave}
          onClick={event => { event.stopPropagation(); onOpen?.(subagent); }}
          onKeyDown={event => event.stopPropagation()}
          title={subagent.role ?? subagent.label}
        >
          <span className={`subagent-dot state-${subagent.state}`} aria-hidden="true" />
          <span className="node-subagent-label">{subagent.label}</span>
          <span className="node-subagent-state font-mono text-xs">{subagent.state}</span>
        </button>
      ))}
    </div>
  );
};

export const WorkflowNodeCardBody: React.FC<WorkflowNodeCardBodyProps> = ({
  node,
  gripTitle,
  iconSize,
  showPreviewText = true,
  showStaleTag = false,
  chatExtension,
  onOpenSubagent,
  onSubagentPreview,
  onSubagentPreviewLeave,
}) => {
  return (
    <>
      <div className="node-card-top">
        <div className="agent-title-row">
          <span className="drag-grip-icon" title={gripTitle} aria-hidden="true">⋮⋮</span>
          <ProviderIcon provider={node.agentType} liveness={node.liveness} size={iconSize} />
          <span className="agent-label font-semibold">{node.label}</span>
          {node.workflow && <span className="node-effort-badge" title={`Workflow ${node.workflow.runId}${node.workflow.stepState ? ` · task ${node.workflow.stepState}` : ''}`}>{node.workflow.role === 'orchestrator' ? 'Orchestrator' : 'Workflow'}</span>}
        </div>
        {node.kind !== 'terminal' && <span className={`node-badge-state state-${node.state}`} title={node.agentStatus?.meta.issue?.message ?? (node.agentStatus?.data ? `Observed ${node.agentStatus.data.event}` : undefined)}>
          {node.state === 'waiting' && node.agentStatus?.data?.attention === 'question' ? 'Question' : node.state === 'waiting' && node.agentStatus?.data?.attention === 'approval' ? 'Approval' : node.state}
        </span>}
      </div>

      {showPreviewText && node.preview && (
        <div className="node-card-preview font-mono text-xs text-muted">
          {node.preview}
        </div>
      )}

      <div className="node-card-footer">
        <div className="node-footer-left">
          <span
            className={`badge-liveness-dot dot-${node.liveness}`}
            title={`Liveness: ${node.liveness}`}
          />
          <span className="node-footer-meta font-mono text-xs">
            {node.taskIds.length > 0 ? `${node.taskIds.length} tasks` : node.liveness}
          </span>
          {showStaleTag && node.stale && <span className="badge-stale-tag">Stale</span>}
        </div>
        {((node.model && node.model !== 'unknown') || (node.effort && node.effort !== 'unknown')) && (
          <div
            className="node-footer-right"
            title={`${node.model && node.model !== 'unknown' ? node.model : 'Model unavailable'}${node.effort && node.effort !== 'unknown' ? ` • effort: ${node.effort}` : ''}`}
          >
            {node.model && node.model !== 'unknown' && (
              <span className="node-model-name font-mono text-xs">
                {node.model}
              </span>
            )}
            {node.effort && node.effort !== 'unknown' && (
              <span className="node-effort-badge font-mono text-xs">
                {node.effort}
              </span>
            )}
          </div>
        )}
      </div>

      {chatExtension}
      <SubagentStack subagents={node.subagents?.data ?? []} onOpen={onOpenSubagent} onPreview={onSubagentPreview} onPreviewLeave={onSubagentPreviewLeave} />
    </>
  );
};
