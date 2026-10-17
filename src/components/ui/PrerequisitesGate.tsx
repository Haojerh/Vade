import React from 'react';
import type { PrerequisitesStatus } from '../../../shared/contracts';
import { RefreshIcon } from './RefreshIcon';

export interface PrerequisitesGateProps {
  prerequisites: PrerequisitesStatus | null;
  loading: boolean;
  onRecheck: () => void;
  isChecking: boolean;
}

export const PrerequisitesGate: React.FC<PrerequisitesGateProps> = ({
  prerequisites,
  loading,
  onRecheck,
  isChecking,
}) => {
  // If loading initially with no data yet, show loading splash
  if (loading && !prerequisites) {
    return (
      <div className="prereq-gate-overlay" data-testid="prerequisites-loading">
        <div className="prereq-gate-card prereq-gate-card--loading">
          <div className="prereq-spinner" aria-hidden="true" />
          <h2 className="prereq-loading-title">Checking Orca Environment...</h2>
          <p className="prereq-loading-desc">
            Verifying Orca desktop app, CLI, and Orchestration skill prerequisites.
          </p>
        </div>
      </div>
    );
  }

  // If prerequisites are satisfied, the gate is open
  if (prerequisites?.ready) {
    return null;
  }

  const isOrcaAppMissing = !prerequisites?.orcaApp;
  const isCliMissing = !prerequisites?.orcaCli;
  const isSkillMissing = !prerequisites?.orchestrationSkill;

  return (
    <div
      className="prereq-gate-overlay"
      data-testid="prerequisites-gate"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prereq-gate-title"
    >
      <div className="prereq-gate-card">
        {/* Header */}
        <div className="prereq-gate-header">
          <div className="prereq-gate-icon-wrapper" aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </svg>
          </div>
          <h1 id="prereq-gate-title" className="prereq-gate-title">
            Orca Prerequisites Required
          </h1>
        </div>

        {/* Checklist */}
        <div className="prereq-checklist">
          {/* 1. Orca Desktop App */}
          <div
            className={`prereq-item ${isOrcaAppMissing ? 'prereq-item--missing' : 'prereq-item--ok'}`}
            data-testid="prereq-item-app"
          >
            <div className="prereq-item-header">
              <div className="prereq-item-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                </svg>
              </div>
              <div className="prereq-item-info">
                <span className="prereq-item-title">Orca Desktop Application</span>
                <span className="prereq-item-summary">
                  {isOrcaAppMissing
                    ? 'Orca not downloaded'
                    : prerequisites?.version
                    ? `Detected (v${prerequisites.version})`
                    : 'Detected'}
                </span>
              </div>
              <div className="prereq-item-badge-wrap">
                {isOrcaAppMissing ? (
                  <span className="prereq-badge prereq-badge--missing">
                    <AlertIcon />
                    Not Downloaded
                  </span>
                ) : (
                  <span className="prereq-badge prereq-badge--ok">
                    <CheckIcon />
                    Detected
                  </span>
                )}
              </div>
            </div>

            {isOrcaAppMissing && (
              <div className="prereq-item-body">
                <p className="prereq-item-detail">
                  The Orca desktop application was not detected on this machine. Please download and install Orca from the official website to get started.
                </p>
                <div className="prereq-action-row">
                  <a
                    href="https://www.onorca.dev/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="prereq-btn prereq-btn--primary"
                    data-testid="prereq-download-app-link"
                  >
                    <span>Download Orca</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </a>
                  <span className="prereq-link-caption">https://www.onorca.dev/</span>
                </div>
              </div>
            )}
          </div>

          {/* 2. Orca CLI */}
          <div
            className={`prereq-item ${isCliMissing ? 'prereq-item--missing' : 'prereq-item--ok'}`}
            data-testid="prereq-item-cli"
          >
            <div className="prereq-item-header">
              <div className="prereq-item-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              </div>
              <div className="prereq-item-info">
                <span className="prereq-item-title">Orca CLI (orca-cli)</span>
                <span className="prereq-item-summary">
                  {isCliMissing ? 'Orca-cli not downloaded' : 'Installed and accessible'}
                </span>
              </div>
              <div className="prereq-item-badge-wrap">
                {isCliMissing ? (
                  <span className="prereq-badge prereq-badge--missing">
                    <AlertIcon />
                    Not Downloaded
                  </span>
                ) : (
                  <span className="prereq-badge prereq-badge--ok">
                    <CheckIcon />
                    Detected
                  </span>
                )}
              </div>
            </div>

            {isCliMissing && (
              <div className="prereq-item-body">
                <p className="prereq-item-detail">
                  The <code className="prereq-inline-code">orca</code> command-line tool was not found in your system.
                </p>
                <div className="prereq-callout">
                  <strong>How to download & install:</strong> Open the Orca desktop app, go to{' '}
                  <code className="prereq-inline-code">Settings &gt; CLI</code>, and click{' '}
                  <strong>&ldquo;Install CLI&rdquo;.</strong>
                </div>
              </div>
            )}
          </div>

          {/* 3. Orca Orchestration Skill */}
          <div
            className={`prereq-item ${isSkillMissing ? 'prereq-item--missing' : 'prereq-item--ok'}`}
            data-testid="prereq-item-skill"
          >
            <div className="prereq-item-header">
              <div className="prereq-item-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="6" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <line x1="20" y1="4" x2="8.12" y2="15.88" />
                  <line x1="14.47" y1="14.48" x2="20" y2="20" />
                  <line x1="8.12" y1="8.12" x2="12" y2="12" />
                </svg>
              </div>
              <div className="prereq-item-info">
                <span className="prereq-item-title">Orca Orchestration Skill</span>
                <span className="prereq-item-summary">
                  {isSkillMissing ? 'Orchestration skill not downloaded' : 'Installed and enabled'}
                </span>
              </div>
              <div className="prereq-item-badge-wrap">
                {isSkillMissing ? (
                  <span className="prereq-badge prereq-badge--missing">
                    <AlertIcon />
                    Not Downloaded
                  </span>
                ) : (
                  <span className="prereq-badge prereq-badge--ok">
                    <CheckIcon />
                    Detected
                  </span>
                )}
              </div>
            </div>

            {isSkillMissing && (
              <div className="prereq-item-body">
                <p className="prereq-item-detail">
                  The multi-agent orchestration capability is required to observe and manage runs, tasks, and worker trees.
                </p>
                <div className="prereq-callout">
                  <strong>How to download & install:</strong> Open the Orca desktop app, navigate to the{' '}
                  <code className="prereq-inline-code">Settings &gt; Orchestration</code> tab, search for{' '}
                  <strong>&ldquo;Orchestration&rdquo;</strong>, and click <strong>&ldquo;Install&rdquo;</strong>.
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="prereq-gate-footer">
          <button
            type="button"
            className="prereq-btn prereq-btn--recheck"
            onClick={onRecheck}
            disabled={isChecking}
            data-testid="prereq-recheck-btn"
          >
            <RefreshIcon busy={isChecking} size={14} />
            <span>{isChecking ? 'Checking...' : 'Re-check Prerequisites'}</span>
          </button>
          <div className="prereq-footer-hint">
            <span className="prereq-pulse-dot" aria-hidden="true" />
            <span>Automatically re-checking every 5s. This screen will unlock once ready.</span>
          </div>
        </div>
      </div>
    </div>
  );
};

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
