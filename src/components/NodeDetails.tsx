import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { NodeDetails as NodeDetailsType } from '../../shared/contracts';
import { ProviderIcon } from './ProviderIcon';
import { latestAgentMessage } from '../conversation';
import { RefreshIcon } from './RefreshIcon';
import { LatestMessageCard } from './LatestMessageCard';

interface NodeDetailsProps {
  details: NodeDetailsType | null;
  loading: boolean;
  error: string | null;
  selectedNodeId: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onCheckNewerMessages: () => void;
}

export const NodeDetails: React.FC<NodeDetailsProps> = ({
  details,
  loading,
  error,
  selectedNodeId,
  onClose,
  onRefresh,
  onCheckNewerMessages,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const restoredRef = useRef<boolean>(false);

  // Expanded message IDs for local read more/less
  const [expandedMsgIds, setExpandedMsgIds] = useState<Set<string>>(new Set());
  const [isClosing, setIsClosing] = useState<boolean>(false);
  const closingTimerRef = useRef<number | null>(null);

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
              <div className="modal-section facts-section">
                <h3 className="section-title">Status & Workspace</h3>
                <div className="facts-panel">
                  <div className="facts-metadata-row">
                    <div className="fact-col">
                      <span className="fact-field-label">State</span>
                      <div className="fact-field-value font-semibold">
                        {node.state}
                        {node.rawState && node.rawState !== node.state && (
                          <span className="fact-field-sub font-mono text-xs text-muted ml-1">
                            ({node.rawState})
                          </span>
                        )}
                      </div>
                    </div>
                    {node.workspaceStatus && (
                      <div className="fact-col">
                        <span className="fact-field-label">Workspace</span>
                        <div className="fact-field-value font-mono">{node.workspaceStatus}</div>
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
                      <div className="facts-path-code font-mono text-xs" title={node.path}>
                        {node.path}
                      </div>
                    </div>
                  )}

                  <div className="facts-timestamps-row">
                    <div className="fact-timestamp-item">
                      <span className="fact-field-label">Observed</span>
                      <span className="fact-field-value font-mono text-xs">{formatIso(node.observedAt)}</span>
                    </div>
                    {node.lastActivityAt && (
                      <div className="fact-timestamp-item">
                        <span className="fact-field-label">Last Activity</span>
                        <span className="fact-field-value font-mono text-xs">{formatIso(node.lastActivityAt)}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {!isWorktree && (
                <div className="modal-section latest-message-section">
                  <h3 className="section-title">Latest Agent Message</h3>
                  {latestReply ? <LatestMessageCard key={latestReply.id} message={latestReply} stale={Boolean(convMeta?.stale)} />
                    : <p className="text-xs text-muted">{convMeta?.availability === 'unsupported' || convMeta?.availability === 'unavailable'
                    ? 'Agent message unavailable from this conversation source.' : 'No agent reply in recent history.'}</p>}
                </div>
              )}

              {/* Current Tool Activity (agents only) */}
              {!isWorktree && currentTool && (
                <div className="modal-section tool-section">
                  <h3 className="section-title">Current Tool Activity</h3>
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
              )}

              {/* Conversation Section (agents only) */}
              {!isWorktree && (
                <div className="modal-section conversation-section">
                  <div className="section-header-row">
                    <div className="conv-title-group">
                      <h3 className="section-title">Conversation History</h3>
                      <span className="text-xs text-muted font-normal ml-2">
                        (Agent turns left, User turns right)
                      </span>
                    </div>
                  </div>

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
                        const displayText = isLong && !isExpanded
                          ? msg.text.slice(0, 800) + '…'
                          : msg.text;

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

                              <div className="chat-bubble-text whitespace-pre-wrap">
                                {displayText}
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
              )}
            </>
          )}
        </div>
      </div>
    </dialog>
  );
};
