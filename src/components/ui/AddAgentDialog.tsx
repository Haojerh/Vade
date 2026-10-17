import React, { useRef, useEffect, useState, useCallback } from 'react';
import type { AgentCatalogEntry, AgentCatalogResponse } from '../../../shared/contracts';
import { fetchAgentCatalog } from '../../api/client';
import { ProviderIcon } from '../providers/ProviderIcon';
import { Icon } from './Icon';
import { RefreshIcon } from './RefreshIcon';

export interface AddAgentDialogProps {
  isOpen: boolean;
  isClosing: boolean;
  worktreeName: string;
  isCreating?: boolean;
  error?: string | null;
  onCreate: (command: string, title?: string) => void | Promise<void>;
  onClose: () => void;
}

const DEFAULT_SEED_AGENTS: AgentCatalogEntry[] = [
  { id: 'claude', name: 'Claude', command: 'claude --dangerously-skip-permissions', detectCmd: 'claude', provider: 'claude', installed: true },
  { id: 'codex', name: 'Codex', command: 'codex --dangerously-bypass-approvals-and-sandbox', detectCmd: 'codex', provider: 'codex', installed: true },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', detectCmd: 'opencode', provider: 'opencode', installed: true },
  { id: 'antigravity', name: 'Antigravity', command: 'agy --dangerously-skip-permissions', detectCmd: 'agy', provider: 'antigravity', installed: true },
  { id: 'kilo', name: 'Kilocode', command: 'kilo', detectCmd: 'kilo', provider: 'kilo', installed: true },
  { id: 'gemini', name: 'Gemini', command: 'gemini --yolo', detectCmd: 'gemini', provider: 'gemini', installed: true },
];

