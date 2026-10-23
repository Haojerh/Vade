import { WorktreeHistory } from '../github/WorktreeHistory';
import { AgentInteraction } from './AgentInteraction';
import { Disclosure } from '../../components/ui/Disclosure';
import { Modal } from '../../components/ui/Modal';
import React, { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Node, NodeDetails as NodeDetailsType } from '../../../shared/contracts';
import { Icon } from '../../components/ui/Icon';
import { ConversationHistory } from './ConversationHistory';
import { ConversationToolCall } from './ConversationToolCall';
import { sendNodeMessage } from '../../api/client';
import { useConfirmationState } from '../../hooks/useConfirmationState';
import { MessageAttachments } from './MessageAttachments';
import { AgentChatControls } from './AgentChatControls';
import { DictationButton } from './DictationButton';
import { appendDictation } from './dictation';
const AgentTerminal = lazy(() => import('./AgentTerminal').then(module => ({ default: module.AgentTerminal })));
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
  onSessionChange?: () => void;
  visibleSections?: NodeDetailsVisibleSections;
  commitGraphEnabled?: boolean;
  chatToolCallsEnabled?: boolean;
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
  onSessionChange,
  visibleSections,
  commitGraphEnabled = false,
  chatToolCallsEnabled = true,
}) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [showBackToBottom, setShowBackToBottom] = useState(false);
  const [sessionView, setSessionView] = useState<'chat' | 'terminal'>('terminal');
  useEffect(() => { setSessionView('terminal'); }, [projectId, selectedNodeId]);
  useLayoutEffect(() => {
    setShowBackToBottom(false);
    if (details?.node.id !== selectedNodeId || details?.node.kind === 'worktree') return;
    const frame = requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (body) body.scrollTop = body.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [projectId, selectedNodeId, selectedRunId, details?.conversation.data?.sourceIdentity]);
  const detailsOverlay = useConfirmationState({ onClosed: onClose });
  const isClosing = detailsOverlay.closing;

  const [chatMessage, setChatMessage] = useState<string>('');
  const [chatFiles, setChatFiles] = useState<File[]>([]);
  useEffect(() => {
    setChatFiles([]);
    setChatMessage('');
  }, [projectId, selectedNodeId]);
  const [chatSending, setChatSending] = useState<boolean>(false);
  const [dictating, setDictating] = useState(false);
  const [chatStatus, setChatStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const chatRequest = useRef<AbortController | null>(null);
  const chatTarget = useRef(''); chatTarget.current = `${projectId}:${selectedNodeId}`;
  useEffect(() => {
    setChatSending(false); setChatStatus(null);
    return () => { chatRequest.current?.abort(); chatRequest.current = null; };
  }, [projectId, selectedNodeId]);

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
    if (!projectId || !details?.node || (!chatMessage.trim() && !chatFiles.length) || chatSending || dictating) return;
    setChatSending(true);
    setChatStatus(null);
    const target = chatTarget.current, abort = new AbortController(); chatRequest.current = abort;
    const current = () => !abort.signal.aborted && chatTarget.current === target;
    try {
      await sendNodeMessage(projectId, details.node.id, chatMessage.trim(), abort.signal, chatFiles);
      if (!current()) return;
      setChatMessage('');
      setChatFiles([]);
      onRefresh();
    } catch (err: any) {
      if (current()) setChatStatus({ type: 'error', text: err?.message || 'Failed to send message' });
    } finally {
      if (current()) setChatSending(false);
      if (chatRequest.current === abort) chatRequest.current = null;
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
    Boolean(details?.session?.reason) || convMeta?.issue?.code === 'CONVERSATION_UNSUPPORTED' &&
    (convMeta.issue.message.includes('provenance not found') ||
      convMeta.issue.message.includes('not found or unsupported'));
  const messages = convData?.messages ?? [];
  const tools = chatToolCallsEnabled ? (selectedNode?.id === selectedNodeId ? selectedNode.toolActivity?.data : undefined) ?? node?.toolActivity?.data ?? [] : [];

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

          {isMatchingDetails && !isWorktree && details?.session?.chat && projectId && <div className="session-view-toolbar">
            <button type="button" className="session-view-switch" role="switch" aria-label="Terminal view" aria-checked={sessionView === 'terminal'} onClick={() => setSessionView(view => view === 'chat' ? 'terminal' : 'chat')}>
              <span className={sessionView === 'chat' ? 'is-active' : ''}>Chat</span>
              <span className="session-view-track" aria-hidden="true"><span /></span>
              <span className={sessionView === 'terminal' ? 'is-active' : ''}>Terminal</span>
            </button>
          </div>}

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

                {!isWorktree && details?.session && projectId && <>
                  {(sessionView === 'terminal' || !details.session.chat) && <Suspense fallback={<p role="status">Opening terminal…</p>}><AgentTerminal key={`${projectId}:${node.id}`} projectId={projectId} nodeId={node.id} provider={node.agentType ?? undefined} onStatusChange={onSessionChange} /></Suspense>}
                </>}

                {activeVisibleSections.conversation && !isWorktree && (!details?.session || (sessionView === 'chat' && details.session.history)) && (
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

                    {messages.length === 0 && tools.length === 0 && !convData?.nextCursor ? (
                      <div className="conversation-empty" role="status"><Icon name="message-square" size={28} /><strong>{isUnstartedAgentConvo ? 'Ready for your first conversation' : 'No messages yet'}</strong><p>
                        {details?.session?.reason ?? (
                        convMeta?.availability === 'empty' || isUnstartedAgentConvo
                          ? 'No conversation messages recorded for this session.'
                          : convMeta?.availability === 'unsupported'
                            ? 'Structured transcript unavailable.'
                            : 'Messages will appear here when the provider records them.')}
                        </p>
                      </div>
                    ) : (
                      convData ? <ConversationHistory key={`${projectId}:${selectedNodeId}:${selectedRunId}:${convData?.sourceIdentity}`} projectId={projectId!} nodeId={selectedNodeId} runId={selectedRunId ?? null} page={convData} tools={tools} scrollContainerRef={bodyRef} /> : <div className="conversation-thread">{tools.map(tool => <ConversationToolCall key={tool.id} tool={tool} />)}</div>
                    )}
                  </section>
                )}

                {activeVisibleSections.chatbox && !isWorktree && (!details?.session || (sessionView === 'chat' && details.session.chat)) && (
                  <div className="modal-section agent-chatbox-section">
                    {projectId && details?.session?.chat && <AgentInteraction key={`${projectId}:${node.id}`} projectId={projectId} nodeId={node.id} waiting={(selectedNode ?? node).state === 'waiting'} onTerminal={() => setSessionView('terminal')} />}
                    {chatStatus?.type === 'error' && <div className="section-header-row">

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
                              </div>
                              {projectId && <AgentChatControls projectId={projectId} nodeId={node.id} runId={selectedRunId ?? null} model={node.model} effort={node.effort} disabled={chatSending || isClosing || ['working', 'waiting', 'blocked'].includes(node.state)} />}
                              <DictationButton key={`dictation:${projectId}:${node.id}:${selectedRunId ?? ''}`} disabled={chatSending || isClosing}
                                onText={(text) => setChatMessage((draft) => appendDictation(draft, text))} onActiveChange={setDictating} />
                              <button
                                type="submit"
                                className="btn btn-primary btn-sm btn-chat-send"
                                aria-label={chatSending ? 'Sending message' : 'Send message'} title="Send message"
                                disabled={chatSending || dictating || (!chatMessage.trim() && !chatFiles.length)}
                              >
                                {chatSending ? (
                                  <><Icon name="refresh-cw" size={14} /><span className="composer-action-label">Sending...</span></>
                                ) : (
                                  <>
                                    <Icon name="send" size={14} />
                                    <span className="composer-action-label">Send</span>
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
                              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                                e.preventDefault();
                                handleSendMessage();
                              }
                            }}
                            rows={3}
                            disabled={chatSending}
                          />
                        </MessageAttachments>
                        {chatFiles.length > 0 && ['codebuddy','opencode','opencode2','kilo'].includes(node.agentType ?? '') && <p className="text-muted text-xs">{node.agentType === 'codebuddy' ? 'Files are sent as local file references for CodeBuddy to read.' : 'Images and PDFs use native attachments. Other files are sent as local file references.'}</p>}
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
