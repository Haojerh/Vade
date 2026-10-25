import { WorktreeHistory } from '../github/WorktreeHistory';
import { AgentInteraction } from './AgentInteraction';
import { Disclosure } from '../../components/ui/Disclosure';
import { Modal } from '../../components/ui/Modal';
import React, { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Node, NodeDetails as NodeDetailsType } from '../../../shared/contracts';
import { Icon } from '../../components/ui/Icon';
import { RefreshIcon } from '../../components/ui/RefreshIcon';
import { ConversationHistory } from './ConversationHistory';
import { ConversationToolCall } from './ConversationToolCall';
import { ProviderActivity } from './ProviderActivity';
import { useAgentDraft } from '../../hooks/useAgentDraft';
import { WORKFLOW_CONFIRMATION_MESSAGE } from '../../../shared/contracts';
import { ConfirmationDialog } from '../../components/ui/ConfirmationDialog';
import { sendNodeMessage, interruptAgent, openChatTerminal, resumeTerminal } from '../../api/client';
import { useConfirmationState } from '../../hooks/useConfirmationState';
import { MessageAttachments } from './MessageAttachments';
import { AgentChatControls } from './AgentChatControls';
import { DictationButton } from './DictationButton';
import { appendDictation } from './dictation';
import { HandoffDialog, HandoffNotice } from './HandoffDialog';
import { readAgentView } from '../../app/agentViewPreference';
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
  onOpenSession?: (nodeId: string) => void;
  handoffEnabled?: boolean;
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
  onOpenSession,
  handoffEnabled = false,
  visibleSections,
  commitGraphEnabled = false,
  chatToolCallsEnabled = true,
}) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [showBackToBottom, setShowBackToBottom] = useState(false);
  const [sessionView, setSessionView] = useState<'chat' | 'terminal'>(readAgentView);
  useEffect(() => { setSessionView(readAgentView()); }, [projectId, selectedNodeId]);
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

  const [chatMessage, setChatMessage] = useAgentDraft(projectId, selectedNodeId);
  const [chatFiles, setChatFiles] = useState<File[]>([]);
  useEffect(() => {
    setChatFiles([]);
  }, [projectId, selectedNodeId]);
  const [chatSending, setChatSending] = useState<boolean>(false);
  const [dictating, setDictating] = useState(false);
  const [chatStatus, setChatStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const workflowConfirmation = useConfirmationState<{ message: string; files: File[] }>();
  const handoff = useConfirmationState();
  const chatRequest = useRef<AbortController | null>(null);
  const chatTarget = useRef(''); chatTarget.current = `${projectId}:${selectedNodeId}`;
  const [chatTerminal,setChatTerminal]=useState<import('../../../shared/contracts').TerminalPage|null>(null);
  const [terminalError,setTerminalError]=useState<string|null>(null);
  const [openingTerminal,setOpeningTerminal]=useState(false);
  useEffect(()=>{
    setChatTerminal(null);setTerminalError(null);
    if(!projectId||!selectedNodeId||sessionView!=='chat'||!details?.session?.chat)return;
    let active=true;setOpeningTerminal(true);
    void openChatTerminal(projectId,selectedNodeId).then(page=>{if(active){setChatTerminal(page);onSessionChange?.();}}).catch(error=>{if(active)setTerminalError(error instanceof Error?error.message:'Unable to open the agent terminal.');}).finally(()=>{if(active)setOpeningTerminal(false);});
    return()=>{active=false;};
  },[projectId,selectedNodeId,sessionView,details?.session?.chat]);
  useEffect(() => {
    setChatSending(false); setChatStatus(null);
    workflowConfirmation.reset();
    handoff.reset();
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

  const handleSendMessage = async (workflowConfirmed = false, pending?: { message: string; files: File[] }) => {
    if (!projectId || !details?.node || (!(pending?.message ?? chatMessage).trim() && !(pending?.files ?? chatFiles).length) || chatSending || dictating) return;
    setChatSending(true);
    setChatStatus(null);
    const target = chatTarget.current, abort = new AbortController(); chatRequest.current = abort;
    const current = () => !abort.signal.aborted && chatTarget.current === target;
    try {
      await sendNodeMessage(projectId, details.node.id, (pending?.message ?? chatMessage).trim(), abort.signal, pending?.files ?? chatFiles, workflowConfirmed);
      if (!current()) return;
      setChatMessage('');
      setChatFiles([]);
      onRefresh();
    } catch (err: any) {
      if (current()) {
        setChatStatus({ type: 'error', text: err?.message || 'Failed to send message' });
        if (!workflowConfirmed && String(err?.message).includes(WORKFLOW_CONFIRMATION_MESSAGE)) workflowConfirmation.open({ message: chatMessage, files: [...chatFiles] });
      }
    } finally {
      if (current()) setChatSending(false);
      if (chatRequest.current === abort) chatRequest.current = null;
    }
  };

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
  const canInterrupt = Boolean(details?.session?.chat && (selectedNode ?? node)?.state === 'working' && (selectedNode ?? node)?.liveness === 'live' && !chatMessage.trim() && !chatFiles.length);
  const interrupting = useRef(false);
  const [interruptRequested,setInterruptRequested]=useState(false);
  useEffect(()=>{interrupting.current=false;setInterruptRequested(false);},[projectId,selectedNodeId,(selectedNode ?? node)?.state]);
  const handleInterrupt = async () => {
    if (!projectId || !node || !canInterrupt || interrupting.current) return;
    interrupting.current = true; setInterruptRequested(true);setChatSending(true);
    const owner = chatTarget.current;
    try { await interruptAgent(projectId,node.id); }
    catch (error) { if(owner===chatTarget.current) setChatStatus({type:'error',text:error instanceof Error?error.message:'Unable to interrupt. Open Terminal to check the agent.'}); }
    finally { if(owner===chatTarget.current)setChatSending(false); }
  };
  if (!selectedNodeId) return null;

  return (
    <>
      <Modal
        isOpen={Boolean(selectedNodeId)}
        isClosing={isClosing}
        onClose={handleClose}
        className={isWorktree ? 'worktree-details-dialog' : `agent-details-dialog${!activeVisibleSections.conversation ? ' composer-only-dialog' : ''}`}
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
            onHandoff={handoffEnabled ? handoff.open : undefined}
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
                  {sessionView==='chat'&&(terminalError||chatTerminal&&!chatTerminal.live)&&<div className="panel-alert alert-info" role="status"><p>{terminalError??'The agent terminal is stopped. Resume it to continue this conversation.'}</p>{chatTerminal?.resumable&&<button type="button" className="btn btn-secondary btn-sm" disabled={openingTerminal} onClick={async()=>{const owner=chatTarget.current;setOpeningTerminal(true);try{await resumeTerminal(projectId,node.id);const page=await openChatTerminal(projectId,node.id);if(owner===chatTarget.current){setChatTerminal(page);setTerminalError(null);onSessionChange?.();}}catch(error){if(owner===chatTarget.current)setTerminalError(error instanceof Error?error.message:'Unable to resume the agent.');}finally{if(owner===chatTarget.current)setOpeningTerminal(false);}}}>Resume session</button>}<button type="button" className="btn btn-secondary btn-sm" onClick={()=>setSessionView('terminal')}>Open Terminal</button></div>}
                  {details.session.handoff && <HandoffNotice key={`${projectId}:${node.id}`} projectId={projectId} nodeId={node.id} info={details.session.handoff} onRefresh={onRefresh} />}
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
                    <ProviderActivity node={selectedNode?.id === node.id ? selectedNode : node} />
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
                          if(canInterrupt)void handleInterrupt();else void handleSendMessage();
                        }}
                      >
                        <MessageAttachments
                          iconOnly
                          files={chatFiles}
                          onChange={setChatFiles}
                          disabled={chatSending}
                          renderControls={(attachButton) => (
                            <div className="message-composer-actions">
                              <div className="message-attachment-controls">
                                {attachButton}
                              </div>
                              {projectId && <AgentChatControls projectId={projectId} nodeId={node.id} runId={selectedRunId ?? null} model={node.model} effort={node.effort} disabled={chatSending || isClosing || ['working', 'waiting', 'blocked'].includes(node.state)} />}
                              <DictationButton iconOnly key={`dictation:${projectId}:${node.id}:${selectedRunId ?? ''}`} disabled={chatSending || isClosing}
                                onText={(text) => setChatMessage((draft) => appendDictation(draft, text))} onActiveChange={setDictating} />
                              <button
                                type="submit"
                                className="btn btn-primary btn-sm btn-chat-send"
                                aria-label={canInterrupt ? 'Interrupt agent' : chatSending ? 'Sending message' : 'Send message'} title={canInterrupt?'Interrupt agent':'Send message'}
                                disabled={chatSending || dictating || (canInterrupt&&interruptRequested) || (!canInterrupt && !chatMessage.trim() && !chatFiles.length)}
                              >
                                {canInterrupt ? <span aria-hidden="true" className="agent-stop-symbol"/> : chatSending ? <RefreshIcon busy size={18}/> : <Icon name="arrow-up" size={19}/>}
                              </button>
                            </div>
                          )}
                        >
                          <textarea
                            className="chatbox-textarea"
                            placeholder={`Message ${node.label}…`}
                            aria-label={`Message ${node.label}`}
                            title="Enter to send, Shift+Enter for a new line"
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
      {handoff.present && projectId && node?.kind === 'agent' && <HandoffDialog key={`${projectId}:${node.id}`} projectId={projectId} node={node} closing={handoff.closing} onClose={handoff.close} onStarted={id => { onSessionChange?.(); onOpenSession?.(id); }} />}
      <ConfirmationDialog isOpen={workflowConfirmation.present} isClosing={workflowConfirmation.closing} title="Workflow enabled"
        description={WORKFLOW_CONFIRMATION_MESSAGE} confirmLabel="Continue with workflow" confirmVariant="primary" isConfirming={chatSending}
        onClose={workflowConfirmation.close} onConfirm={() => { const pending = workflowConfirmation.data; workflowConfirmation.close(); if (pending) void handleSendMessage(true, pending); }} />
    </>
  );
};
