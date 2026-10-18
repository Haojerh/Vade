import { WorktreeHistory } from '../github/WorktreeHistory';
import { Disclosure } from '../../components/ui/Disclosure';
import { Modal } from '../../components/ui/Modal';
import React, { useEffect, useState } from 'react';
import type { Node, NodeDetails as NodeDetailsType } from '../../../shared/contracts';
import { Icon } from '../../components/ui/Icon';
import { latestAgentMessage } from './conversation';
import { LatestMessageCard } from './LatestMessageCard';
import { MessageMarkdown } from './MessageMarkdown';
import { sendNodeMessage } from '../../api/client';
import { useConfirmationState } from '../../hooks/useConfirmationState';
import { MessageAttachments } from './MessageAttachments';
import {
  TaskCard,
  NodeDetailsHeader,
  NodeDetailsActionDialogs,
  useNodeDetailsActions,
} from './NodeDetailsParts';

export interface NodeDetailsVisibleSections {
  status: boolean;
  tasks: boolean;
  latest: boolean;
  tool: boolean;
  conversation: boolean;
  chatbox: boolean;
}

export const DEFAULT_VISIBLE_SECTIONS: NodeDetailsVisibleSections = {
  status: true,
  tasks: true,
  latest: true,
  tool: true,
  conversation: true,
  chatbox: true,
};

interface NodeDetailsProps {
  projectId: string | null;
  details: NodeDetailsType | null;
  loading: boolean;
  error: string | null;
  selectedNodeId: string | null;
  selectedNode?: Node | null;
  onClose: () => void;
  onRefresh: () => void;
  visibleSections?: NodeDetailsVisibleSections;
  commitGraphEnabled?: boolean;
}

