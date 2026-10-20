import { WorktreeHistory } from '../github/WorktreeHistory';
import { Disclosure } from '../../components/ui/Disclosure';
import { Modal } from '../../components/ui/Modal';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Node, NodeDetails as NodeDetailsType } from '../../../shared/contracts';
import { Icon } from '../../components/ui/Icon';
import { ConversationHistory } from './ConversationHistory';
import { sendNodeMessage } from '../../api/client';
import { useConfirmationState } from '../../hooks/useConfirmationState';
import { MessageAttachments } from './MessageAttachments';
import {
  NodeDetailsHeader,
  NodeDetailsActionDialogs,
  useNodeDetailsActions,
} from './NodeDetailsParts';

export interface NodeDetailsVisibleSections {
  conversation: boolean;
  chatbox: boolean;
}

export const DEFAULT_VISIBLE_SECTIONS: NodeDetailsVisibleSections = {
  conversation: true,
  chatbox: true,
};

interface NodeDetailsProps {
  projectId: string | null;
  details: NodeDetailsType | null;
  loading: boolean;
  error: string | null;
  selectedNodeId: string | null;
  selectedRunId?: string | null;
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
  selectedRunId,
  selectedNode,
  onClose,
  onRefresh,
  visibleSections,
  commitGraphEnabled = false,
}) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [showBackToBottom, setShowBackToBottom] = useState(false);
  useLayoutEffect(() => {
    setShowBackToBottom(false);
    if (details?.node.id !== selectedNodeId || details?.node.kind === 'worktree') return;
    const frame = requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (body) body.scrollTop = body.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [projectId, selectedNodeId, selectedRunId, details?.conversation]);
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

  if (!selectedNodeId) {
    return null;
  }

  const isMatchingDetails = Boolean(details?.node && details.node.id === selectedNodeId);
  const baseNode = isMatchingDetails ? details!.node : selectedNode?.id === selectedNodeId ? selectedNode : null;
  const liveLabel = (selectedNode?.id === selectedNodeId && selectedNode.label) || details?.node?.label;
  const node = baseNode ? { ...baseNode, label: liveLabel || baseNode.label } : null;
  const conversation = isMatchingDetails ? details?.conversation : null;
  const convData = conversation?.data;
  const convMeta = conversation?.meta;
  const isUnstartedAgentConvo =
    convMeta?.issue?.code === 'CONVERSATION_UNSUPPORTED' &&
    (convMeta.issue.message.includes('provenance not found') ||
      convMeta.issue.message.includes('not found or unsupported'));
  const messages = convData?.messages ?? [];

  const isWorktree = node?.kind === 'worktree';
  return (
    <>
      <Modal
        isOpen={Boolean(selectedNodeId)}
        isClosing={isClosing}
        onClose={handleClose}
        className={isWorktree ? 'worktree-details-dialog' : !activeVisibleSections.conversation ? 'composer-only-dialog' : ''}
        aria-labelledby="dialog-node-title"
        aria-describedby="dialog-node-desc"
      >
        <div className={`modal-dialog-container ${isWorktree ? '' : 'agent-details-container'}`}>
          <NodeDetailsHeader
            node={node}
            selectedNodeId={selectedNodeId}
            isWorktree={Boolean(isWorktree)}
            loading={loading}
            actions={actions}
            onRefresh={onRefresh}
            onClose={handleClose}
          />

          <div ref={bodyRef} className="modal-dialog-body" onScroll={event => {
            const body = event.currentTarget;
            setShowBackToBottom(!isWorktree && body.scrollHeight - body.clientHeight - body.scrollTop > Math.max(240, body.clientHeight / 2));
          }}>
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
                {isWorktree && <Disclosure title="Status & Workspace" defaultOpen className="facts-section">
                  <div className="facts-panel">
                    <div className="facts-metadata-row">
                      <div className="fact-col"><span className="fact-field-label">State</span><span className={`node-badge-state state-${node.state}`}>{node.state}</span></div>
                      {node.workspaceStatus && <div className="fact-col"><span className="fact-field-label">Workspace</span><span className="fact-field-value">{node.workspaceStatus}</span></div>}
                      {node.branch && <div className="fact-col"><span className="fact-field-label">Branch</span><span className="fact-field-value font-mono">{node.branch}</span></div>}
                    </div>
                    {node.path && <div className="facts-path-row"><span className="fact-field-label">Path</span><div className="facts-path-code" title={node.path}><Icon name="folder" size={16} /><code>{node.path}</code></div></div>}
                    <div className="facts-timestamps-row">
                      <div className="fact-timestamp-item"><span className="fact-field-label">Observed</span><time className="fact-field-value font-mono" dateTime={node.observedAt ?? undefined}>{node.observedAt ? new Date(node.observedAt).toLocaleString() : 'Unavailable'}</time></div>
                      {node.lastActivityAt && <div className="fact-timestamp-item"><span className="fact-field-label">Last activity</span><time className="fact-field-value font-mono" dateTime={node.lastActivityAt}>{new Date(node.lastActivityAt).toLocaleString()}</time></div>}
                    </div>
                  </div>
                </Disclosure>}
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

                {activeVisibleSections.conversation && !isWorktree && (
                  <section className="conversation-section" aria-label="Conversation">
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

                    {messages.length === 0 && !convData?.nextCursor ? (
                      <div className="empty-hint">
                        {convMeta?.availability === 'empty' || isUnstartedAgentConvo
                          ? 'No conversation messages recorded for this session.'
                          : convMeta?.availability === 'unsupported'
                            ? 'Structured transcript unavailable.'
                            : 'No messages in current transcript window.'}
                      </div>
                    ) : (
                      <ConversationHistory key={`${projectId}:${selectedNodeId}:${selectedRunId}:${convData?.sourceIdentity}`} projectId={projectId!} nodeId={selectedNodeId} runId={selectedRunId ?? null} page={convData!} scrollContainerRef={bodyRef} />
                    )}
                  </section>
                )}

                {activeVisibleSections.chatbox && !isWorktree && (
                  <div className="modal-section agent-chatbox-section">
                    {chatStatus && <div className="section-header-row">

                      {chatStatus && (
                        <span
                          className={`chat-status-badge text-xs font-mono font-semibold ${chatStatus.type === 'error' ? 'text-danger' : 'text-success'}`}
                        >
                          {chatStatus.text}
                        </span>
                      )}
                    </div>}
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
                  (!activeVisibleSections.conversation || isWorktree) &&
                  (!activeVisibleSections.chatbox || isWorktree) && (
                    <div className="empty-hint p-6 text-center text-muted">
                      All sections are hidden by your display settings. Open Settings in the sidebar to re-enable them.
                    </div>
                  )}
              </>
            )}
          </div>
          {showBackToBottom && <button type="button" className="btn btn-secondary btn-sm node-details-back-bottom" onClick={() => {
            const body = bodyRef.current;
            if (body) body.scrollTo({ top: body.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
          }}><Icon name="arrow-down" size={14} />Back to bottom</button>}
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
