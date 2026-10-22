import React, { useState } from 'react';
import type { ProjectSelectorProps } from '../features/projects/ProjectSelector';
import { Icon } from '../components/ui/Icon';
import { ConnectionSettings } from '../features/usage/ConnectionSettings';
import { AgentSettings } from '../features/projects/AgentSettings';
import { TopBar } from './TopBar';
import { StatusBar } from './StatusBar';
import { Select } from '../components/ui/Select';
import type { TerminalShell } from '../../shared/contracts';
import { TERMINAL_SHELL_OPTIONS, readTerminalShell, writeTerminalShell } from './terminalShellPreference';

type SettingsPageProps = Pick<ProjectSelectorProps, 'theme' | 'onToggleTheme' | 'cardStateColors' | 'onToggleCardStateColors'
  | 'orchestrationSeparated' | 'onToggleOrchestrationSeparated' | 'commitGraphEnabled' | 'onToggleCommitGraph'
  | 'toolActivityEnabled' | 'onToggleToolActivity' | 'chatToolCallsEnabled' | 'onToggleChatToolCalls'>
  & { section: string; onBack: () => void };

const sections = [
  { id: 'general', label: 'General', description: 'Make Vade comfortable for the way you work.' },
  { id: 'agents', label: 'Agents', description: 'Choose your default agent and permission modes.' },
  { id: 'workflow', label: 'Workflow', description: 'Control what appears in your project workspace.' },
  { id: 'integrations', label: 'Integrations', description: 'Connect source-hosting services on this machine.' },
  { id: 'accounts', label: 'AI Provider Accounts', description: 'Connect your existing provider sign-ins to display subscription usage.' },
];

export const SettingsPage: React.FC<SettingsPageProps> = props => {
  const [search, setSearch] = useState('');
  const [terminalShell, setTerminalShell] = useState<TerminalShell>(readTerminalShell);
  const current = sections.find(section => section.id === props.section) ?? sections[0];
  const options = [
    { section: 'workflow', label: 'Live tool nodes', description: 'Show observed tool calls near their agent.', checked: props.toolActivityEnabled ?? true, change: props.onToggleToolActivity },
    { section: 'workflow', label: 'Tool calls in chat', description: 'Show observed tool calls, such as edits and commands, in the agent chat history.', checked: props.chatToolCallsEnabled ?? true, change: props.onToggleChatToolCalls },
    { section: 'workflow', label: 'Commit graph history', description: 'Show local branches and merges in the Commits tab.', checked: props.commitGraphEnabled ?? false, change: props.onToggleCommitGraph },
    { section: 'workflow', label: 'Card state colors', description: 'Color cards by state: blue working, green completed, yellow interrupted.', checked: props.cardStateColors, change: props.onToggleCardStateColors },
    { section: 'workflow', label: 'Orchestration separated', description: 'Display the orchestrator in a separate lane instead of inside its worktree.', checked: props.orchestrationSeparated ?? true, change: props.onToggleOrchestrationSeparated },
  ];
  const query = search.trim().toLowerCase();
  const matches = (label: string, description: string) => `${label} ${description}`.toLowerCase().includes(query);
  const filtered = options.filter(option => query ? matches(option.label, option.description) : option.section === current.id);
  const showAppearance = query ? matches('Appearance Dark Light Theme', 'Choose your preferred color theme.') : current.id === 'general';
  const showTerminal = query ? matches('Terminal PowerShell Command Prompt Bash Shell', 'Shell used when adding a Terminal from Add Agent.') : current.id === 'general';
  return <div className="settings-window dashboard-unified-header"><TopBar /><div className="settings-page">
    <aside className="settings-sidebar">
      <button className="settings-back" onClick={props.onBack}><Icon name="chevron-left" size={16} /><span>Back to app</span></button>
      <div className="settings-search"><Icon name="search" size={16} /><input type="search" aria-label="Search settings" placeholder="Search settings" value={search} onChange={event => setSearch(event.target.value)} /></div>
      <nav aria-label="Settings sections">{sections.map(section => <a key={section.id} href={`#/settings/${section.id}`} aria-current={!query && section.id === current.id ? 'page' : undefined} onClick={() => setSearch('')}>
        <Icon name={section.id === 'general' ? 'settings' : section.id === 'integrations' ? 'git-branch' : section.id === 'accounts' ? 'circle-dot' : 'layers'} size={17} />{section.label}
      </a>)}</nav>
    </aside>
    <main className="settings-content">
      <div className="settings-content-inner">
        <header><h1>{query ? 'Search results' : current.label}</h1><p>{query ? `Settings matching “${search.trim()}”` : current.description}</p></header>
        {!query && current.id === 'agents' ? <AgentSettings /> : !query && (current.id === 'integrations' || current.id === 'accounts') ? <ConnectionSettings key={current.id} kind={current.id} /> : <section className="settings-preferences" aria-label={query ? 'Matching settings' : `${current.label} preferences`}>
          {showAppearance && <div className="settings-page-row"><div><h2>Appearance</h2><p>Choose your preferred color theme.</p></div><button className="btn btn-secondary" onClick={props.onToggleTheme} aria-label={`Toggle theme, current theme is ${props.theme}`}><Icon name={props.theme === 'dark' ? 'sun' : 'moon'} size={16} />{props.theme === 'dark' ? 'Dark' : 'Light'}</button></div>}
          {showTerminal && <label className="settings-page-row"><div><span className="settings-page-label">Terminal</span><p>Shell used when adding a Terminal from Add Agent.</p></div><Select aria-label="Terminal shell" value={terminalShell} onChange={event => { const value = event.target.value as TerminalShell; setTerminalShell(value); writeTerminalShell(value); }}>{TERMINAL_SHELL_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</Select></label>}
          {filtered.map(option => <label className="settings-page-row" key={option.label}><div><span className="settings-page-label">{option.label}</span><p>{option.description}</p></div><input type="checkbox" role="switch" checked={option.checked} onChange={event => option.change?.(event.target.checked)} disabled={!option.change} /></label>)}
          {!showAppearance && !showTerminal && !filtered.length && <p className="settings-no-results">No settings found. Try another search.</p>}
        </section>}
      </div>
    </main>
  </div><StatusBar /></div>;
};
