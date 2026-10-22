import React, { useEffect, useRef, useState } from 'react';
import type { AgentPreferences, AgentCatalogResponse, AgentPermissionMode } from '../../../shared/contracts';
import { fetchAgentCatalog, fetchAgentPreferences, saveAgentPreferences } from '../../api/client';
import { ProviderIcon } from '../../components/providers/ProviderIcon';
import { Select } from '../../components/ui/Select';
import { RefreshIcon } from '../../components/ui/RefreshIcon';
import { Icon } from '../../components/ui/Icon';

export function AgentSettings() {
  const [value, setValue] = useState<AgentPreferences | null>(null);
  const [catalog, setCatalog] = useState<AgentCatalogResponse | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const load = (force = false) => {
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setError(''); setLoading(true);
    Promise.all([fetchAgentPreferences(abort.signal), fetchAgentCatalog(abort.signal, force)]).then(([next, agents]) => {
      if (!abort.signal.aborted) { setValue(next); setCatalog(agents); }
    }).catch(e => { if (!abort.signal.aborted) setError(e.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
  };
  useEffect(() => { load(); return () => controller.current?.abort(); }, []);
  const change = async (next: AgentPreferences) => {
    if (!value || saving) return;
    const previous = value;
    setValue(next); setSaving(true); setError('');
    const abort = new AbortController(); controller.current = abort;
    try { const saved = await saveAgentPreferences(next, abort.signal); if (!abort.signal.aborted) setValue(saved); }
    catch (e) { if (!abort.signal.aborted) { setValue(previous); setError((e as Error).message); } }
    finally { if (!abort.signal.aborted) setSaving(false); }
  };
  return <section className="settings-preferences" aria-label="Agent preferences" aria-busy={saving}>
    <div className="settings-page-row"><div><h2>Default agent and permissions</h2><p>Apply to new and resumed sessions. Running agents keep their launch mode.</p></div><button className="btn btn-secondary btn-sm" aria-label="Refresh detected agents" disabled={saving || loading} onClick={() => load(true)}><RefreshIcon busy={loading} />Refresh</button></div>
    {!value && !error && <p role="status">Loading agent settings…</p>}
    {value && [true, false].map(installed => {
      const agents = catalog?.available.filter(agent => Object.hasOwn(value.providers, agent.id) && agent.installed === installed) ?? [];
      return agents.length > 0 && <div className={`agent-settings-group ${installed ? '' : 'is-undetected'}`} key={String(installed)}>
        <h3>{installed ? 'Detected' : 'Not detected · Install required'} <span className="rail-section-badge">{agents.length}</span></h3>
        {agents.map(agent => {
          const provider = agent.id as keyof AgentPreferences['providers'], preference = value.providers[provider];
          const isDefault = value.defaultAgent === provider;
          const enabledProviders = Object.values(value.providers).filter(row => row.enabled).length;
          const toggleEnabled = (enabled: boolean) => {
            const fallback = Object.keys(value.providers).find(id => id !== provider && value.providers[id as typeof provider].enabled) as typeof provider | undefined;
            void change({ ...value, defaultAgent: !enabled && isDefault && fallback ? fallback : value.defaultAgent, providers: { ...value.providers, [provider]: { ...preference, enabled } } });
          };
          return <div className="settings-page-row agent-settings-row" key={provider}>
            <div className="agent-setting-name"><ProviderIcon provider={provider} size={24} /><div><strong>{agent.name}</strong><code>{agent.permissionCommands?.[preference.mode] ?? agent.command}</code></div></div>
            <div className="agent-setting-controls">
              <div className="agent-enabled-control" data-disabled={!preference.enabled} role="group" aria-label={`${agent.name} availability`}>
                <span className="agent-enabled-indicator" aria-hidden="true" />
                {[true, false].map(enabled => <button type="button" key={String(enabled)} aria-pressed={preference.enabled === enabled} disabled={saving || loading || (!enabled && isDefault && enabledProviders === 1)} onClick={() => toggleEnabled(enabled)}>{enabled ? 'Enabled' : 'Disabled'}</button>)}
              </div>
              <Select aria-label={`${agent.name} permission mode`} value={preference.mode} disabled={saving || loading} onChange={e => { void change({ ...value, providers: { ...value.providers, [provider]: { ...preference, mode: e.target.value as AgentPermissionMode } } }); }}>
                <option value="manual">Manual</option><option value="auto" disabled={provider === 'antigravity'}>Auto</option><option value="yolo">Yolo</option>
              </Select>
              {installed && <button type="button" className="agent-default-control" aria-label={`${agent.name} default agent`} aria-pressed={isDefault} disabled={!preference.enabled || saving || loading} onClick={() => { void change({ ...value, defaultAgent: provider }); }}>{isDefault && <Icon name="check" size={14} />}{isDefault ? 'Default' : 'Set default'}</button>}
            </div>
          </div>;
        })}
      </div>;
    })}
    <p className="agent-settings-note">Manual uses provider permission prompts. Auto uses the provider’s automatic reviewer. Antigravity does not support Auto. Yolo skips tool approvals; Codex also disables its sandbox. Sign-in and provider policies still apply.</p>
    {error && <p className="text-danger" role="alert">{error}</p>}
  </section>;
}
