import { Select } from '../components/ui/Select';
import React from 'react';
import type { Run } from '../../shared/contracts';
import { Icon } from '../components/ui/Icon';

export interface TopBarProps {
  topbarRef: React.RefObject<HTMLElement | null>;
  runs: Run[];
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  topbarRef,
  runs,
  selectedRunId,
  onSelectRun,
}) => {
  return (
    <header ref={topbarRef} className="dashboard-topbar">
      <div className="topbar-left-group">
        <Icon name="layers" size={24} />
        <h1 className="active-project-heading">ADE</h1>
      </div>

      <div className="topbar-center-group">
        {runs.length > 0 && (
          <div className="center-run-picker">
            <label htmlFor="center-run-select" className="run-picker-label text-xs font-semibold">
              Run:
            </label>
            <Select wrapperClassName="run-select-wrapper"
                id="center-run-select"
                className="center-run-select"
                value={selectedRunId || ''}
                onChange={(e) => onSelectRun(e.target.value || null)}
                aria-label="Select active workflow run"
              >
                <option value="">Default run ({runs[0]?.sourceRunId || 'auto'})</option>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.sourceRunId} {r.objective ? `â€” ${r.objective.slice(0, 40)}` : ''}
                  </option>
                ))}
              </Select>
          </div>
        )}
      </div>

    </header>
  );
};