export const NodeDetails: React.FC<NodeDetailsProps> = ({
  projectId,
  details,
  loading,
  error,
  selectedNodeId,
  selectedNode,
  onClose,
  onRefresh,
  visibleSections,
  commitGraphEnabled = false,
}) => {
  const [expandedMsgIds, setExpandedMsgIds] = useState<Set<string>>(new Set());
  const detailsOverlay = useConfirmationState({ onClosed: onClose });
  const isClosing = detailsOverlay.closing;

  const [chatMessage, setChatMessage] = useState<string>('');
  const [chatFiles, setChatFiles] = useState<File[]>([]);
  useEffect(() => {
    setChatFiles([]);
    setChatMessage('');
  }, [projectId, selectedNodeId]);
  const [chatSending, setChatSending] = useState<boolean>(false);
  const [chatStatus, setChatStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (selectedNodeId) detailsOverlay.open();
    else detailsOverlay.reset();
  }, [selectedNodeId, detailsOverlay.open, detailsOverlay.reset]);
  const handleClose = detailsOverlay.close;

  const actions = useNodeDetailsActions({
    projectId,
    selectedNodeId,
    details,
    handleClose,
    onRefresh,
  });

  const activeVisibleSections = visibleSections ?? DEFAULT_VISIBLE_SECTIONS;

  const handleSendMessage = async () => {
    if (!projectId || !details?.node || (!chatMessage.trim() && !chatFiles.length) || chatSending) return;
    setChatSending(true);
    setChatStatus(null);
    try {
      await sendNodeMessage(projectId, details.node.id, chatMessage.trim(), undefined, chatFiles);
      setChatStatus({ type: 'success', text: 'Message sent!' });
      setChatMessage('');
      setChatFiles([]);
      setTimeout(() => setChatStatus(null), 3000);
      onRefresh();
    } catch (err: any) {
      setChatStatus({ type: 'error', text: err?.message || 'Failed to send message' });
    } finally {
      setChatSending(false);
    }
  };

  const toggleExpand = (msgId: string) => {
    setExpandedMsgIds((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) {
        next.delete(msgId);
      } else {
        next.add(msgId);
      }
      return next;
    });
  };

  const formatIso = (iso: string | null | undefined): string => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return iso;
    }
  };

  if (!selectedNodeId) {
    return null;
  }

  const isMatchingDetails = Boolean(details?.node && details.node.id === selectedNodeId);
  const baseNode = isMatchingDetails ? details!.node : selectedNode?.id === selectedNodeId ? selectedNode : null;
  const liveLabel = (selectedNode?.id === selectedNodeId && selectedNode.label) || details?.node?.label;
  const node = baseNode ? { ...baseNode, label: liveLabel || baseNode.label } : null;
  const currentTool = isMatchingDetails ? details?.currentTool : null;
  const conversation = isMatchingDetails ? details?.conversation : null;
  const convData = conversation?.data;
  const convMeta = conversation?.meta;
  const isUnstartedAgentConvo =
    convMeta?.issue?.code === 'CONVERSATION_UNSUPPORTED' &&
    (convMeta.issue.message.includes('provenance not found') ||
      convMeta.issue.message.includes('not found or unsupported'));
  const messages = convData?.messages ?? [];
  const latestReply = latestAgentMessage(messages);
  const isWorktree = node?.kind === 'worktree';
  const assignedTasks = (isMatchingDetails ? (details?.tasks ?? []) : []).filter(
    (t) => t.assigneeNodeId === node?.id || (node?.taskIds && node.taskIds.includes(t.id))
  );

  return (
    <>
      <Modal
        isOpen={Boolean(selectedNodeId)}
        isClosing={isClosing}
        onClose={handleClose}
        className={isWorktree ? 'worktree-details-dialog' : ''}
        aria-labelledby="dialog-node-title"
        aria-describedby="dialog-node-desc"
      >
        <div className="modal-dialog-container">
          <NodeDetailsHeader
            node={node}
            selectedNodeId={selectedNodeId}
            isWorktree={Boolean(isWorktree)}
            loading={loading}
            actions={actions}
            onRefresh={onRefresh}
            onClose={handleClose}
          />

          <div className="modal-dialog-body">
            {actions.actionSuccess && (
              <div className="panel-alert alert-success" role="status" style={{ marginBottom: '12px' }}>
                {actions.actionSuccess}
              </div>
            )}

            {!isMatchingDetails && !error && (
              <div className="modal-loading-state" role="status">
                <div className="skeleton-line" />
                <div className="skeleton-line short" />
                <div className="skeleton-line" />
              </div>
            )}

            {error && (
              <div className="panel-alert alert-error" role="alert">
                <span className="font-semibold">
                  {isMatchingDetails ? 'Error refreshing node details:' : 'Error loading node details:'}
                </span>{' '}
                {error}
              </div>
            )}

            {isMatchingDetails && node && (
              <>
                {activeVisibleSections.status && (
                  <Disclosure title="Status & Workspace" defaultOpen className="facts-section">
                    <div className="facts-panel">
                      <div className="facts-metadata-row">
                        <div className="fact-col">
                          <span className="fact-field-label">State</span>
                          <div className="fact-field-value facts-state-value">
                            <span className={`node-badge-state state-${node.state}`}>{node.state}</span>
                            {node.rawState && node.rawState !== node.state && (
                              <span className="fact-field-sub text-xs text-muted">({node.rawState})</span>
                            )}
                          </div>
                        </div>
                        {node.workspaceStatus && (
                          <div className="fact-col">
                            <span className="fact-field-label">Workspace</span>
                            <div className="fact-field-value facts-workspace-value">{node.workspaceStatus}</div>
                          </div>
                        )}
                        {node.branch && (
                          <div className="fact-col">
                            <span className="fact-field-label">Branch</span>
                            <div className="fact-field-value font-mono">⎇ {node.branch}</div>
                          </div>
                        )}
                      </div>

                      {node.path && (
                        <div className="facts-path-row">
                          <span className="fact-field-label">Path</span>
                          <div className="facts-path-code" title={node.path}>
                            <Icon name="folder" size={16} strokeWidth={1.5} />
                            <code>{node.path}</code>
                          </div>
                        </div>
                      )}

                      <div className="facts-timestamps-row">
                        <div className="fact-timestamp-item">
                          <span className="fact-field-label">Observed</span>
                          <time
                            className="fact-field-value font-mono"
                            dateTime={node.observedAt || undefined}
                            title={node.observedAt ? new Date(node.observedAt).toLocaleString() : undefined}
                          >
                            {formatIso(node.observedAt)}
                          </time>
                        </div>
                        {node.lastActivityAt && (
                          <div className="fact-timestamp-item">
                            <span className="fact-field-label">Last Activity</span>
                            <time
                              className="fact-field-value font-mono"
                              dateTime={node.lastActivityAt}
                              title={new Date(node.lastActivityAt).toLocaleString()}
                            >
                              {formatIso(node.lastActivityAt)}
                            </time>
                          </div>
                        )}
                      </div>
                    </div>
                  </Disclosure>
                )}

                {isWorktree && projectId && (
                  <Disclosure key={`${projectId}:${node.id}`} title="Branch History" lazy>
                    <WorktreeHistory
                      projectId={projectId}
                      nodeId={node.id}
                      branch={node.branch ?? undefined}
                      commitGraphEnabled={commitGraphEnabled}
                    />
                  </Disclosure>
                )}

                {activeVisibleSections.tasks && !isWorktree && assignedTasks.length > 0 && (
                  <Disclosure
                    title="Assigned Tasks"
                    defaultOpen
                    className="assigned-tasks-section"
                    badge={<span className="badge badge-neutral text-xs font-mono">{assignedTasks.length}</span>}
                  >
                    <div className="assigned-tasks-list">
                      {assignedTasks.map((t) => (
                        <TaskCard key={t.id} task={t} />
                      ))}
                    </div>
                  </Disclosure>
                )}

                {activeVisibleSections.latest && !isWorktree && (
                  <Disclosure title="Latest Agent Message" defaultOpen className="latest-message-section">
                    {latestReply ? (
                      <LatestMessageCard
                        key={latestReply.id}
                        message={latestReply}
                        stale={Boolean(convMeta?.stale)}
                      />
                    ) : (
                      <p className="text-xs text-muted">
                        {convMeta?.availability === 'unsupported' || convMeta?.availability === 'unavailable'
                          ? isUnstartedAgentConvo
                            ? 'No agent reply in recent history.'
                            : 'Agent message unavailable from this conversation source.'
                          : 'No agent reply in recent history.'}
                      </p>
                    )}
                  </Disclosure>
                )}

                {activeVisibleSections.tool && !isWorktree && currentTool && (
                  <Disclosure title="Current Tool Activity" defaultOpen className="tool-section">
                    <div className="current-tool-card">
                      <div className="tool-name-row">
                        <span className="tool-tag">Active Tool</span>
                        <span className="tool-name font-mono font-bold">{currentTool.name}</span>
                      </div>
                      {currentTool.input && (
                        <div className="tool-input-box">
                          <div className="tool-input-label text-xs text-muted mb-1">Input / Arguments:</div>
                          <pre className="tool-input-pre font-mono">{currentTool.input}</pre>
                        </div>
                      )}
                    </div>
                  </Disclosure>
                )}

                {activeVisibleSections.conversation && !isWorktree && (
                  <Disclosure title="Conversation History" defaultOpen className="conversation-section">
                    {convMeta?.issue && !isUnstartedAgentConvo && (
                      <div className="panel-alert alert-error mb-3" role="alert">
                        <span className="font-semibold">[{convMeta.issue.code}]:</span> {convMeta.issue.message}
                      </div>
                    )}

                    {convMeta?.availability === 'unsupported' && !convMeta.issue && !isUnstartedAgentConvo && (
                      <div className="panel-alert alert-info mb-3">
                        Conversation source is unsupported for this node. Unmanaged or coordinator sessions have no
                        structured transcript.
                      </div>
                    )}

                    {messages.length === 0 ? (
                      <div className="empty-hint">
                        {convMeta?.availability === 'empty' || isUnstartedAgentConvo
                          ? 'No conversation messages recorded for this session.'
                          : convMeta?.availability === 'unsupported'
                            ? 'Structured transcript unavailable.'
                            : 'No messages in current transcript window.'}
                      </div>
                    ) : (
                      <div className="conversation-thread" role="log" aria-label="Conversation turns">
                        {messages.map((msg) => {
                          const isAgent = msg.role === 'agent';
                          const isLong = msg.text.length > 800;
                          const isExpanded = expandedMsgIds.has(msg.id);

                          return (
                            <div
                              key={msg.id}
                              className={`chat-bubble-row ${isAgent ? 'row-agent' : 'row-user'}`}
                            >
                              <div className={`chat-bubble ${isAgent ? 'bubble-agent' : 'bubble-user'}`}>
                                <div className="chat-bubble-header">
                                  <span className="bubble-role font-semibold text-xs">
                                    {isAgent ? 'Agent' : 'User'}
                                  </span>
                                  <time className="bubble-time font-mono text-xs text-muted">
                                    {msg.at ? formatIso(msg.at) : 'Time: —'}
                                  </time>
                                </div>

                                <div
                                  className={`chat-bubble-text message-markdown ${isLong && !isExpanded ? 'message-collapsed' : ''}`}
                                >
                                  <MessageMarkdown text={msg.text} />
                                </div>

                                {isLong && (
                                  <button
                                    type="button"
                                    className="btn-read-more"
                                    onClick={() => toggleExpand(msg.id)}
                                    aria-expanded={isExpanded}
                                  >
                                    {isExpanded ? 'Read Less' : 'Read More'}
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </Disclosure>
                )}

                {activeVisibleSections.chatbox && !isWorktree && (
                  <div className="modal-section agent-chatbox-section">
                    <div className="section-header-row">
                      <h3 className="section-title">Message Agent</h3>
                      {chatStatus && (
                        <span
                          className={`chat-status-badge text-xs font-mono font-semibold ${chatStatus.type === 'error' ? 'text-danger' : 'text-success'}`}
                        >
                          {chatStatus.text}
                        </span>
                      )}
                    </div>
                    <div className="node-details-chatbox">
                      <form
                        className="chatbox-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          handleSendMessage();
                        }}
                      >
                        <MessageAttachments
                          files={chatFiles}
                          onChange={setChatFiles}
                          disabled={chatSending}
                          renderControls={(attachButton) => (
                            <div className="message-composer-actions">
                              <div className="message-attachment-controls">
                                {attachButton}
                                <span className="text-xs text-muted">Paste or drop files - 5 MiB each</span>
                              </div>
                              <button
                                type="submit"
                                className="btn btn-primary btn-sm btn-chat-send"
                                disabled={chatSending || (!chatMessage.trim() && !chatFiles.length)}
                              >
                                {chatSending ? (
                                  <span>Sending...</span>
                                ) : (
                                  <>
                                    <Icon name="send" size={14} />
                                    <span>Send</span>
                                  </>
                                )}
                              </button>
                            </div>
                          )}
                        >
                          <textarea
                            className="chatbox-textarea"
                            placeholder={`Message ${node.label}... (Enter to send, Shift+Enter for new line)`}
                            value={chatMessage}
                            onChange={(e) => setChatMessage(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                handleSendMessage();
                              }
                            }}
                            rows={3}
                            disabled={chatSending}
                          />
                        </MessageAttachments>
                      </form>
                    </div>
                  </div>
                )}

                {!(isWorktree && projectId) &&
                  !activeVisibleSections.status &&
                  (!activeVisibleSections.tasks || isWorktree || assignedTasks.length === 0) &&
                  (!activeVisibleSections.latest || isWorktree) &&
                  (!activeVisibleSections.tool || isWorktree || !currentTool) &&
                  (!activeVisibleSections.conversation || isWorktree) &&
                  (!activeVisibleSections.chatbox || isWorktree) && (
                    <div className="empty-hint p-6 text-center text-muted">
                      All sections are hidden by your display settings. Open Settings in the sidebar to re-enable them.
                    </div>
                  )}
              </>
            )}
          </div>
        </div>
      </Modal>

      <NodeDetailsActionDialogs
        node={node}
        detailsNodeLabel={details?.node?.label || ''}
        isWorktree={Boolean(isWorktree)}
        actions={actions}
      />
    </>
  );
};
