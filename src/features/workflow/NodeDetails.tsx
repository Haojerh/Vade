import React, { useRef, useEffect, useState, useCallback, useId, useLayoutEffect } from 'react';
import type { NodeDetails as NodeDetailsType, Task } from '../../../shared/contracts';
import { ProviderIcon } from '../../components/providers/ProviderIcon';
import { latestAgentMessage } from './conversation';
import { RefreshIcon } from '../../components/ui/RefreshIcon';
import { LatestMessageCard } from './LatestMessageCard';
import { MessageMarkdown } from './MessageMarkdown';
import { sendNodeMessage } from '../../api/client';

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
  onClose: () => void;
  onRefresh: () => void;
  onCheckNewerMessages: () => void;
  visibleSections?: NodeDetailsVisibleSections;
}

function TaskCard({ task }: { task: Task }) {
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

export const NodeDetails: React.FC<NodeDetailsProps> = ({
  projectId,
  details,
  loading,
  error,
  selectedNodeId,
  onClose,
  onRefresh,
  onCheckNewerMessages,
  visibleSections,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const restoredRef = useRef<boolean>(false);

  const [expandedMsgIds, setExpandedMsgIds] = useState<Set<string>>(new Set());
  const [isClosing, setIsClosing] = useState<boolean>(false);
  const closingTimerRef = useRef<number | null>(null);

  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [chatMessage, setChatMessage] = useState<string>('');
  const [chatSending, setChatSending] = useState<boolean>(false);
  const [chatStatus, setChatStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const activeVisibleSections = visibleSections ?? DEFAULT_VISIBLE_SECTIONS;

  const toggleSection = (key: string) => {
    setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSendMessage = async () => {
    if (!projectId || !details?.node || !chatMessage.trim() || chatSending) return;
    setChatSending(true);
    setChatStatus(null);
    try {
      await sendNodeMessage(projectId, details.node.id, chatMessage.trim());
      setChatStatus({ type: 'success', text: 'Message sent!' });
      setChatMessage('');
      setTimeout(() => setChatStatus(null), 3000);
      onCheckNewerMessages();
    } catch (err: any) {
      setChatStatus({ type: 'error', text: err?.message || 'Failed to send message' });
    } finally {
      setChatSending(false);
    }
  };

  useEffect(() => {
    return () => {
      if (closingTimerRef.current !== null) {
        window.clearTimeout(closingTimerRef.current);
      }
    };
  }, []);

  // Reliable focus restoration to opener or stable topbar fallback (idempotent)
  const restoreFocus = useCallback(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    const opener = openerRef.current;
    openerRef.current = null;

    if (opener && document.contains(opener)) {
      try {
        opener.focus();
        return;
      } catch {
        // Fall back to header
      }
    }

    // Stable fallback: first focusable element in topbar only if opener is gone
    const fallback = document.querySelector<HTMLElement>(
      '.dashboard-topbar .btn-sidebar-reopen, .dashboard-topbar button, .dashboard-topbar select'
    );
    if (fallback) {
      try {
        fallback.focus();
        return;
      } catch {
        // ignore
      }
    }
  }, []);

  // Store opener on fresh open, restore focus on unmount / selection clearing
  useEffect(() => {
    if (selectedNodeId) {
      restoredRef.current = false;
      if (!openerRef.current) {
        openerRef.current = document.activeElement as HTMLElement | null;
      }
    }
    return () => {
      if (selectedNodeId) {
        restoreFocus();
      }
    };
  }, [selectedNodeId, restoreFocus]);

  // Open native dialog with showModal()
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (selectedNodeId && !dialog.open) {
      setIsClosing(false);
      try {
        dialog.showModal();
      } catch {
        // If already open or showModal unsupported
      }
    }
  }, [selectedNodeId]);

  const handleClose = useCallback(() => {
    if (isClosing) return;
    const dialog = dialogRef.current;
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (prefersReducedMotion || !dialog || !dialog.open) {
      if (dialog && dialog.open) {
        try {
          dialog.close();
        } catch {
          // ignore
        }
      }
      onClose();
      return;
    }

    setIsClosing(true);
    closingTimerRef.current = window.setTimeout(() => {
      setIsClosing(false);
      closingTimerRef.current = null;
      if (dialog && dialog.open) {
        try {
          dialog.close();
        } catch {
          // ignore
        }
      }
      onClose();
    }, 150);
  }, [isClosing, onClose]);

  // Trap focus within dialog and handle Escape
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDialogElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
        return;
      }

      if (e.key === 'Tab') {
        const dialog = dialogRef.current;
        if (!dialog) return;

        const focusableElements = dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );

        if (focusableElements.length === 0) return;

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstElement) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          if (document.activeElement === lastElement) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    },
    [handleClose],
  );

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

  const node = details?.node;
  const currentTool = details?.currentTool;
  const conversation = details?.conversation;
  const convData = conversation?.data;
  const convMeta = conversation?.meta;
  const messages = convData?.messages ?? [];
  const latestReply = latestAgentMessage(messages);
  const hasNewerCursor = Boolean(convData?.nextCursor && convData.nextCursor !== convData.cursor);
  const isWorktree = node?.kind === 'worktree';
  const assignedTasks = (details?.tasks ?? []).filter(
    (t) => t.assigneeNodeId === node?.id || (node?.taskIds && node.taskIds.includes(t.id))
  );

  return (
    <dialog
      ref={dialogRef}
      className={`node-modal-dialog ${isClosing ? 'is-closing' : ''}`}
      aria-labelledby="dialog-node-title"
      aria-describedby="dialog-node-desc"
      onClick={(e) => {
        if (e.target === dialogRef.current) {
          handleClose();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        handleClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="modal-dialog-container">
        {/* Modal Header */}
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
              onClick={handleClose}
              aria-label="Close dialog"
              title="Close dialog"
            >
              ✕
            </button>
          </div>
        </header>

        {/* Modal Scrollable Body */}
        <div className="modal-dialog-body">
          {loading && !details && (
            <div className="modal-loading-state" role="status">
              <div className="skeleton-line" />
              <div className="skeleton-line short" />
              <div className="skeleton-line" />
            </div>
          )}

          {error && (
            <div className="panel-alert alert-error" role="alert">
              <span className="font-semibold">
                {details ? 'Error refreshing node details:' : 'Error loading node details:'}
              </span>{' '}
              {error}
            </div>
          )}

          {details && node && (
            <>
              {/* Status & Location Facts */}
              {activeVisibleSections.status && (
                <div className="modal-section facts-section">
                  <div className="section-header-row">
                    <button
                      type="button"
                      className="section-title-btn"
                      onClick={() => toggleSection('status')}
                      aria-expanded={!collapsedSections['status']}
                      aria-label={`${collapsedSections['status'] ? 'Expand' : 'Collapse'} Status & Workspace section`}
                    >
                      <h3 className="section-title">Status & Workspace</h3>
                      <svg
                        className={`section-chevron-icon ${collapsedSections['status'] ? 'is-collapsed' : ''}`}
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  </div>

                  <div className={`section-collapsible-body ${collapsedSections['status'] ? 'is-collapsed' : ''}`}>
                    <div className="section-collapsible-inner">
                      <div className="facts-panel">
                        <div className="facts-metadata-row">
                          <div className="fact-col">
                            <span className="fact-field-label">State</span>
                            <div className="fact-field-value facts-state-value">
                              <span className={`node-badge-state state-${node.state}`}>{node.state}</span>
                              {node.rawState && node.rawState !== node.state && (
                                <span className="fact-field-sub text-xs text-muted">
                                  ({node.rawState})
                                </span>
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
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" /></svg>
                              <code>{node.path}</code>
                            </div>
                          </div>
                        )}

                        <div className="facts-timestamps-row">
                          <div className="fact-timestamp-item">
                            <span className="fact-field-label">Observed</span>
                            <time className="fact-field-value font-mono" dateTime={node.observedAt || undefined} title={node.observedAt ? new Date(node.observedAt).toLocaleString() : undefined}>{formatIso(node.observedAt)}</time>
                          </div>
                          {node.lastActivityAt && (
                            <div className="fact-timestamp-item">
                              <span className="fact-field-label">Last Activity</span>
                              <time className="fact-field-value font-mono" dateTime={node.lastActivityAt} title={new Date(node.lastActivityAt).toLocaleString()}>{formatIso(node.lastActivityAt)}</time>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Assigned Tasks (agents only, below status & workspace if exists) */}
              {activeVisibleSections.tasks && !isWorktree && assignedTasks.length > 0 && (
                <div className="modal-section assigned-tasks-section">
                  <div className="section-header-row">
                    <button
                      type="button"
                      className="section-title-btn"
                      onClick={() => toggleSection('tasks')}
                      aria-expanded={!collapsedSections['tasks']}
                      aria-label={`${collapsedSections['tasks'] ? 'Expand' : 'Collapse'} Assigned Tasks section`}
                    >
                      <h3 className="section-title">Assigned Tasks</h3>
                      <span className="badge badge-neutral text-xs font-mono">{assignedTasks.length}</span>
                      <svg
                        className={`section-chevron-icon ${collapsedSections['tasks'] ? 'is-collapsed' : ''}`}
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  </div>
                  <div className={`section-collapsible-body ${collapsedSections['tasks'] ? 'is-collapsed' : ''}`}>
                    <div className="section-collapsible-inner">
                      <div className="assigned-tasks-list">
                        {assignedTasks.map((t) => (
                          <TaskCard key={t.id} task={t} />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeVisibleSections.latest && !isWorktree && (
                <div className="modal-section latest-message-section">
                  <div className="section-header-row">
                    <button
                      type="button"
                      className="section-title-btn"
                      onClick={() => toggleSection('latest')}
                      aria-expanded={!collapsedSections['latest']}
                      aria-label={`${collapsedSections['latest'] ? 'Expand' : 'Collapse'} Latest Agent Message section`}
                    >
                      <h3 className="section-title">Latest Agent Message</h3>
                      <svg
                        className={`section-chevron-icon ${collapsedSections['latest'] ? 'is-collapsed' : ''}`}
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  </div>
                  <div className={`section-collapsible-body ${collapsedSections['latest'] ? 'is-collapsed' : ''}`}>
                    <div className="section-collapsible-inner">
                      {latestReply ? <LatestMessageCard key={latestReply.id} message={latestReply} stale={Boolean(convMeta?.stale)} />
                        : <p className="text-xs text-muted">{convMeta?.availability === 'unsupported' || convMeta?.availability === 'unavailable'
                        ? 'Agent message unavailable from this conversation source.' : 'No agent reply in recent history.'}</p>}
                    </div>
                  </div>
                </div>
              )}

              {/* Current Tool Activity (agents only) */}
              {activeVisibleSections.tool && !isWorktree && currentTool && (
                <div className="modal-section tool-section">
                  <div className="section-header-row">
                    <button
                      type="button"
                      className="section-title-btn"
                      onClick={() => toggleSection('tool')}
                      aria-expanded={!collapsedSections['tool']}
                      aria-label={`${collapsedSections['tool'] ? 'Expand' : 'Collapse'} Current Tool Activity section`}
                    >
                      <h3 className="section-title">Current Tool Activity</h3>
                      <svg
                        className={`section-chevron-icon ${collapsedSections['tool'] ? 'is-collapsed' : ''}`}
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  </div>
                  <div className={`section-collapsible-body ${collapsedSections['tool'] ? 'is-collapsed' : ''}`}>
                    <div className="section-collapsible-inner">
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
                    </div>
                  </div>
                </div>
              )}

              {/* Conversation Section (agents only) */}
              {activeVisibleSections.conversation && !isWorktree && (
                <div className="modal-section conversation-section">
                  <div className="section-header-row">
                    <button
                      type="button"
                      className="section-title-btn"
                      onClick={() => toggleSection('conversation')}
                      aria-expanded={!collapsedSections['conversation']}
                      aria-label={`${collapsedSections['conversation'] ? 'Expand' : 'Collapse'} Conversation History section`}
                    >
                      <h3 className="section-title">Conversation History</h3>
                      <svg
                        className={`section-chevron-icon ${collapsedSections['conversation'] ? 'is-collapsed' : ''}`}
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  </div>

                  <div className={`section-collapsible-body ${collapsedSections['conversation'] ? 'is-collapsed' : ''}`}>
                    <div className="section-collapsible-inner">
                      {/* Section Meta Alerts */}
                      {convMeta?.issue && (
                        <div className="panel-alert alert-error mb-3" role="alert">
                          <span className="font-semibold">[{convMeta.issue.code}]:</span>{' '}
                          {convMeta.issue.message}
                        </div>
                      )}

                      {convMeta?.availability === 'unsupported' && !convMeta.issue && (
                        <div className="panel-alert alert-info mb-3">
                          Conversation source is unsupported for this node. Unmanaged or coordinator sessions have no structured transcript.
                        </div>
                      )}

                      {/* Messages List */}
                      {messages.length === 0 ? (
                        <div className="empty-hint">
                          {convMeta?.availability === 'empty'
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

                                  <div className={`chat-bubble-text message-markdown ${isLong && !isExpanded ? 'message-collapsed' : ''}`}>
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

                      {/* Check for newer messages button */}
                      {hasNewerCursor && (
                        <div className="conv-actions-footer mt-3">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={onCheckNewerMessages}
                            disabled={loading}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="7 13 12 18 17 13" />
                              <polyline points="7 6 12 11 17 6" />
                            </svg>
                            <span>Check for newer messages</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Chatbox to send message to agent (at bottom most below convo history) */}
              {activeVisibleSections.chatbox && !isWorktree && (
                <div className="modal-section agent-chatbox-section">
                  <div className="section-header-row">
                    <h3 className="section-title">Message Agent</h3>
                    {chatStatus && (
                      <span className={`chat-status-badge text-xs font-mono font-semibold ${chatStatus.type === 'error' ? 'text-danger' : 'text-success'}`}>
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
                      <div className="chatbox-actions-row flex justify-end items-center mt-2">
                        <button
                          type="submit"
                          className="btn btn-primary btn-sm btn-chat-send"
                          disabled={chatSending || !chatMessage.trim()}
                        >
                          {chatSending ? (
                            <span>Sending...</span>
                          ) : (
                            <>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <line x1="22" y1="2" x2="11" y2="13" />
                                <polygon points="22 2 15 22 11 13 2 9 22 2" />
                              </svg>
                              <span>Send</span>
                            </>
                          )}
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              )}

              {/* Hint when all sections are hidden */}
              {!activeVisibleSections.status &&
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
    </dialog>
  );
};
