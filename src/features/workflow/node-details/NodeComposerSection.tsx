import React from 'react';
import type { Node, Subagent } from '../../../../shared/contracts';
import { Icon } from '../../../components/ui/Icon';
import { RefreshIcon } from '../../../components/ui/RefreshIcon';
import { SubagentTray } from '../chat/SubagentTray';
import { AgentInteraction } from '../chat/AgentInteraction';
import { MessageAttachments } from '../chat/MessageAttachments';
import { AgentPermissionControl } from '../chat/AgentPermissionControl';
import { AgentChatControls } from '../chat/AgentChatControls';
import { ContextUsageMeter } from '../chat/ContextUsageMeter';
import { DictationButton } from '../voice/DictationButton';
import { appendDictation } from '../voice/dictation';
import { ComposerReferenceMenu } from '../chat/ComposerReferenceMenu';
import type { ComposerEntry } from '../chat/composerCommands';

interface NodeComposerSectionProps {
  projectId: string | null;
  selectedRunId: string | null | undefined;
  node: Node;
  sessionChatEnabled: boolean;
  isClosing: boolean;
  chatMessage: string;
  setChatMessage: React.Dispatch<React.SetStateAction<string>>;
  chatFiles: File[];
  setChatFiles: (files: File[]) => void;
  chatSending: boolean;
  dictating: boolean;
  setDictating: (dictating: boolean) => void;
  chatStatus: { type: 'success' | 'error'; text: string } | null;
  canInterrupt: boolean;
  interruptRequested: boolean;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
  referenceOpen: boolean;
  referenceEntries: ComposerEntry[];
  activeReference: number;
  skillsLoading: boolean;
  skillsError: string | null;
  referencePrefixes: readonly ('/' | '$')[];
  referenceTrigger: { prefix: '/' | '$'; query: string } | null;
  setReferenceIndex: React.Dispatch<React.SetStateAction<number>>;
  setDismissedReference: (val: string | null) => void;
  selectReference: (index: number) => void;
  chatControlsRequest: { id: number; section: 'model' | 'effort' } | null;
  clearChatControlsRequest: () => void;
  contextRequest: number | null;
  clearContextRequest: () => void;
  onOpenSubagent: (subagent: Subagent) => void;
  onSwitchToTerminal: () => void;
  onSendMessage: () => void;
  onInterrupt: () => void;
}

