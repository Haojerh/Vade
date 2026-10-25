import React from 'react';
import type { PrerequisitesStatus } from '../../../shared/contracts';
import { RefreshIcon } from './RefreshIcon';
import { Icon } from './Icon';

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
  const remote = typeof window !== 'undefined' && !window.adeDesktop && !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

  // If loading initially with no data yet, show loading splash
  if (loading && !prerequisites) {
    return (
      <div className="prereq-gate-overlay" data-testid="prerequisites-loading">
        <div className="prereq-gate-card prereq-gate-card--loading">
          <div className="prereq-spinner" aria-hidden="true" />
          <h2 className="prereq-loading-title">Connecting to Vade…</h2>
          <p className="prereq-loading-desc">
            {remote ? 'Contacting the Vade app on your laptop.' : 'Checking the Vade backend and local tools.'}
          </p>
        </div>
      </div>
    );
  }

  // If prerequisites are satisfied, the gate is open
  if (prerequisites?.ready) {
    return null;
  }

  if (!prerequisites || prerequisites.runtime === 'ade') return <div className="prereq-gate-overlay">
    <div className="prereq-gate-card prereq-local-card" role="alert">
      <div className="prereq-gate-header"><Icon name={remote ? 'phone' : 'terminal'} size={24} /><h1 className="prereq-gate-title">{remote ? 'Reconnect to your laptop' : 'Connect to your workspace'}</h1></div>
      <p>{remote ? 'This browser could not reach a ready Vade workspace on your laptop.' : 'Vade could not reach its backend, or a required local tool needs attention.'}</p>
      <div className="prereq-local-help"><strong>{remote ? 'Check the connection' : 'Get connected'}</strong>{remote ? <ol><li>On your laptop, open Vade and keep the laptop awake.</li><li>Connect Tailscale on both devices to the same Tailscale network.</li><li>In the desktop app, open <strong>Settings → Connect phone</strong>. Finish setup and enable phone access.</li><li>Copy the saved phone link from Vade and open it in this browser, then try again.</li></ol> : <><p>If you use the desktop app, open or restart Vade. If you run Vade from source, run <code>npm run build</code>, then <code>npm start</code> in its folder.</p><p>Install Git on the computer running Vade and make sure it is available on PATH.</p></>}{remote && <p>Setup commands run on your laptop. Your phone only needs Tailscale and a browser. <a href="https://tailscale.com/docs/install" target="_blank" rel="noopener noreferrer">Tailscale installation guide</a></p>}</div>
      {prerequisites?.issues?.map(issue => <p className="text-muted text-xs" key={issue}>{issue}</p>)}
      <div><button className="btn btn-primary" onClick={onRecheck} disabled={isChecking}><RefreshIcon busy={isChecking} />{isChecking ? 'Checking...' : 'Try again'}</button></div>
    </div>
  </div>;

  const isOrcaAppMissing = !prerequisites?.orcaApp;
  const isOrcaAppClosed = !isOrcaAppMissing && !prerequisites?.orcaAppOpen;
  const isCliMissing = !prerequisites?.orcaCli;
  const isSkillMissing = !prerequisites?.orchestrationSkill;
  const isCliSkillMissing = !prerequisites?.orcaCliSkill;

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
            className={`prereq-item ${isOrcaAppMissing || isOrcaAppClosed ? 'prereq-item--missing' : 'prereq-item--ok'}`}
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
                    : isOrcaAppClosed
                    ? (prerequisites?.version ? `Installed (v${prerequisites.version}) - Closed` : 'Installed - Closed')
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
                ) : isOrcaAppClosed ? (
                  <span className="prereq-badge prereq-badge--missing">
                    <AlertIcon />
                    Not Running
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

            {isOrcaAppClosed && (
              <div className="prereq-item-body">
                <p className="prereq-item-detail">
                  The Orca desktop application is installed, but it is currently closed. Orca must be running to observe and coordinate tasks.
                </p>
                <div className="prereq-callout" data-testid="prereq-app-closed-notice">
                  <strong>Action required:</strong> Please open the <strong>Orca</strong> desktop application on your computer. This screen will automatically unlock once Orca is running.
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
                  <code className="prereq-inline-code">Settings &gt; Skills</code> tab, search for{' '}
                  <strong>&ldquo;Orchestration&rdquo;</strong>, and click <strong>&ldquo;Install&rdquo;</strong>.
                </div>
              </div>
            )}
          </div>

          {/* 4. Orca CLI Agent Skill */}
          <div
            className={`prereq-item ${isCliSkillMissing ? 'prereq-item--missing' : 'prereq-item--ok'}`}
            data-testid="prereq-item-cli-skill"
          >
            <div className="prereq-item-header">
              <div className="prereq-item-icon" aria-hidden="true">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                </svg>
              </div>
              <div className="prereq-item-info">
                <span className="prereq-item-title">Orca CLI Agent Skill (orca-cli)</span>
                <span className="prereq-item-summary">
                  {isCliSkillMissing ? 'Orca-cli skill not installed' : 'Installed and detected'}
                </span>
              </div>
              <div className="prereq-item-badge-wrap">
                {isCliSkillMissing ? (
                  <span className="prereq-badge prereq-badge--missing">
                    <AlertIcon />
                    Not Installed
                  </span>
                ) : (
                  <span className="prereq-badge prereq-badge--ok">
                    <CheckIcon />
                    Detected
                  </span>
                )}
              </div>
            </div>

            {isCliSkillMissing && (
              <div className="prereq-item-body">
                <p className="prereq-item-detail">
                  The <code className="prereq-inline-code">orca-cli</code> agent skill is required for coding agents to manage Orca worktrees, terminals, and progress workflows.
                </p>
                <div className="prereq-callout">
                  <strong>How to download & install:</strong> Run the following command in your terminal:
                  <div style={{ marginTop: '6px' }}>
                    <code className="prereq-inline-code" style={{ userSelect: 'all', display: 'inline-block', padding: '4px 8px' }}>
                      npx skills add https://github.com/stablyai/orca --skill orca-cli
                    </code>
                  </div>
                  <div style={{ marginTop: '4px', fontSize: '11px', opacity: 0.85 }}>
                    Or install it through the Orca desktop app under <strong>Settings &gt; Orca CLI &gt; CLI skill</strong>.
                  </div>
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
            <span>Automatically re-checking every 3s. This screen will unlock once ready.</span>
          </div>
        </div>
      </div>
    </div>
  );
};

function CheckIcon() {
  return <Icon name="check" size={12} strokeWidth={2.5} />;
}

function AlertIcon() {
  return <Icon name="alert-circle" size={12} strokeWidth={2.5} />;
}