export const AddAgentDialog: React.FC<AddAgentDialogProps> = ({
  isOpen,
  isClosing,
  worktreeName,
  isCreating = false,
  error = null,
  onCreate,
  onClose,
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [catalog, setCatalog] = useState<AgentCatalogResponse>({
    installed: DEFAULT_SEED_AGENTS.filter((a) => a.installed),
    available: DEFAULT_SEED_AGENTS.filter((a) => !a.installed),
    defaultAgentId: 'codex',
  });
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [showAvailable, setShowAvailable] = useState(false);

  // Selected agent state
  const [selectedAgentId, setSelectedAgentId] = useState<string>('codex');
  const [command, setCommand] = useState<string>('codex --dangerously-bypass-approvals-and-sandbox');
  const [title, setTitle] = useState<string>('Codex');

  const selectedAgentIdRef = useRef<string>(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;
  const userManuallyChangedSelectionRef = useRef(false);

  const loadCatalog = useCallback(async () => {
    setIsLoadingCatalog(true);
    try {
      const data = await fetchAgentCatalog();
      setCatalog(data);

      // If user hasn't manually clicked another agent, sync with Orca's authoritative default
      if (!userManuallyChangedSelectionRef.current) {
        const defaultAgent =
          data.installed.find((a) => a.id === data.defaultAgentId) ||
          data.installed.find((a) => a.isDefault) ||
          data.installed[0];
        if (defaultAgent) {
          setSelectedAgentId(defaultAgent.id);
          setCommand(defaultAgent.command);
          setTitle(defaultAgent.name);
        }
      }
    } catch (err) {
      console.error('Failed to load agent catalog:', err);
    } finally {
      setIsLoadingCatalog(false);
    }
  }, []);

  // When dialog transitions from closed to open, initialize default selection and fetch catalog
  const prevIsOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      userManuallyChangedSelectionRef.current = false;
      const def =
        catalog.installed.find((a) => a.id === catalog.defaultAgentId) ||
        catalog.installed.find((a) => a.isDefault) ||
        catalog.installed[0];
      if (def) {
        setSelectedAgentId(def.id);
        setCommand(def.command);
        setTitle(def.name);
      }
      loadCatalog();
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, catalog, loadCatalog]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        // Modal unsupported or already open
      }
    } else if (!isOpen && dialog.open) {
      try {
        dialog.close();
      } catch {
        // ignore
      }
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSelectAgent = (agent: AgentCatalogEntry) => {
    userManuallyChangedSelectionRef.current = true;
    setSelectedAgentId(agent.id);
    setCommand(agent.command);

    // Auto-update tab title if it was empty or matches any known agent name
    setTitle((prev) => {
      if (!prev) return agent.name;
      const allKnownNames = [...(catalog?.installed || []), ...(catalog?.available || [])].map((a) => a.name);
      if (allKnownNames.includes(prev)) {
        return agent.name;
      }
      return prev;
    });
  };

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanCmd = command.trim();
    if (!cleanCmd || isCreating) return;
    onCreate(cleanCmd, title.trim() || undefined);
  };

  const installedList = catalog?.installed ?? [];
  const availableList = catalog?.available ?? [];
  const selectedAgent = [...installedList, ...availableList].find((a) => a.id === selectedAgentId);

  return (
    <dialog
      ref={dialogRef}
      className={`node-modal-dialog confirmation-dialog add-agent-dialog ${isClosing ? 'is-closing' : ''}`}
      aria-labelledby="add-agent-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!isCreating) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isCreating) {
          onClose();
        }
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
        <div>
          <h2 id="add-agent-dialog-title" style={{ margin: 0 }}>Add New Agent</h2>
          <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
            Start a new agent session in worktree <strong>{worktreeName}</strong>.
          </p>
        </div>
        <button
          type="button"
          className="btn-icon"
          onClick={loadCatalog}
          disabled={isLoadingCatalog || isCreating}
          aria-label="Refresh detected agents"
          title="Refresh detected agents"
        >
          <RefreshIcon busy={isLoadingCatalog} size={14} />
        </button>
      </div>

      <div className="add-agent-dialog-scroll">
        {/* Installed Section */}
        <section>
          <div className="agent-catalog-section-header">
            <span className="agent-catalog-section-title">
              <span>Installed</span>
              <span className="agent-catalog-badge badge-accent">
                {installedList.length} detected
              </span>
            </span>
          </div>

          {installedList.length === 0 && !isLoadingCatalog ? (
            <div className="text-xs text-muted" style={{ padding: '12px', textAlign: 'center', background: 'var(--surface-1)', borderRadius: '6px' }}>
              No installed agents detected on host PATH. You can choose from available agents below.
            </div>
          ) : (
            <div className="agent-catalog-list">
              {installedList.map((agent) => {
                const isSelected = selectedAgentId === agent.id;
                return (
                  <div
                    key={agent.id}
                    className={`agent-catalog-item ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => handleSelectAgent(agent)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleSelectAgent(agent);
                      }
                    }}
                  >
                    <div className="agent-catalog-item-icon">
                      <ProviderIcon provider={agent.provider} size={16} />
                    </div>
                    <div className="agent-catalog-item-info">
                      <div className="agent-catalog-item-name">{agent.name}</div>
                      <div className="agent-catalog-item-cmd font-mono">{agent.command}</div>
                    </div>
                    <div className="agent-catalog-item-actions">
                      {agent.isDefault && (
                        <span className="badge badge-default text-xs" style={{ fontSize: '10px', padding: '2px 6px' }}>
                          ✓ Default
                        </span>
                      )}
                      <button
                        type="button"
                        className={`btn btn-xs ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelectAgent(agent);
                        }}
                      >
                        {isSelected ? 'Selected' : 'Select'}
                      </button>
                      {agent.homepageUrl && (
                        <a
                          href={agent.homepageUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Documentation"
                          onClick={(e) => e.stopPropagation()}
                          style={{ color: 'var(--text-secondary)', display: 'inline-flex' }}
                        >
                          <Icon name="external-link" size={13} />
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Available to Install Section */}
        {availableList.length > 0 && (
          <section>
            <div
              className="agent-catalog-section-header"
              style={{ cursor: 'pointer', userSelect: 'none' }}
              onClick={() => setShowAvailable(!showAvailable)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setShowAvailable(!showAvailable);
                }
              }}
            >
              <span className="agent-catalog-section-title">
                <span>Available to install</span>
                <span className="agent-catalog-badge badge-muted">
                  {availableList.length} agents
                </span>
              </span>
              <button
                type="button"
                className="btn-icon"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowAvailable(!showAvailable);
                }}
                aria-label={showAvailable ? 'Collapse available agents' : 'Show available agents'}
                title={showAvailable ? 'Collapse' : 'Show all'}
              >
                <Icon
                  name="chevron-down"
                  size={14}
                  className={`section-chevron-icon ${showAvailable ? '' : 'is-collapsed'}`}
                />
              </button>
            </div>

            <div className={`section-collapsible-body ${showAvailable ? '' : 'is-collapsed'}`}>
              <div className="section-collapsible-inner">
                <div className="agent-catalog-list" style={{ maxHeight: '240px', overflowY: 'auto' }}>
                  {availableList.map((agent) => {
                    const isSelected = selectedAgentId === agent.id;
                    return (
                      <div
                        key={agent.id}
                        className={`agent-catalog-item ${isSelected ? 'is-selected' : ''}`}
                        onClick={() => handleSelectAgent(agent)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleSelectAgent(agent);
                          }
                        }}
                        style={{ opacity: 0.85 }}
                      >
                        <div className="agent-catalog-item-icon">
                          <ProviderIcon provider={agent.provider} size={16} />
                        </div>
                        <div className="agent-catalog-item-info">
                          <div className="agent-catalog-item-name">{agent.name}</div>
                          <div className="agent-catalog-item-cmd font-mono">{agent.command}</div>
                        </div>
                        <div className="agent-catalog-item-actions">
                          <button
                            type="button"
                            className={`btn btn-xs ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSelectAgent(agent);
                            }}
                          >
                            {isSelected ? 'Selected' : 'Use'}
                          </button>
                          {agent.homepageUrl && (
                            <a
                              href={agent.homepageUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Install / Documentation"
                              onClick={(e) => e.stopPropagation()}
                              style={{ color: 'var(--text-secondary)', display: 'inline-flex' }}
                            >
                              <Icon name="external-link" size={13} />
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Title Customization Form */}
        <form onSubmit={handleSubmit} className="add-agent-input-group" style={{ marginTop: '12px' }}>
          <div>
            <label
              htmlFor="agent-tab-title-input"
              className="text-xs font-semibold"
              style={{
                display: 'block',
                marginBottom: '8px',
                color: 'var(--text-secondary)',
                fontSize: '12px',
                lineHeight: 1.4,
              }}
            >
              Terminal Tab Title (optional)
            </label>
            <input
              id="agent-tab-title-input"
              type="text"
              className="add-agent-input"
              style={{
                width: '100%',
                padding: '10px 14px',
                borderRadius: '6px',
                border: '1px solid var(--border-main)',
                background: 'var(--surface-2)',
                color: 'var(--text-main)',
                fontSize: '13px',
                boxSizing: 'border-box',
                outline: 'none',
              }}
              placeholder={selectedAgent ? `e.g. ${selectedAgent.name}` : 'e.g. Worker Tab'}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={isCreating}
              maxLength={100}
            />
          </div>

          <details style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>
            <summary style={{ cursor: 'pointer', userSelect: 'none', opacity: 0.8 }}>
              Advanced: command flags
            </summary>
            <div style={{ marginTop: '6px' }}>
              <input
                type="text"
                className="add-agent-input font-mono text-xs"
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: '6px',
                  border: '1px solid var(--border-main)',
                  background: 'var(--surface-2)',
                  color: 'var(--text-main)',
                  fontSize: '12px',
                  boxSizing: 'border-box',
                  outline: 'none',
                }}
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                disabled={isCreating}
                maxLength={512}
              />
            </div>
          </details>
        </form>
      </div>

      {error && (
        <div className="panel-alert alert-error" style={{ margin: '8px 0 0' }} role="alert">
          {error}
        </div>
      )}

      <div className="confirmation-dialog-actions" style={{ marginTop: '16px' }}>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onClose}
          disabled={isCreating}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => handleSubmit()}
          disabled={isCreating || !command.trim()}
        >
          {isCreating ? 'Spawning Agent…' : 'Create Agent'}
        </button>
      </div>
    </dialog>
  );
};
