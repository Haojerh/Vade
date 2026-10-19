import React, { useRef, useState, useEffect, useCallback, useId, useLayoutEffect } from 'react';
import type { Node, NodeDetails as NodeDetailsType, Task } from '../../../shared/contracts';
import { ProviderIcon } from '../../components/providers/ProviderIcon';
import { Icon } from '../../components/ui/Icon';
import { RefreshIcon } from '../../components/ui/RefreshIcon';
import { MessageMarkdown } from './MessageMarkdown';
import {
  deleteWorktree,
  closeAgentTab,
  renameNodeTitle,
  renameWorktree,
  createWorktreeAgent,
} from '../../api/client';
import { ConfirmationDialog } from '../../components/ui/ConfirmationDialog';
import { RenameDialog } from '../../components/ui/RenameDialog';
import { AddAgentDialog } from '../../components/ui/AddAgentDialog';
import { useConfirmationState } from '../../hooks/useConfirmationState';

export function TaskCard({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => setOverflowing(body.scrollHeight > 180);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [task.spec, task.result]);

  return (
    <div className="latest-message-card assigned-task-card mb-3">
      <div className="assigned-task-header flex justify-between items-center mb-2">
        <span className="font-semibold text-sm">{task.title}</span>
        <div className="flex items-center gap-1">
          <span className={`node-badge-state state-${task.state}`}>{task.state}</span>
          {task.rawStatus && task.rawStatus !== task.state && (
            <span className="text-xs text-muted font-mono">({task.rawStatus})</span>
          )}
        </div>
      </div>
      <div ref={bodyRef} id={bodyId} className={`message-markdown ${expanded ? 'message-expanded' : 'message-collapsed'}`}>
        <MessageMarkdown text={task.spec || task.title} />
        {task.result && (
          <div className="task-result-callout mt-2 p-2 rounded text-xs font-mono">
            <strong>Result:</strong> {task.result}
          </div>
        )}
      </div>
      <div className="latest-message-footer mt-2">
        {task.createdAt ? (
          <time dateTime={task.createdAt}>
            Created: {new Date(task.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </time>
        ) : (
          <span>Time unavailable</span>
        )}
        {task.completedAt && (
          <time dateTime={task.completedAt} className="ml-2 text-muted">
            Completed: {new Date(task.completedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </time>
        )}
        {overflowing && (
          <button
            type="button"
            className="btn btn-secondary btn-xs ml-auto"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Show less' : 'Read more'}
          </button>
        )}
      </div>
    </div>
  );
}

export interface UseNodeDetailsActionsOptions {
  projectId: string | null;
  selectedNodeId: string | null;
  details: NodeDetailsType | null;
  handleClose: () => void;
  onRefresh: () => void;
}

export function useNodeDetailsActions({
  projectId,
  selectedNodeId,
  details,
  handleClose,
  onRefresh,
}: UseNodeDetailsActionsOptions) {
  const deleteWorktreeConfirmation = useConfirmationState();
  const closeAgentTabConfirmation = useConfirmationState();
  const renameConfirmation = useConfirmationState();
  const addAgentConfirmation = useConfirmationState();
  const [isDeletingWorktree, setIsDeletingWorktree] = useState<boolean>(false);
  const [isClosingAgentTab, setIsClosingAgentTab] = useState<boolean>(false);
  const [isRenaming, setIsRenaming] = useState<boolean>(false);
  const [isCreatingAgent, setIsCreatingAgent] = useState<boolean>(false);
  const [deleteWorktreeError, setDeleteWorktreeError] = useState<string | null>(null);
  const [closeTabError, setCloseTabError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [createAgentError, setCreateAgentError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  useEffect(() => {
    deleteWorktreeConfirmation.reset();
    closeAgentTabConfirmation.reset();
    renameConfirmation.reset();
    addAgentConfirmation.reset();
    setDeleteWorktreeError(null);
    setCloseTabError(null);
    setRenameError(null);
    setCreateAgentError(null);
    setActionSuccess(null);
  }, [projectId, selectedNodeId]);

  const handleDeleteWorktree = useCallback(async () => {
    if (!projectId || !details?.node || isDeletingWorktree) return;
    setIsDeletingWorktree(true);
    setDeleteWorktreeError(null);
    try {
      await deleteWorktree(projectId, details.node.id);
      deleteWorktreeConfirmation.close();
      handleClose();
      onRefresh();
    } catch (err: any) {
      setDeleteWorktreeError(err?.message || 'Failed to delete worktree');
    } finally {
      setIsDeletingWorktree(false);
    }
  }, [projectId, details?.node, isDeletingWorktree, deleteWorktreeConfirmation, handleClose, onRefresh]);

  const handleCloseAgentTab = useCallback(async () => {
    if (!projectId || !details?.node || isClosingAgentTab) return;
    setIsClosingAgentTab(true);
    setCloseTabError(null);
    try {
      await closeAgentTab(projectId, details.node.id);
      closeAgentTabConfirmation.close();
      setActionSuccess('Agent tab closed');
      setTimeout(() => setActionSuccess(null), 3000);
      onRefresh();
    } catch (err: any) {
      setCloseTabError(err?.message || 'Failed to close agent tab');
    } finally {
      setIsClosingAgentTab(false);
    }
  }, [projectId, details?.node, isClosingAgentTab, closeAgentTabConfirmation, onRefresh]);

  const handleRenameTitle = useCallback(
    async (newTitle: string) => {
      if (!projectId || !details?.node || isRenaming) return;
      setIsRenaming(true);
      setRenameError(null);
      try {
        await (details.node.kind === 'worktree' ? renameWorktree : renameNodeTitle)(
          projectId,
          details.node.id,
          newTitle
        );
        renameConfirmation.close();
        setActionSuccess(
          details.node.kind === 'worktree' ? 'Worktree renamed successfully' : 'Tab title renamed successfully'
        );
        setTimeout(() => setActionSuccess(null), 3000);
        onRefresh();
      } catch (err: any) {
        setRenameError(err?.message || 'Failed to rename tab title');
      } finally {
        setIsRenaming(false);
      }
    },
    [projectId, details?.node, isRenaming, renameConfirmation, onRefresh]
  );

  const handleCreateAgent = useCallback(
    async (command: string, title?: string) => {
      if (!projectId || !details?.node || isCreatingAgent) return;
      setIsCreatingAgent(true);
      setCreateAgentError(null);
      try {
        await createWorktreeAgent(projectId, details.node.id, command, title);
        addAgentConfirmation.close();
        setActionSuccess('New agent created successfully');
        setTimeout(() => setActionSuccess(null), 3000);
        onRefresh();
      } catch (err: any) {
        setCreateAgentError(err?.message || 'Failed to create agent');
      } finally {
        setIsCreatingAgent(false);
      }
    },
    [projectId, details?.node, isCreatingAgent, addAgentConfirmation, onRefresh]
  );

  return {
    deleteWorktreeConfirmation,
    closeAgentTabConfirmation,
    renameConfirmation,
    addAgentConfirmation,
    isDeletingWorktree,
    isClosingAgentTab,
    isRenaming,
    isCreatingAgent,
    deleteWorktreeError,
    setDeleteWorktreeError,
    closeTabError,
    setCloseTabError,
    renameError,
    setRenameError,
    createAgentError,
    setCreateAgentError,
    actionSuccess,
    handleDeleteWorktree,
    handleCloseAgentTab,
    handleRenameTitle,
    handleCreateAgent,
  };
}

export interface NodeDetailsHeaderProps {
  node: Node | null;
  selectedNodeId: string;
  isWorktree: boolean;
  loading: boolean;
  actions: ReturnType<typeof useNodeDetailsActions>;
  onRefresh: () => void;
  onClose: () => void;
}

export const NodeDetailsHeader: React.FC<NodeDetailsHeaderProps> = ({
  node,
  selectedNodeId,
  isWorktree,
  loading,
  actions,
  onRefresh,
  onClose,
}) => {
  return (
    <header className="modal-dialog-header">
      <div className="modal-identity-hero">
        {node?.agentType && (
          <div className="modal-provider-avatar" title={`Provider: ${node.agentType}`}>
            <ProviderIcon provider={node.agentType} size={30} />
          </div>
        )}
        <div className="modal-identity-info">
          <div className="modal-name-status-row">
            <h2 id="dialog-node-title" className="modal-node-title">
              {node ? node.label : `Node: ${selectedNodeId}`}
            </h2>
            {node && (
              <button
                type="button"
                className="btn-icon btn-rename-node"
                onClick={() => {
                  actions.setRenameError(null);
                  actions.renameConfirmation.open();
                }}
                aria-label={isWorktree ? 'Rename worktree' : 'Rename tab title'}
                title={isWorktree ? 'Rename worktree' : 'Rename tab title'}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '4px',
                  borderRadius: '4px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon name="edit" size={14} />
              </button>
            )}
            {node && (
              <div className="modal-status-group">
                <span className={`node-badge-state state-${node.state}`}>
                  {node.state}
                </span>
                <div className="modal-liveness-tag" title={`Liveness: ${node.liveness}`}>
                  <span className={`badge-liveness-dot dot-${node.liveness}`} />
                  <span className="font-mono text-xs">{node.liveness}</span>
                </div>
                {node.stale && <span className="badge-stale-tag">Stale</span>}
              </div>
            )}
          </div>

          <div className="modal-meta-row text-xs text-muted">
            <span className="modal-kind-tag uppercase font-semibold text-xs">{node?.kind}</span>
            {node?.agentType && (
              <>
                <span className="meta-bullet">•</span>
                <span className="capitalize">{node.agentType}</span>
              </>
            )}
            {node?.model && node.model !== 'unknown' && (
              <>
                <span className="meta-bullet">•</span>
                <span className="font-mono">{node.model}</span>
                {node.effort && node.effort !== 'unknown' && (
                  <span className="node-effort-badge ml-1">{node.effort}</span>
                )}
              </>
            )}
          </div>

          <div id="dialog-node-desc" className="modal-node-id font-mono text-xs text-dim">
            ID: {selectedNodeId}
          </div>
        </div>
      </div>

      <div className="modal-header-actions">
        {node &&
          (isWorktree ? (
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                type="button"
                className="btn btn-secondary btn-xs btn-add-agent"
                onClick={() => {
                  actions.setCreateAgentError(null);
                  actions.addAgentConfirmation.open();
                }}
                disabled={actions.isCreatingAgent}
                aria-label="Add new agent"
                title="Add new agent to this worktree"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <Icon name="plus" size={12} />
                <span>Add Agent</span>
              </button>
              <button
                type="button"
                className="btn btn-danger btn-xs btn-delete-worktree"
                onClick={() => {
                  actions.setDeleteWorktreeError(null);
                  actions.deleteWorktreeConfirmation.open();
                }}
                disabled={actions.isDeletingWorktree}
                aria-label="Delete worktree"
                title="Delete this worktree from Orca and git"
              >
                <Icon name="trash" size={12} />
                <span>Delete Worktree</span>
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-danger btn-xs btn-close-tab"
              onClick={() => {
                actions.setCloseTabError(null);
                actions.closeAgentTabConfirmation.open();
              }}
              disabled={actions.isClosingAgentTab}
              aria-label="Close agent tab"
              title="Close agent terminal tab in Orca"
            >
              <Icon name="x-square" size={12} />
              <span>Close Agent Tab</span>
            </button>
          ))}
        <button
          type="button"
          className="btn-icon"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh node facts"
          title="Refresh node facts"
        >
          <RefreshIcon busy={loading} />
        </button>
        <button
          type="button"
          className="btn-close"
          onClick={onClose}
          aria-label="Close dialog"
          title="Close dialog"
        >
          ✕
        </button>
      </div>
    </header>
  );
};

export const NodeDetailsActionDialogs: React.FC<{
  node: Node | null;
  detailsNodeLabel: string;
  isWorktree: boolean;
  actions: ReturnType<typeof useNodeDetailsActions>;
}> = ({ node, detailsNodeLabel, isWorktree, actions }) => {
  return (
    <>
      <ConfirmationDialog
        isOpen={actions.deleteWorktreeConfirmation.present}
        isClosing={actions.deleteWorktreeConfirmation.closing}
        title="Delete Worktree?"
        description={
          <>
            Are you sure you want to delete worktree <strong>{node?.label}</strong>? This will remove the worktree
            from Orca and git.
          </>
        }
        confirmLabel="Delete Worktree"
        confirmVariant="danger"
        isConfirming={actions.isDeletingWorktree}
        error={actions.deleteWorktreeError}
        onConfirm={actions.handleDeleteWorktree}
        onClose={() => {
          actions.deleteWorktreeConfirmation.close();
          actions.setDeleteWorktreeError(null);
        }}
      />

      <ConfirmationDialog
        isOpen={actions.closeAgentTabConfirmation.present}
        isClosing={actions.closeAgentTabConfirmation.closing}
        title="Close Agent Tab?"
        description={
          <>
            Are you sure you want to close the terminal tab for <strong>{node?.label}</strong>? The agent process
            will be terminated.
          </>
        }
        confirmLabel="Close Tab"
        confirmVariant="danger"
        isConfirming={actions.isClosingAgentTab}
        error={actions.closeTabError}
        onConfirm={actions.handleCloseAgentTab}
        onClose={() => {
          actions.closeAgentTabConfirmation.close();
          actions.setCloseTabError(null);
        }}
      />

      <RenameDialog
        subject={isWorktree ? 'worktree' : 'tab'}
        isOpen={actions.renameConfirmation.present}
        isClosing={actions.renameConfirmation.closing}
        initialTitle={detailsNodeLabel}
        isRenaming={actions.isRenaming}
        error={actions.renameError}
        onRename={actions.handleRenameTitle}
        onClose={() => {
          actions.renameConfirmation.close();
          actions.setRenameError(null);
        }}
      />

      <AddAgentDialog
        isOpen={actions.addAgentConfirmation.present}
        isClosing={actions.addAgentConfirmation.closing}
        worktreeName={detailsNodeLabel}
        isCreating={actions.isCreatingAgent}
        error={actions.createAgentError}
        onCreate={actions.handleCreateAgent}
        onClose={() => {
          actions.addAgentConfirmation.close();
          actions.setCreateAgentError(null);
        }}
      />
    </>
  );
};