export const NodeComposerSection: React.FC<NodeComposerSectionProps> = ({
  projectId,
  selectedRunId,
  node,
  sessionChatEnabled,
  isClosing,
  chatMessage,
  setChatMessage,
  chatFiles,
  setChatFiles,
  chatSending,
  dictating,
  setDictating,
  chatStatus,
  canInterrupt,
  interruptRequested,
  composerRef,
  referenceOpen,
  referenceEntries,
  activeReference,
  skillsLoading,
  skillsError,
  referencePrefixes,
  referenceTrigger,
  setReferenceIndex,
  setDismissedReference,
  selectReference,
  chatControlsRequest,
  clearChatControlsRequest,
  contextRequest,
  clearContextRequest,
  onOpenSubagent,
  onSwitchToTerminal,
  onSendMessage,
  onInterrupt,
}) => (
  <div className="modal-section agent-chatbox-section">
    {projectId && node.subagents && (
      <SubagentTray
        key={`${projectId}:${node.id}`}
        projectId={projectId}
        nodeId={node.id}
        provider={node.agentType}
        subagents={node.subagents}
        onOpen={onOpenSubagent}
      />
    )}
    {projectId && sessionChatEnabled && (
      <AgentInteraction
        key={`${projectId}:${node.id}`}
        projectId={projectId}
        nodeId={node.id}
        waiting={node.state === 'waiting'}
        onTerminal={onSwitchToTerminal}
      />
    )}
    {chatStatus?.type === 'error' && (
      <div className="section-header-row">
        {chatStatus && (
          <span
            className={`chat-status-badge text-xs font-mono font-semibold ${chatStatus.type === 'error' ? 'text-danger' : 'text-success'}`}
          >
            {chatStatus.text}
          </span>
        )}
      </div>
    )}
    <div className="node-details-chatbox">
      <form
        className="chatbox-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (canInterrupt) void onInterrupt();
          else void onSendMessage();
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
                {projectId && (
                  <AgentPermissionControl
                    key={`permission:${projectId}:${node.id}`}
                    projectId={projectId}
                    nodeId={node.id}
                    runId={selectedRunId ?? null}
                    disabled={
                      chatSending ||
                      dictating ||
                      isClosing ||
                      Boolean(chatMessage.trim()) ||
                      chatFiles.length > 0 ||
                      ['working', 'waiting', 'blocked'].includes(node.state)
                    }
                  />
                )}
              </div>
              {projectId && (
                <AgentChatControls
                  projectId={projectId}
                  nodeId={node.id}
                  runId={selectedRunId ?? null}
                  model={node.model}
                  effort={node.effort}
                  disabled={chatSending || isClosing || ['working', 'waiting', 'blocked'].includes(node.state)}
                  openRequest={chatControlsRequest}
                  onOpenRequestHandled={clearChatControlsRequest}
                />
              )}
              {projectId && (
                <ContextUsageMeter
                  key={`context:${projectId}:${node.id}:${selectedRunId ?? ''}`}
                  projectId={projectId}
                  nodeId={node.id}
                  runId={selectedRunId ?? null}
                  provider={node.agentType}
                  usage={node.contextUsage}
                  openRequest={contextRequest}
                  onOpenRequestHandled={clearContextRequest}
                />
              )}
              <DictationButton
                iconOnly
                key={`dictation:${projectId}:${node.id}:${selectedRunId ?? ''}`}
                disabled={chatSending || isClosing}
                onText={(text) => setChatMessage((draft) => appendDictation(draft, text))}
                onActiveChange={setDictating}
              />
              <button
                type="submit"
                className="btn btn-primary btn-sm btn-chat-send"
                aria-label={canInterrupt ? 'Interrupt agent' : chatSending ? 'Sending message' : 'Send message'}
                title={canInterrupt ? 'Interrupt agent' : 'Send message'}
                disabled={
                  chatSending ||
                  dictating ||
                  (canInterrupt && interruptRequested) ||
                  (!canInterrupt && !chatMessage.trim() && !chatFiles.length)
                }
              >
                {canInterrupt ? (
                  <span aria-hidden="true" className="agent-stop-symbol" />
                ) : chatSending ? (
                  <RefreshIcon busy size={18} />
                ) : (
                  <Icon name="arrow-up" size={19} />
                )}
              </button>
            </div>
          )}
        >
          {referenceOpen && (
            <ComposerReferenceMenu
              entries={referenceEntries}
              activeIndex={activeReference}
              loading={skillsLoading}
              error={skillsError}
              emptyMessage={referenceTrigger?.prefix === '$' ? 'No installed skills match.' : 'No matching commands.'}
              onHover={setReferenceIndex}
              onSelect={(entry) => selectReference(referenceEntries.indexOf(entry))}
            />
          )}
          <textarea
            ref={composerRef}
            className="chatbox-textarea"
            placeholder={`Message ${node.label}…`}
            aria-label={`Message ${node.label}`}
            title={
              referencePrefixes.length > 1
                ? 'Enter to send, Shift+Enter for a new line. Type / for commands, $ for skills.'
                : 'Enter to send, Shift+Enter for a new line. Type / for commands and skills.'
            }
            value={chatMessage}
            role="combobox"
            aria-expanded={referenceOpen}
            aria-controls={referenceOpen ? 'composer-reference-list' : undefined}
            aria-activedescendant={
              referenceOpen && activeReference >= 0 ? `composer-reference-${activeReference}` : undefined
            }
            aria-autocomplete={referenceOpen ? 'list' : undefined}
            onChange={(e) => setChatMessage(e.target.value)}
            onKeyDown={(e) => {
              if (referenceOpen && referenceEntries.length && !e.nativeEvent.isComposing) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const step = e.key === 'ArrowDown' ? 1 : -1;
                  setReferenceIndex(
                    (current) =>
                      (Math.min(current, referenceEntries.length - 1) + step + referenceEntries.length) %
                      referenceEntries.length
                  );
                  return;
                }
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                  e.preventDefault();
                  selectReference(activeReference);
                  return;
                }
              }
              if (e.key === 'Escape' && referenceOpen) {
                e.preventDefault();
                setDismissedReference(referenceTrigger?.query ?? '');
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSendMessage();
              }
            }}
            rows={3}
            disabled={chatSending}
          />
        </MessageAttachments>
        {chatFiles.length > 0 && ['codebuddy', 'opencode', 'opencode2', 'kilo'].includes(node.agentType ?? '') && (
          <p className="text-muted text-xs">
            {node.agentType === 'codebuddy'
              ? 'Files are sent as local file references for CodeBuddy to read.'
              : 'Images and PDFs use native attachments. Other files are sent as local file references.'}
          </p>
        )}
      </form>
    </div>
  </div>
);
