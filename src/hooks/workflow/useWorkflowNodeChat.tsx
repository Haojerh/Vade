import React, { useState, useEffect, useCallback } from 'react';
import type { Node } from '../../../shared/contracts';
import { sendNodeMessage } from '../../api/client';
import { validateMessageFiles } from '../../features/workflow/chat/MessageAttachments';
import { NodeChatExtension } from '../../features/workflow/canvas/WorkflowNodeCard';
import { buildCardPrompt, KANBAN_DRAG_TYPE, type KanbanCard } from '../../features/kanban/kanban';
import { buildGitHubPrompt, type DraggedGitHubItem } from '../../features/workflow/canvas/githubDragPrompt';

interface UseWorkflowNodeChatOptions {
  projectId: string | null;
  nodes: Node[];
  onSelectNode: (id: string) => void;
  closePreview: () => void;
  setDraggingMember: (val: { worktreeId: string; agentId: string } | null) => void;
  setDropTargetMember: (val: { worktreeId: string; agentId: string; position: 'before' | 'after' } | null) => void;
  onDropKanbanCard?: (cardId: string, node: Node) => KanbanCard | undefined;
  onSendKanbanCard?: (cardId: string, node: Node, message: string, files: File[]) => Promise<{ ok: boolean; message?: string }>;
}

