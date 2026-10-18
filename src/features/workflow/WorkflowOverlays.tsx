import React, { useState, useEffect, useCallback } from 'react';
import type { Node, Project } from '../../../shared/contracts';
import {
  deleteWorktree,
  closeAgentTab,
  renameNodeTitle,
  createWorktreeAgent,
  renameWorktree,
} from '../../api/client';
import { useConfirmationState } from '../../hooks/useConfirmationState';
import { ContextMenu } from '../../components/ui/ContextMenu';
import { ConfirmationDialog } from '../../components/ui/ConfirmationDialog';
import { RenameDialog } from '../../components/ui/RenameDialog';
import { AddAgentDialog } from '../../components/ui/AddAgentDialog';
import { AddWorktreeDialog } from './AddWorktreeDialog';

export interface UseWorkflowOverlaysOptions {
  projectId: string | null;
  project?: Project | null;
  onSelectNode: (id: string) => void;
  onOpenChat: (nodeId: string) => void;
  onResetLayout: () => void;
  onRefresh?: () => void;
  scheduleUpdate: () => void;
}

export function useWorkflowOverlays({
  projectId,
  project,
  onSelectNode,
  onOpenChat,
  onResetLayout,
  onRefresh,
  scheduleUpdate,
}: UseWorkflowOverlaysOptions) {
  const resetConfirmation = useConfirmationState();
  const addWorktreeConfirmation = useConfirmationState();
  const deleteWorktreeConfirmation = useConfirmationState<Node>();
  const closeAgentTabConfirmation = useConfirmationState<Node>();
  const renameConfirmation = useConfirmationState<Node>();
  const addAgentConfirmation = useConfirmationState<Node>();

  const [worktreeContextMenu, setWorktreeContextMenu] = useState<{ x: number; y: number; worktree: Node } | null>(null);
  const [nodeContextMenu, setNodeContextMenu] = useState<{ x: number; y: number; node: Node } | null>(null);
  const [canvasMenu, setCanvasMenu] = useState<{ x: number; y: number } | null>(null);

  const [isDeletingWorktree, setIsDeletingWorktree] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [isClosingAgentTab, setIsClosingAgentTab] = useState(false);
  const [closeTabError, setCloseTabError] = useState<string | null>(null);

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [isCreatingAgent, setIsCreatingAgent] = useState(false);
  const [createAgentError, setCreateAgentError] = useState<string | null>(null);

  const canAddWorktree = project?.kind === 'git' && project.repoIds.length === 1;

  useEffect(() => {
    setCanvasMenu(null);
    addWorktreeConfirmation.reset();
    renameConfirmation.reset();
  }, [projectId]);

  const handleConfirmDeleteWorktree = useCallback(async () => {
    const wt = deleteWorktreeConfirmation.data;
    if (!projectId || !wt) return;
    setIsDeletingWorktree(true);
    setDeleteError(null);
    try {
      await deleteWorktree(projectId, wt.id);
      deleteWorktreeConfirmation.close();
      scheduleUpdate();
    } catch (err: any) {
      setDeleteError(err.message || 'Failed to delete worktree');
    } finally {
      setIsDeletingWorktree(false);
    }
  }, [projectId, deleteWorktreeConfirmation, scheduleUpdate]);

  const handleConfirmCloseAgentTab = useCallback(async () => {
    const node = closeAgentTabConfirmation.data;
    if (!projectId || !node) return;
    setIsClosingAgentTab(true);
    setCloseTabError(null);
    try {
      await closeAgentTab(projectId, node.id);
      closeAgentTabConfirmation.close();
      scheduleUpdate();
    } catch (err: any) {
      setCloseTabError(err.message || 'Failed to close agent tab');
    } finally {
      setIsClosingAgentTab(false);
    }
  }, [projectId, closeAgentTabConfirmation, scheduleUpdate]);

  const handleConfirmRename = useCallback(
    async (newTitle: string) => {
      const node = renameConfirmation.data;
      if (!projectId || !node) return;
      setIsRenaming(true);
      setRenameError(null);
      try {
        await (node.kind === 'worktree' ? renameWorktree : renameNodeTitle)(projectId, node.id, newTitle);
        renameConfirmation.close();
        onRefresh?.();
        scheduleUpdate();
      } catch (err: any) {
        setRenameError(err.message || 'Failed to rename tab title');
      } finally {
        setIsRenaming(false);
      }
    },
    [projectId, renameConfirmation, onRefresh, scheduleUpdate]
  );

  const handleConfirmCreateAgent = useCallback(
    async (command: string, title?: string) => {
      const wt = addAgentConfirmation.data;
      if (!projectId || !wt) return;
      setIsCreatingAgent(true);
      setCreateAgentError(null);
      try {
        await createWorktreeAgent(projectId, wt.id, command, title);
        addAgentConfirmation.close();
        scheduleUpdate();
      } catch (err: any) {
        setCreateAgentError(err.message || 'Failed to create agent');
      } finally {
        setIsCreatingAgent(false);
      }
    },
    [projectId, addAgentConfirmation, scheduleUpdate]
  );

  return {
    canAddWorktree,
    resetConfirmation,
    addWorktreeConfirmation,
    deleteWorktreeConfirmation,
    closeAgentTabConfirmation,
    renameConfirmation,
    addAgentConfirmation,
    worktreeContextMenu,
    setWorktreeContextMenu,
    nodeContextMenu,
    setNodeContextMenu,
    canvasMenu,
    setCanvasMenu,
    isDeletingWorktree,
    deleteError,
    setDeleteError,
    isClosingAgentTab,
    closeTabError,
    setCloseTabError,
    isRenaming,
    renameError,
    setRenameError,
    isCreatingAgent,
    createAgentError,
    setCreateAgentError,
    handleConfirmDeleteWorktree,
    handleConfirmCloseAgentTab,
    handleConfirmRename,
    handleConfirmCreateAgent,
    onSelectNode,
    onOpenChat,
    onResetLayout,
    onRefresh,
    project,
  };
}

