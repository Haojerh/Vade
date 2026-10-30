import { Modal } from '../../../components/ui/Modal';
import React, { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Node, NodeDetails as NodeDetailsType, AgentSkillSummary } from '../../../../shared/contracts';
import { Icon } from '../../../components/ui/Icon';
const ConversationHistory = lazy(() => import('../chat/ConversationHistory').then(module => ({ default: module.ConversationHistory })));
import { ConversationToolCall } from '../chat/ConversationToolCall';
import { ProviderActivity } from '../chat/ProviderActivity';
import { SubagentDetailsDialog } from '../chat/SubagentTray';
import { useAgentDraft } from '../../../hooks/agents/useAgentDraft';
import { WORKFLOW_CONFIRMATION_MESSAGE } from '../../../../shared/contracts';
import { ConfirmationDialog } from '../../../components/ui/ConfirmationDialog';
import { sendNodeMessage, interruptAgent, openChatTerminal, resumeTerminal, openNativeRewindPicker, fetchAgentSkills, compactConversation } from '../../../api/client';
import { useConfirmationState } from '../../../hooks/ui/useConfirmationState';
import { ConversationRewind } from '../chat/ConversationRewind';
import { applySkillReference, composerEntries, composerPrefix, composerPrefixes, composerTrigger } from '../chat/composerCommands';
import { HandoffDialog, HandoffNotice } from './HandoffDialog';
import { readAgentView } from '../../../app/agentViewPreference';
const AgentTerminal = lazy(() => import('../terminal/AgentTerminal').then(module => ({ default: module.AgentTerminal })));
import {
  NodeDetailsHeader,
  NodeDetailsActionDialogs,
  useNodeDetailsActions,
} from './NodeDetailsParts';
import { WorktreeDetailsSection } from './WorktreeDetailsSection';
import { NodeComposerSection } from './NodeComposerSection';

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
  onConversationVisibilityChange?: (visible: boolean) => void;
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
  onConversationVisibilityChange,
  onOpenSession,
  handoffEnabled = false,
  visibleSections,
  commitGraphEnabled = false,
  chatToolCallsEnabled = true,
}) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [showBackToBottom, setShowBackToBottom] = useState(false);
  const [sessionView, setSessionView] = useState<'chat' | 'terminal'>(readAgentView);
  useEffect(() => {
    onConversationVisibilityChange?.(Boolean(selectedNodeId) && sessionView === 'chat' && visibleSections?.conversation !== false);
    return () => onConversationVisibilityChange?.(false);
  }, [selectedNodeId, sessionView, visibleSections?.conversation, onConversationVisibilityChange]);
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
  const [openSubagent, setOpenSubagent] = useState<import('../../../../shared/contracts').Subagent | null>(null);
  // Composer references: a leading `/` (or `$` on Codex) lists Chat commands and skills.
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [skills, setSkills] = useState<AgentSkillSummary[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [referenceIndex, setReferenceIndex] = useState(0);
  const [dismissedReference, setDismissedReference] = useState<string | null>(null);
  const [chatControlsRequest, setChatControlsRequest] = useState<{ id: number; section: 'model' | 'effort' } | null>(null);
  const [contextRequest, setContextRequest] = useState<number | null>(null);
  const referenceRequest = useRef(0);
  const clearChatControlsRequest = React.useCallback(() => setChatControlsRequest(null), []);
  const clearContextRequest = React.useCallback(() => setContextRequest(null), []);
  const workflowConfirmation = useConfirmationState<{ message: string; files: File[] }>();
  const handoff = useConfirmationState();
  const chatRequest = useRef<AbortController | null>(null);
  const chatTarget = useRef(''); chatTarget.current = `${projectId}:${selectedNodeId}`;
  const [chatTerminal,setChatTerminal]=useState<import('../../../../shared/contracts').TerminalPage|null>(null);
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
  const detailsNode=isMatchingDetails?details!.node:null, snapshotNode=selectedNode?.id===selectedNodeId?selectedNode:null;
  const statusObservedAt=(value:Node)=>Date.parse(value.agentStatus?.meta.observedAt??value.observedAt??'')||0;
  const baseNode=detailsNode&&snapshotNode ? statusObservedAt(snapshotNode)>statusObservedAt(detailsNode)||statusObservedAt(snapshotNode)===statusObservedAt(detailsNode)&&Date.parse(snapshotNode.observedAt??'')>Date.parse(detailsNode.observedAt??'')?snapshotNode:detailsNode : detailsNode??snapshotNode;
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
  const referencePrefixes = composerPrefixes(node?.agentType);
  const referencePrefix = composerPrefix(node?.agentType);
  const referenceTrigger = composerTrigger(chatMessage, referencePrefixes);
  const referenceOpen = Boolean(referenceTrigger && referenceTrigger.query !== dismissedReference && !chatSending && !isClosing);
  const referenceEntries = referenceTrigger && referenceOpen ? composerEntries(referenceTrigger, skills, node?.agentType, { compact: node?.chatCompact === true }) : [];
  const activeReference = referenceEntries.length ? Math.min(referenceIndex, referenceEntries.length - 1) : -1;
  // One shared read per composer, tracked in a ref: closing the menu must never abort
  // the read and strand the list on "Loading skills…".
  const skillsRequest = useRef({ requested: false, loading: false });
  const loadSkills = React.useCallback(() => {
    const state = skillsRequest.current;
    if (state.requested || state.loading) return;
    state.requested = true;
    state.loading = true;
    setSkillsLoading(true);
    fetchAgentSkills().then(section => {
      setSkills(section.data ?? []);
      setSkillsError(section.meta.issue?.message ?? (section.meta.stale ? 'Installed skills may be out of date.' : null));
    }).catch(reason => {
      // A failed read stays retryable the next time the menu opens.
      state.requested = false;
      setSkillsError(reason instanceof Error ? reason.message : 'Unable to read installed skills.');
    }).finally(() => { state.loading = false; setSkillsLoading(false); });
  }, []);
  useEffect(() => { if (referenceOpen) loadSkills(); }, [referenceOpen, loadSkills]);
  useEffect(() => { setReferenceIndex(0); }, [referenceTrigger?.query, referencePrefix]);
  const selectReference = (index: number) => {
    const entry = referenceEntries[index];
    if (!entry) return;
    setDismissedReference(null);
    setReferenceIndex(0);
    if (entry.kind === 'skill') {
      // A skill reference stays in the draft so the provider's own resolver sees it.
      setChatMessage(applySkillReference(entry.token));
      setChatStatus(null);
      composerRef.current?.focus();
      return;
    }
    setChatMessage('');
    setChatStatus(null);
    if (entry.command === 'context') {
      if (node?.contextUsage?.usedTokens == null) {
        setChatStatus({ type: 'error', text: 'No native context reading is available for this session yet.' });
        return;
      }
      referenceRequest.current += 1;
      setContextRequest(referenceRequest.current);
      return;
    }
    if (entry.command === 'compact') {
      void compactConversationNow();
      return;
    }
    referenceRequest.current += 1;
    setChatControlsRequest({ id: referenceRequest.current, section: entry.command });
  };
  /** `/compact` submits the provider's own compaction command. The result is reported
   *  exactly as the backend observed it; an unconfirmed submission is a warning, never
   *  a success, and nothing is replayed. */
  const compacting = useRef(false);
  const compactConversationNow = async () => {
    if (!projectId || !node || compacting.current) return;
    if (node.chatCompact !== true) {
      setChatStatus({ type: 'error', text: 'This provider has no verified native compaction command.' });
      return;
    }
    if (node.liveness !== 'live') {
      setChatStatus({ type: 'error', text: 'Open Terminal and start this agent before compacting its conversation.' });
      return;
    }
    compacting.current = true;
    setChatSending(true);
    setChatStatus({ type: 'success', text: 'Compacting…' });
    const owner = chatTarget.current;
    try {
      const result = await compactConversation(projectId, node.id);
      if (owner !== chatTarget.current) return;
      setChatStatus(result.ok
        ? { type: 'success', text: result.message ?? 'Compaction started.' }
        : { type: 'error', text: result.message ?? 'Compaction was not confirmed by the provider.' });
      onRefresh();
      onSessionChange?.();
    } catch (error) {
      if (owner === chatTarget.current) setChatStatus({ type: 'error', text: error instanceof Error ? error.message : 'Compaction was not confirmed. Inspect Terminal.' });
    } finally {
      compacting.current = false;
      if (owner === chatTarget.current) setChatSending(false);
    }
  };
  const canInterrupt = Boolean(details?.session?.chat && node?.state === 'working' && node?.liveness === 'live' && !chatMessage.trim() && !chatFiles.length);
  const interrupting = useRef(false);
  const [interruptRequested,setInterruptRequested]=useState(false);
  useEffect(()=>{interrupting.current=false;setInterruptRequested(false);},[projectId,selectedNodeId,node?.state]);
  const handleInterrupt = async () => {
    if (!projectId || !node || !canInterrupt || interrupting.current) return;
    interrupting.current = true; setInterruptRequested(true);setChatSending(true);
    const owner = chatTarget.current;
    try { await interruptAgent(projectId,node.id); }
    catch (error) { if(owner===chatTarget.current) setChatStatus({type:'error',text:error instanceof Error?error.message:'Unable to interrupt. Open Terminal to check the agent.'}); }
    finally { if(owner===chatTarget.current){setChatSending(false);onRefresh();onSessionChange?.();} }
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
                {isWorktree && (
                  <WorktreeDetailsSection
                    projectId={projectId}
                    node={node}
                    commitGraphEnabled={commitGraphEnabled}
                  />
                )}

                {!isWorktree && details?.session && projectId && <>
                  {sessionView==='chat'&&(terminalError||chatTerminal&&!chatTerminal.live)&&<div className="panel-alert alert-info agent-session-notice" role="status">
                    <p className="agent-session-notice-text">{terminalError??'The agent terminal is stopped. Resume it to continue this conversation.'}</p>
                    <div className="agent-session-notice-actions">
                      {chatTerminal?.resumable&&<button type="button" className="btn btn-secondary btn-sm" disabled={openingTerminal} onClick={async()=>{const owner=chatTarget.current;setOpeningTerminal(true);try{await resumeTerminal(projectId,node.id);const page=await openChatTerminal(projectId,node.id);if(owner===chatTarget.current){setChatTerminal(page);setTerminalError(null);onSessionChange?.();}}catch(error){if(owner===chatTarget.current)setTerminalError(error instanceof Error?error.message:'Unable to resume the agent.');}finally{if(owner===chatTarget.current)setOpeningTerminal(false);}}}>{openingTerminal?'Resuming…':'Resume session'}</button>}
                      <button type="button" className="btn btn-secondary btn-sm" onClick={()=>setSessionView('terminal')}>Open Terminal</button>
                    </div>
                  </div>}
                  {details.session.handoff && <HandoffNotice key={`${projectId}:${node.id}`} projectId={projectId} nodeId={node.id} info={details.session.handoff} onRefresh={onRefresh} />}
                  {sessionView==='terminal'&&terminalError&&<div className="panel-alert alert-error" role="alert">{terminalError}</div>}
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
                      convData ? <ConversationRewind key={`${projectId}:${node.id}`} projectId={projectId!} nodeId={node.id} page={convData} disabled={chatSending||isClosing||Boolean(chatMessage.trim())||chatFiles.length>0||['working','waiting','blocked'].includes(node.state)} onNativeRewind={()=>{const owner=chatTarget.current;setSessionView('terminal');setTerminalError(null);void openNativeRewindPicker(projectId!,node.id).catch(error=>{if(owner===chatTarget.current)setTerminalError(error instanceof Error?error.message:'Unable to open native rewind.');});}} onRewound={message=>{setChatMessage(message);setChatFiles([]);onRefresh();onSessionChange?.();}}><Suspense fallback={<p role="status">Loading conversation…</p>}><ConversationHistory key={`${projectId}:${selectedNodeId}:${selectedRunId}:${convData?.sourceIdentity}`} projectId={projectId!} nodeId={selectedNodeId} runId={selectedRunId ?? null} page={convData} active={node.liveness==='live'&&['working','waiting','blocked'].includes(node.state)} tools={tools} scrollContainerRef={bodyRef} /></Suspense></ConversationRewind> : <div className="conversation-thread">{tools.map(tool => <ConversationToolCall key={tool.id} tool={tool} />)}</div>
                    )}
                    <ProviderActivity node={node} settledRounds={convData?.rounds} />
                  </section>
                )}

                {activeVisibleSections.chatbox && !isWorktree && (!details?.session || (sessionView === 'chat' && details.session.chat)) && (
                  <NodeComposerSection
                    projectId={projectId}
                    selectedRunId={selectedRunId}
                    node={node}
                    sessionChatEnabled={Boolean(details?.session?.chat)}
                    isClosing={isClosing}
                    chatMessage={chatMessage}
                    setChatMessage={setChatMessage}
                    chatFiles={chatFiles}
                    setChatFiles={setChatFiles}
                    chatSending={chatSending}
                    dictating={dictating}
                    setDictating={setDictating}
                    chatStatus={chatStatus}
                    canInterrupt={canInterrupt}
                    interruptRequested={interruptRequested}
                    composerRef={composerRef}
                    referenceOpen={referenceOpen}
                    referenceEntries={referenceEntries}
                    activeReference={activeReference}
                    skillsLoading={skillsLoading}
                    skillsError={skillsError}
                    referencePrefixes={referencePrefixes}
                    referenceTrigger={referenceTrigger}
                    setReferenceIndex={setReferenceIndex}
                    setDismissedReference={setDismissedReference}
                    selectReference={selectReference}
                    chatControlsRequest={chatControlsRequest}
                    clearChatControlsRequest={clearChatControlsRequest}
                    contextRequest={contextRequest}
                    clearContextRequest={clearContextRequest}
                    onOpenSubagent={setOpenSubagent}
                    onSwitchToTerminal={() => setSessionView('terminal')}
                    onSendMessage={() => void handleSendMessage()}
                    onInterrupt={() => void handleInterrupt()}
                  />
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

      <SubagentDetailsDialog projectId={projectId ?? ''} nodeId={node?.id ?? ''} provider={node?.agentType ?? null} subagent={openSubagent} onClose={() => setOpenSubagent(null)} />
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
