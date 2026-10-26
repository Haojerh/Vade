import React, { useRef } from 'react';
import { useHistoryRendering } from '../../hooks/useHistoryRendering';
import type { Activity } from '../../../shared/contracts';

interface ActivityPanelProps {
  activity: Activity[] | null | undefined;
  onSelectNode?: (nodeId: string) => void;
}

export const ActivityPanel: React.FC<ActivityPanelProps> = ({
  activity = [],
  onSelectNode,
}) => {
  const items = activity ?? [];
  const list = useRef<HTMLOListElement>(null);
  useHistoryRendering(list, items.length > 80);

  const formatTime = (iso: string) => {
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return iso;
    }
  };

  return (
    <section className="dashboard-panel activity-panel" aria-labelledby="activity-panel-title">
      <div className="panel-header">
        <div className="panel-title-group">
          <h2 id="activity-panel-title" className="panel-title">Session Activity</h2>
          <span className="panel-count font-mono">{items.length}</span>
        </div>
        <div className="panel-badges">
          <span className="badge badge-neutral">Bounded Ring</span>
        </div>
      </div>

      <div className="panel-content activity-scroll-area">
        {items.length === 0 ? (
          <div className="empty-hint">
            No observed activity events in the current session window. Initial connection serves as a baseline.
          </div>
        ) : (
          <ol ref={list} className="activity-list" role="list">
            {items.map((act) => {
              const kindLabel =
                act.kind === 'task-status'
                  ? 'Task'
                  : act.kind === 'agent-status'
                  ? 'Agent'
                  : 'Output';

              return (
                <li key={act.id} data-history-row className="activity-row">
                  <div className="activity-meta">
                    <span className={`badge badge-activity-${act.kind}`}>
                      {kindLabel}
                    </span>
                    <time
                      dateTime={act.at}
                      className="activity-time font-mono"
                      title={`${act.at} (${act.timestampKind === 'source' ? 'Source timestamp' : 'Server observation timestamp'})`}
                    >
                      {formatTime(act.at)}{' '}
                      <span className="timestamp-kind-badge">
                        {act.timestampKind === 'source' ? 'src' : 'obs'}
                      </span>
                    </time>
                  </div>

                  <div className="activity-text">
                    {act.text}
                  </div>

                  {act.nodeId && (
                    <div className="activity-links">
                      <button
                        type="button"
                        className="activity-node-link font-mono"
                        onClick={() => onSelectNode && act.nodeId && onSelectNode(act.nodeId)}
                        title={`Focus node ${act.nodeId}`}
                      >
                        Node: {act.nodeId.slice(0, 8)}…
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
};
