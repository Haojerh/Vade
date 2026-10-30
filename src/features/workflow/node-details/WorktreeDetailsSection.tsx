import React from 'react';
import type { Node } from '../../../../shared/contracts';
import { Disclosure } from '../../../components/ui/Disclosure';
import { Icon } from '../../../components/ui/Icon';
import { WorktreeHistory } from '../../github/WorktreeHistory';

interface WorktreeDetailsSectionProps {
  projectId: string | null;
  node: Node;
  commitGraphEnabled: boolean;
}

export const WorktreeDetailsSection: React.FC<WorktreeDetailsSectionProps> = ({
  projectId,
  node,
  commitGraphEnabled,
}) => (
  <>
    <Disclosure title="Status & Workspace" defaultOpen className="facts-section">
      <div className="facts-panel">
        <div className="facts-metadata-row">
          <div className="fact-col">
            <span className="fact-field-label">State</span>
            <span className={`node-badge-state state-${node.state}`}>{node.state}</span>
          </div>
          {node.workspaceStatus && (
            <div className="fact-col">
              <span className="fact-field-label">Workspace</span>
              <span className="fact-field-value">{node.workspaceStatus}</span>
            </div>
          )}
          {node.branch && (
            <div className="fact-col">
              <span className="fact-field-label">Branch</span>
              <span className="fact-field-value font-mono">{node.branch}</span>
            </div>
          )}
        </div>
        {node.path && (
          <div className="facts-path-row">
            <span className="fact-field-label">Path</span>
            <div className="facts-path-code" title={node.path}>
              <Icon name="folder" size={16} />
              <code>{node.path}</code>
            </div>
          </div>
        )}
        <div className="facts-timestamps-row">
          <div className="fact-timestamp-item">
            <span className="fact-field-label">Observed</span>
            <time className="fact-field-value font-mono" dateTime={node.observedAt ?? undefined}>
              {node.observedAt ? new Date(node.observedAt).toLocaleString() : 'Unavailable'}
            </time>
          </div>
          {node.lastActivityAt && (
            <div className="fact-timestamp-item">
              <span className="fact-field-label">Last activity</span>
              <time className="fact-field-value font-mono" dateTime={node.lastActivityAt}>
                {new Date(node.lastActivityAt).toLocaleString()}
              </time>
            </div>
          )}
        </div>
      </div>
    </Disclosure>
    {projectId && (
      <Disclosure key={`${projectId}:${node.id}`} title="Branch History" lazy>
        <WorktreeHistory
          projectId={projectId}
          nodeId={node.id}
          branch={node.branch ?? undefined}
          commitGraphEnabled={commitGraphEnabled}
        />
      </Disclosure>
    )}
  </>
);