export const WorkflowOverlays: React.FC<{ overlays: ReturnType<typeof useWorkflowOverlays> }> = ({
  overlays,
}) => {
  const {
    canAddWorktree,
    resetConfirmation,
    addWorktreeConfirmation,
    deleteWorktreeConfirmation,
    closeAgentTabConfirmation,
    renameConfirmation,
    addAgentConfirmation,
    worktreeContextMenu,
    setWorktreeContextMenu,
    nodeContextMenu,
    setNodeContextMenu,
    canvasMenu,
    setCanvasMenu,
    isDeletingWorktree,
    deleteError,
    setDeleteError,
    isClosingAgentTab,
    closeTabError,
    setCloseTabError,
    isRenaming,
    renameError,
    setRenameError,
    isCreatingAgent,
    createAgentError,
    setCreateAgentError,
    handleConfirmDeleteWorktree,
    handleConfirmCloseAgentTab,
    handleConfirmRename,
    handleConfirmCreateAgent,
    onSelectNode,
    onOpenChat,
    onResetLayout,
    onRefresh,
    project,
  } = overlays;

  return (
    <>
      {addWorktreeConfirmation.present && project && (
        <AddWorktreeDialog
          key={project.id}
          project={project}
          isClosing={addWorktreeConfirmation.closing}
          onClose={addWorktreeConfirmation.close}
          onCreated={() => onRefresh?.()}
        />
      )}
      {canvasMenu && (
        <ContextMenu
          position={canvasMenu}
          label="Topology actions"
          onClose={() => setCanvasMenu(null)}
          actions={[
            {
              label: 'Add Worktree',
              icon: 'plus',
              disabled: !canAddWorktree,
              onSelect: () => addWorktreeConfirmation.open(),
            },
          ]}
        />
      )}
      <ConfirmationDialog
        isOpen={resetConfirmation.present}
        isClosing={resetConfirmation.closing}
        title="Reset layout?"
        description="Return cards and worktrees in this project to their default positions. Your saved layout will be cleared."
        confirmLabel="Reset layout"
        confirmVariant="danger"
        onConfirm={() => {
          onResetLayout();
          resetConfirmation.close();
        }}
        onClose={resetConfirmation.close}
      />

      <ConfirmationDialog
        isOpen={deleteWorktreeConfirmation.present}
        isClosing={deleteWorktreeConfirmation.closing}
        title="Delete Worktree?"
        description={
          <>
            Are you sure you want to delete worktree <strong>{deleteWorktreeConfirmation.data?.label}</strong>? This
            will remove the worktree from Orca and git.
          </>
        }
        confirmLabel="Delete Worktree"
        confirmVariant="danger"
        isConfirming={isDeletingWorktree}
        error={deleteError}
        onConfirm={handleConfirmDeleteWorktree}
        onClose={() => {
          deleteWorktreeConfirmation.close();
          setDeleteError(null);
        }}
      />

      <ConfirmationDialog
        isOpen={closeAgentTabConfirmation.present}
        isClosing={closeAgentTabConfirmation.closing}
        title="Close Agent Tab?"
        description={
          <>
            Are you sure you want to close the terminal tab for agent{' '}
            <strong>{closeAgentTabConfirmation.data?.label}</strong>? This will terminate the running session.
          </>
        }
        confirmLabel="Close Tab"
        confirmVariant="danger"
        isConfirming={isClosingAgentTab}
        error={closeTabError}
        onConfirm={handleConfirmCloseAgentTab}
        onClose={() => {
          closeAgentTabConfirmation.close();
          setCloseTabError(null);
        }}
      />

      <RenameDialog
        subject={renameConfirmation.data?.kind === 'worktree' ? 'worktree' : 'tab'}
        isOpen={renameConfirmation.present}
        isClosing={renameConfirmation.closing}
        initialTitle={renameConfirmation.data?.label || ''}
        isRenaming={isRenaming}
        error={renameError}
        onRename={handleConfirmRename}
        onClose={() => {
          renameConfirmation.close();
          setRenameError(null);
        }}
      />

      <AddAgentDialog
        isOpen={addAgentConfirmation.present}
        isClosing={addAgentConfirmation.closing}
        worktreeName={addAgentConfirmation.data?.label || ''}
        isCreating={isCreatingAgent}
        error={createAgentError}
        onCreate={handleConfirmCreateAgent}
        onClose={() => {
          addAgentConfirmation.close();
          setCreateAgentError(null);
        }}
      />

      {worktreeContextMenu && (
        <ContextMenu
          position={worktreeContextMenu}
          label="Worktree actions"
          onClose={() => setWorktreeContextMenu(null)}
          actions={[
            {
              label: 'Add New Agent',
              icon: 'plus',
              onSelect: () => addAgentConfirmation.open(worktreeContextMenu.worktree),
            },
            {
              label: 'Inspect Worktree',
              icon: 'search',
              onSelect: () => onSelectNode(worktreeContextMenu.worktree.id),
            },
            {
              label: 'Delete Worktree',
              icon: 'trash',
              danger: true,
              onSelect: () => deleteWorktreeConfirmation.open(worktreeContextMenu.worktree),
            },
          ]}
        />
      )}
      {nodeContextMenu && (
        <ContextMenu
          position={nodeContextMenu}
          label="Agent actions"
          onClose={() => setNodeContextMenu(null)}
          actions={[
            {
              label: 'Send Message',
              icon: 'message-square',
              onSelect: () => onOpenChat(nodeContextMenu.node.id),
            },
            {
              label: 'Rename Title',
              icon: 'edit',
              onSelect: () => renameConfirmation.open(nodeContextMenu.node),
            },
            {
              label: 'Close Agent Tabs',
              icon: 'trash',
              danger: true,
              onSelect: () => closeAgentTabConfirmation.open(nodeContextMenu.node),
            },
          ]}
        />
      )}
    </>
  );
};
