import React, { useLayoutEffect, useRef, useState } from 'react';
import type { ProjectSelectorProps } from '../features/projects/ProjectSelector';
import { Icon } from '../components/ui/Icon';
import { ConnectionSettings } from '../features/usage/ConnectionSettings';
import { AgentSettings } from '../features/projects/AgentSettings';
import { OrganizationBuilder } from '../features/organization/OrganizationBuilder';
import { WorkflowSetup } from '../features/organization/WorkflowSetup';
import { TopBar } from './TopBar';
import { StatusBar } from './StatusBar';
import { ComputerAwakeSetting } from './SystemControls';
import { AgentNotificationSettings } from '../features/inbox/agentNotifications';
import { VoiceDictationSettings } from '../features/workflow/VoiceDictationSettings';
import { Select } from '../components/ui/Select';
import type { TerminalShell } from '../../shared/contracts';
import { TERMINAL_SHELL_OPTIONS, readTerminalShell, writeTerminalShell } from './terminalShellPreference';
import { setEditorAutosave, useEditorAutosave } from '../features/explorer/editorPreferences';

type SettingsPageProps = Pick<ProjectSelectorProps, 'theme' | 'onToggleTheme' | 'cardStateColors' | 'onToggleCardStateColors'
  | 'orchestrationSeparated' | 'onToggleOrchestrationSeparated' | 'commitGraphEnabled' | 'onToggleCommitGraph'
  | 'toolActivityEnabled' | 'onToggleToolActivity' | 'chatToolCallsEnabled' | 'onToggleChatToolCalls'>
  & { section: string; onBack: () => void };

const sections = [
  { id: 'general', label: 'General', description: 'Make Vade comfortable for the way you work.' },
  { id: 'voice', label: 'Voice dictation', description: 'Choose how speech becomes text in your Chat draft.' },
  { id: 'agents', label: 'Agents', description: 'Choose your default agent and permission modes.' },
  { id: 'workflow', label: 'Workspace', description: 'Control what appears in your project workspace.' },
  { id: 'organization', label: 'Workflow / Organization', description: 'Define how your coding agents delegate, collaborate, and return results.' },
  { id: 'setup', label: 'Installation / Setup', description: 'Check desktop updates and install the local orchestration components.' },
  { id: 'integrations', label: 'Integrations', description: 'Connect source-hosting services on this machine.' },
  { id: 'accounts', label: 'AI Provider Accounts', description: 'Connect your existing provider sign-ins to display subscription usage.' },
];

