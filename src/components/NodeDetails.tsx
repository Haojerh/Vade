import React, { useRef, useEffect } from 'react';
import type { NodeDetails as NodeDetailsType } from '../../shared/contracts';
import { stripAnsi } from '../api';

interface NodeDetailsProps {
  details: NodeDetailsType | null;
  loading: boolean;
  error: string | null;
  selectedNodeId: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onLoadMore: () => void;
}

export const NodeDetails: React.FC<NodeDetailsProps> = ({
  details,
  loading,
  error,
  selectedNodeId,
  onClose,
  onRefresh,
  onLoadMore,
}) => {
  const terminalBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // When output lines change, scroll terminal view smoothly if desired
  }, [details?.output?.data?.lines]);

  if (!selectedNodeId) {
    return (
      <aside className="node-inspector node-inspector-empty" aria-label="Node inspector">
        <div className="inspector-empty-state">
          <svg
            className="empty-icon"
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <div className="empty-title">No Node Selected</div>
          <div className="empty-description">
            Select a node from the workflow graph to inspect its live status, assigned tasks, current tool activity, and terminal output.
          </div>
        </div>
      </aside>
    );
  }

  if (loading && !details) {
    return (
      <aside className="node-inspector" aria-label="Node inspector">
        <div className="inspector-header">
          <div className="font-mono text-muted">Loading node facts…</div>
          <button type="button" className="btn-close" onClick={onClose} aria-label="Close inspector">
            ✕
          </button>
        </div>
        <div className="inspector-loading-body">
          <div className="skeleton-line" />
          <div className="skeleton-line short" />
          <div className="skeleton-line" />
        </div>
      </aside>
    );
  }

  if (error && !details) {
    return (
      <aside className="node-inspector" aria-label="Node inspector">
        <div className="inspector-header">
          <div className="font-bold text-danger">Node Unavailable</div>
          <button type="button" className="btn-close" onClick={onClose} aria-label="Close inspector">
            ✕
          </button>
        </div>
        <div className="panel-alert alert-error">
          <span className="font-semibold">Error:</span> {error}
        </div>
      </aside>
    );
  }

  if (!details) {
    return (
      <aside className="node-inspector" aria-label="Node inspector">
        <div className="inspector-header">
          <div className="font-bold text-muted">Node Not Found</div>
          <button type="button" className="btn-close" onClick={onClose} aria-label="Close inspector">
            ✕
          </button>
        </div>
        <div className="empty-hint">
          Node {selectedNodeId} could not be resolved in the current snapshot.
        </div>
      </aside>
    );
  }

  const { node, tasks, currentTool, output } = details;
  const outputData = output?.data;
  const outputMeta = output?.meta;
  const hasNextCursor = Boolean(outputData?.nextCursor && outputData.nextCursor !== outputData.cursor);

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

  return (
    <aside className="node-inspector" aria-label={`Node details for ${node.label}`}>
      {/* Inspector Header */}
      <div className="inspector-header">
        <div className="inspector-title-group">
          <div className="inspector-kind-row">
            <span className={`node-kind-badge kind-${node.kind}`}>
              {node.kind}
            </span>
            {node.agentType && (
              <span className="agent-type-badge font-mono">
                {node.agentType}
              </span>
            )}
            <span className={`badge badge-liveness-${node.liveness}`}>
              {node.liveness}
            </span>
            {node.stale && <span className="badge badge-stale">Stale</span>}
          </div>
          <h2 className="inspector-node-label">{node.label}</h2>
          <div className="inspector-node-id font-mono text-muted">{node.id}</div>
        </div>

        <div className="inspector-actions">
          <button
            type="button"
            className="btn-icon"
            onClick={onRefresh}
            disabled={loading}
            aria-label="Refresh node facts"
            title="Refresh node facts"
          >
            <svg
              className={loading ? 'spin' : ''}
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
          </button>
          <button
            type="button"
            className="btn-close"
            onClick={onClose}
            aria-label="Close inspector"
            title="Close inspector"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="inspector-body">
        {/* Status Grid */}
        <div className="inspector-section status-section">
          <h3 className="section-title">Status & Liveness</h3>
          <div className="status-grid">
            <div className="status-item">
              <span className="status-label">State</span>
              <span className={`badge badge-state-${node.state}`}>
                {node.state}
              </span>
            </div>

            {node.rawState && node.rawState !== node.state && (
              <div className="status-item">
                <span className="status-label">Raw State</span>
                <span className="status-val font-mono">{node.rawState}</span>
              </div>
            )}

            {node.workspaceStatus && (
              <div className="status-item">
                <span className="status-label">Workspace</span>
                <span className="status-val font-mono">{node.workspaceStatus}</span>
              </div>
            )}

            {node.taskOutcome && (
              <div className="status-item">
                <span className="status-label">Task Outcome</span>
                <span className="status-val font-mono">{node.taskOutcome}</span>
              </div>
            )}

            <div className="status-item">
              <span className="status-label">Observed</span>
              <span className="status-val font-mono">{formatIso(node.observedAt)}</span>
            </div>

            {node.lastActivityAt && (
              <div className="status-item">
                <span className="status-label">Last Active</span>
                <span className="status-val font-mono">{formatIso(node.lastActivityAt)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Location & Metadata */}
        {(node.worktreeId || node.branch || node.path) && (
          <div className="inspector-section metadata-section">
            <h3 className="section-title">Workspace Location</h3>
            <div className="meta-list">
              {node.branch && (
                <div className="meta-item">
                  <span className="meta-k">Branch:</span>
                  <span className="meta-v font-mono">{node.branch}</span>
                </div>
              )}
              {node.path && (
                <div className="meta-item">
                  <span className="meta-k">Path:</span>
                  <span className="meta-v font-mono" title={node.path}>{node.path}</span>
                </div>
              )}
              {node.worktreeId && (
                <div className="meta-item">
                  <span className="meta-k">Worktree ID:</span>
                  <span className="meta-v font-mono text-muted">{node.worktreeId}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Current Tool Activity */}
        {currentTool && (
          <div className="inspector-section tool-section">
            <h3 className="section-title">Current Tool Activity</h3>
            <div className="current-tool-card">
              <div className="tool-name-row">
                <span className="tool-tag">Tool</span>
                <span className="tool-name font-mono font-bold">{currentTool.name}</span>
              </div>
              {currentTool.input && (
                <div className="tool-input-box">
                  <div className="tool-input-label">Input / Args:</div>
                  <pre className="tool-input-pre font-mono">{currentTool.input}</pre>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Assigned Tasks */}
        <div className="inspector-section tasks-section">
          <div className="section-header-row">
            <h3 className="section-title">Assigned Tasks</h3>
            <span className="badge badge-neutral font-mono">{tasks.length}</span>
          </div>

          {tasks.length === 0 ? (
            <div className="empty-hint text-sm">No tasks assigned to this node.</div>
          ) : (
            <ul className="node-task-list" role="list">
              {tasks.map((t) => (
                <li key={t.id} className="node-task-card">
                  <div className="task-header-row">
                    <span className={`badge badge-state-${t.state}`}>
                      {t.state}
                    </span>
                    <span className="font-mono text-xs text-muted">ID: {t.id.slice(0, 8)}</span>
                  </div>

                  <div className="task-title font-semibold">{t.title}</div>

                  {t.spec && (
                    <div className="task-spec-box">
                      <div className="text-xs text-muted mb-1">Specification:</div>
                      <div className="task-spec-content">{t.spec}</div>
                      {t.specTruncated && (
                        <div className="task-spec-truncated">
                          [Specification truncated upstream]
                        </div>
                      )}
                    </div>
                  )}

                  {t.result && (
                    <div className="task-result-box">
                      <div className="text-xs text-muted mb-1">Result:</div>
                      <div className="task-result-text font-mono">{t.result}</div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Terminal / Screen Output */}
        <div className="inspector-section output-section">
          <div className="section-header-row">
            <h3 className="section-title">Terminal Sample</h3>
            {outputData && (
              <div className="output-source-badges">
                <span className="badge badge-neutral">Source: {outputData.source}</span>
                {outputData.truncated && <span className="badge badge-stale">Truncated</span>}
                {outputData.limited && <span className="badge badge-neutral">Limited</span>}
              </div>
            )}
          </div>

          {outputMeta?.issue && (
            <div className="panel-alert alert-error">
              [{outputMeta.issue.code}]: {outputMeta.issue.message}
            </div>
          )}

          {!outputData || outputData.lines.length === 0 ? (
            <div className="empty-hint text-sm">
              {node.outputAvailable
                ? 'No terminal output lines captured yet.'
                : 'Terminal output not available for this node.'}
            </div>
          ) : (
            <div className="terminal-viewer" role="region" aria-label="Terminal output text">
              <div className="terminal-meta-bar font-mono text-xs">
                <span>Lines: {outputData.lines.length}</span>
                {outputData.cursor && <span>Cursor: {outputData.cursor}</span>}
              </div>

              <pre className="terminal-code-block font-mono">
                {outputData.lines.map((line, idx) => (
                  <div key={idx} className="terminal-line">
                    <span className="line-num">{idx + 1}</span>
                    <span className="line-text">{stripAnsi(line)}</span>
                  </div>
                ))}
                <div ref={terminalBottomRef} />
              </pre>

              {hasNextCursor && (
                <div className="terminal-load-more">
                  <button
                    type="button"
                    className="btn btn-secondary text-xs"
                    onClick={onLoadMore}
                    disabled={loading}
                  >
                    Load More Output
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
};