export function useWorkflowNodeChat({
  projectId,
  nodes,
  onSelectNode,
  closePreview,
  setDraggingMember,
  setDropTargetMember,
  onDropKanbanCard,
  onSendKanbanCard,
}: UseWorkflowNodeChatOptions) {
  const [isDraggingGitHubItem, setIsDraggingGitHubItem] = useState(false);
  const [draggedItem, setDraggedItem] = useState<DraggedGitHubItem | null>(null);
  const [dropHoverNodeId, setDropHoverNodeId] = useState<string | null>(null);
  const [chatOpenNodeId, setChatOpenNodeId] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<Record<string, string>>({});
  const [chatFiles, setChatFiles] = useState<Record<string, File[]>>({});
  const [chatKanbanIds, setChatKanbanIds] = useState<Record<string, string | undefined>>({});
  useEffect(() => {
    setChatFiles({});
    setChatKanbanIds({});
  }, [projectId]);
  const [chatSending, setChatSending] = useState<Record<string, boolean>>({});
  const [chatStatuses, setChatStatuses] = useState<Record<string, { type: 'success' | 'error'; text: string } | null>>(
    {}
  );

  useEffect(() => {
    const onDragStart = (e: Event) => {
      const customEvent = e as CustomEvent<DraggedGitHubItem>;
      setIsDraggingGitHubItem(true);
      if (customEvent.detail) {
        setDraggedItem(customEvent.detail);
      }
    };
    const onDragEnd = () => {
      setIsDraggingGitHubItem(false);
      setDraggedItem(null);
      setDropHoverNodeId(null);

      setDraggingMember(null);
      setDropTargetMember(null);
    };

    window.addEventListener('orca:drag-github-item-start', onDragStart);
    window.addEventListener('orca:drag-github-item-end', onDragEnd);
    window.addEventListener('dragend', onDragEnd);
    return () => {
      window.removeEventListener('orca:drag-github-item-start', onDragStart);
      window.removeEventListener('orca:drag-github-item-end', onDragEnd);
      window.removeEventListener('dragend', onDragEnd);
    };
  }, [setDraggingMember, setDropTargetMember]);

  const closeChat = useCallback((nodeId: string) => {
    setChatOpenNodeId((curr) => (curr === nodeId ? null : curr));
  }, []);

  const handleSendChatMessage = useCallback(
    async (nodeId: string) => {
      if (!projectId) {
        setChatStatuses((prev) => ({ ...prev, [nodeId]: { type: 'error', text: 'No active project' } }));
        return;
      }
      const text = (chatMessages[nodeId] || '').trim();
      if ((!text && !chatFiles[nodeId]?.length) || chatSending[nodeId]) return;

      setChatSending((prev) => ({ ...prev, [nodeId]: true }));
      setChatStatuses((prev) => ({ ...prev, [nodeId]: null }));

      try {
        const cardId = chatKanbanIds[nodeId];
        const node = nodes.find(node => node.id === nodeId);
        const res = cardId
          ? node && onSendKanbanCard ? await onSendKanbanCard(cardId, node, text, chatFiles[nodeId] || []) : { ok: false, message: 'The assigned agent is no longer available.' }
          : await sendNodeMessage(projectId, nodeId, text, undefined, chatFiles[nodeId] || []);
        if (res.ok) {
          setChatMessages((prev) => ({ ...prev, [nodeId]: '' }));
          setChatFiles((prev) => ({ ...prev, [nodeId]: [] }));
          setChatKanbanIds(prev => ({ ...prev, [nodeId]: undefined }));
          setTimeout(() => {
            setChatOpenNodeId((curr) => (curr === nodeId ? null : curr));
            setChatStatuses((prev) => ({ ...prev, [nodeId]: null }));
          }, 700);
        } else {
          setChatStatuses((prev) => ({
            ...prev,
            [nodeId]: { type: 'error', text: res.message || 'Failed to send' },
          }));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error sending message';
        setChatStatuses((prev) => ({ ...prev, [nodeId]: { type: 'error', text: msg } }));
      } finally {
        setChatSending((prev) => ({ ...prev, [nodeId]: false }));
      }
    },
    [projectId, chatMessages, chatFiles, chatSending, chatKanbanIds, nodes, onSendKanbanCard]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, nodeId: string) => {
      if (
        e.dataTransfer.types.includes(KANBAN_DRAG_TYPE) ||
        isDraggingGitHubItem ||
        e.dataTransfer.types.includes('application/json') ||
        e.dataTransfer.types.includes('Files')
      ) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (dropHoverNodeId !== nodeId) {
          setDropHoverNodeId(nodeId);
        }
      }
    },
    [isDraggingGitHubItem, dropHoverNodeId]
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent, nodeId: string) => {
      if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node)) {
        if (dropHoverNodeId === nodeId) {
          setDropHoverNodeId(null);
        }
      }
    },
    [dropHoverNodeId]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent, nodeId: string) => {
      e.preventDefault();
      setIsDraggingGitHubItem(false);
      setDropHoverNodeId(null);

      const cardId = e.dataTransfer.getData(KANBAN_DRAG_TYPE);
      if (cardId) {
        e.stopPropagation();
        closePreview();
        if (chatSending[nodeId]) return;
        const node = nodes.find(node => node.id === nodeId);
        const card = node ? onDropKanbanCard?.(cardId, node) : undefined;
        if (card) {
          setChatKanbanIds(prev => ({ ...prev, [nodeId]: card.id }));
          setChatMessages(prev => ({ ...prev, [nodeId]: buildCardPrompt(card) }));
          setChatFiles(prev => ({ ...prev, [nodeId]: card.files }));
          setChatStatuses(prev => ({ ...prev, [nodeId]: null }));
          setChatOpenNodeId(nodeId);
        }
        return;
      }

      if (e.dataTransfer.files.length) {
        if (chatSending[nodeId]) return;
        const files = [...(chatFiles[nodeId] || []), ...Array.from(e.dataTransfer.files)];
        const error = validateMessageFiles(files);
        closePreview();
        setChatOpenNodeId(nodeId);
        if (error) setChatStatuses((prev) => ({ ...prev, [nodeId]: { type: 'error', text: error } }));
        else setChatFiles((prev) => ({ ...prev, [nodeId]: files }));
        return;
      }

      let item = draggedItem;
      if (!item) {
        try {
          const json = e.dataTransfer.getData('application/json');
          if (json) {
            item = JSON.parse(json);
          }
        } catch {
          // ignore
        }
      }

      if (item) {
        const prompt = buildGitHubPrompt(item);
        setChatKanbanIds(prev => ({ ...prev, [nodeId]: undefined }));
        closePreview();
        setChatOpenNodeId(nodeId);
        setChatMessages((prev) => ({ ...prev, [nodeId]: prompt }));
      }
    },
    [draggedItem, closePreview, chatFiles, chatSending, nodes, onDropKanbanCard]
  );

  const renderChatExtension = useCallback((node: Node) => {
    if (chatOpenNodeId !== node.id) return null;
    if (node.chatAvailable === false) return (
      <div className="node-card-chat-extension">
        <p className="text-sm text-muted">Use this agent’s Terminal. Native Chat and task dispatch are not connected yet.</p>
        <button className="btn btn-secondary btn-sm" onClick={() => { closeChat(node.id); onSelectNode(node.id); }}>Open terminal</button>
        <button className="btn btn-secondary btn-sm" onClick={() => closeChat(node.id)}>Close</button>
      </div>
    );
    return (
      <NodeChatExtension
        node={node}
        files={chatFiles[node.id] || []}
        status={chatStatuses[node.id]}
        isSending={Boolean(chatSending[node.id])}
        currentMsg={chatMessages[node.id] || ''}
        onChangeFiles={(files) => setChatFiles((prev) => ({ ...prev, [node.id]: files }))}
        onChangeMessage={(msg) => setChatMessages((prev) => ({ ...prev, [node.id]: msg }))}
        onSendMessage={() => handleSendChatMessage(node.id)}
        onClose={() => closeChat(node.id)}
      />
    );
  }, [chatOpenNodeId, chatFiles, chatStatuses, chatSending, chatMessages, closeChat, onSelectNode, handleSendChatMessage]);

  return {
    isDraggingGitHubItem,
    dropHoverNodeId,
    chatOpenNodeId,
    setChatOpenNodeId,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    renderChatExtension,
  };
}