export const SettingsPage: React.FC<SettingsPageProps> = props => {
  const [search, setSearch] = useState('');
  const [terminalShell, setTerminalShell] = useState<TerminalShell>(readTerminalShell);
  const autosave = useEditorAutosave();
  const current = sections.find(section => section.id === props.section) ?? sections[0];
  const options = [
    { section: 'general', label: 'Editor autosave', description: 'Save workspace files after a short pause and when leaving the editor. When off, save with Ctrl/Cmd+S.', checked: autosave, change: setEditorAutosave },
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
  const showAwake = query ? matches('Keep computer awake On Agent Off Sleep', 'Choose when Vade prevents system sleep.') : current.id === 'general';
  const showNotifications = query ? matches('Agent finished notifications sound system popup', 'Get notified when an agent finishes.') : current.id === 'general';
  const showTerminal = query ? matches('Terminal PowerShell Command Prompt Bash Shell', 'Shell used when adding a Terminal from Add Agent.') : current.id === 'general';
  const showVoice = query ? matches('Voice dictation microphone speech browser local offline model', 'Dictate into Chat with Ctrl+E.') : current.id === 'voice';
  const navigation = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<React.CSSProperties>({ opacity: 0 });
  const [indicatorReady, setIndicatorReady] = useState(false);
  useLayoutEffect(() => {
    const root = navigation.current, selected = root?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!root || !selected) { setIndicator(previous => ({ ...previous, opacity: 0 })); return; }
    const measure = () => {
      const links = Array.from(root.querySelectorAll<HTMLElement>('a'));
      const width = Math.max(root.clientWidth, ...links.map(link => link.offsetLeft + link.offsetWidth));
      const height = Math.max(root.clientHeight, ...links.map(link => link.offsetTop + link.offsetHeight));
      setIndicator({ opacity: 1, width, height,
        clipPath: `inset(${selected.offsetTop}px ${Math.max(0, width - selected.offsetLeft - selected.offsetWidth)}px ${Math.max(0, height - selected.offsetTop - selected.offsetHeight)}px ${selected.offsetLeft}px round 8px)` });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(root); observer.observe(selected);
    const frame = requestAnimationFrame(() => setIndicatorReady(true));
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [current.id, Boolean(query)]);
  return <div className="settings-window dashboard-unified-header"><TopBar /><div className="settings-page">
    <aside className="settings-sidebar">
      <button className="settings-back" onClick={props.onBack}><Icon name="chevron-left" size={16} /><span>Back to app</span></button>
      <div className="settings-search"><Icon name="search" size={16} /><input type="search" aria-label="Search settings" placeholder="Search settings" value={search} onChange={event => setSearch(event.target.value)} /></div>
      <nav ref={navigation} aria-label="Settings sections" data-indicator-ready={indicatorReady}><span className="settings-nav-indicator" aria-hidden="true" style={indicator} />{sections.map(section => <a key={section.id} href={`#/settings/${section.id}`} aria-current={!query && section.id === current.id ? 'page' : undefined} onClick={() => setSearch('')}>
        <Icon name={section.id === 'general' ? 'settings' : section.id === 'voice' ? 'mic' : section.id === 'agents' ? 'users' : section.id === 'workflow' ? 'sidebar-left' : section.id === 'organization' ? 'workflow' : section.id === 'setup' ? 'download' : section.id === 'integrations' ? 'git-branch' : 'key'} size={17} />{section.label}
      </a>)}</nav>
    </aside>
    <main className="settings-content">
      <div className="settings-content-inner" key={query ? 'search' : current.id}>
        <header><h1>{query ? 'Search results' : current.label}</h1><p>{query ? `Settings matching “${search.trim()}”` : current.description}</p></header>
        {!query && current.id === 'organization' ? <OrganizationBuilder /> : !query && current.id === 'setup' ? <WorkflowSetup /> : !query && current.id === 'agents' ? <AgentSettings /> : !query && (current.id === 'integrations' || current.id === 'accounts') ? <ConnectionSettings key={current.id} kind={current.id} /> : <section className="settings-preferences" aria-label={query ? 'Matching settings' : `${current.label} preferences`}>
          {showAppearance && <div className="settings-page-row"><div><h2>Appearance</h2><p>Choose your preferred color theme.</p></div><button className="btn btn-secondary" onClick={props.onToggleTheme} aria-label={`Toggle theme, current theme is ${props.theme}`}><Icon name={props.theme === 'dark' ? 'sun' : 'moon'} size={16} />{props.theme === 'dark' ? 'Dark' : 'Light'}</button></div>}
          {showAwake && <ComputerAwakeSetting />}
          {showVoice && <VoiceDictationSettings />}
          {showNotifications && <AgentNotificationSettings />}
          {showTerminal && <label className="settings-page-row settings-dropdown-row"><div><span className="settings-page-label">Terminal</span><p>Shell used when adding a Terminal from Add Agent.</p></div><Select aria-label="Terminal shell" value={terminalShell} onChange={event => { const value = event.target.value as TerminalShell; setTerminalShell(value); writeTerminalShell(value); }}>{TERMINAL_SHELL_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</Select></label>}
          {filtered.map(option => <label className="settings-page-row" key={option.label}><div><span className="settings-page-label">{option.label}</span><p>{option.description}</p></div><input type="checkbox" role="switch" checked={option.checked} onChange={event => option.change?.(event.target.checked)} disabled={!option.change} /></label>)}
          {!showAppearance && !showTerminal && !showAwake && !showNotifications && !showVoice && !filtered.length && <p className="settings-no-results">No settings found. Try another search.</p>}
        </section>}
      </div>
    </main>
  </div><StatusBar /></div>;
};
