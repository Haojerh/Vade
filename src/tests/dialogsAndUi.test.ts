import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { normalizeProvider, ProviderIcon } from '../components/providers/ProviderIcon';
import { ORCA_PROVIDER_IMAGES } from '../components/providers/OrcaProviderAssets';
import { ProjectSelector } from '../features/projects/ProjectSelector';
import { TopBar } from '../app/TopBar';
import { ProviderActivity } from '../features/workflow/ProviderActivity';
import type { Node } from '../../shared/contracts';
import { readAgentDraft, writeAgentDraft } from '../hooks/useAgentDraft';

test('unsent drafts survive overlay remounts, isolate agents and clear only the submitted draft', () => {
  const first = JSON.stringify(['draft-project', 'first']), second = JSON.stringify(['draft-project', 'second']);
  writeAgentDraft(first, 'unfinished question'); writeAgentDraft(second, 'another task');
  assert.equal(readAgentDraft(first), 'unfinished question');
  assert.equal(readAgentDraft(second), 'another task');
  writeAgentDraft(first, 'latest edit');
  assert.equal(readAgentDraft(first), 'latest edit');
  writeAgentDraft(first, '');
  assert.equal(readAgentDraft(first), ''); assert.equal(readAgentDraft(second), 'another task');
  writeAgentDraft(second, '');
});

test('provider errors render in Chat and reasoning dots require live working nonstale evidence', () => {
  const node = { state: 'working', liveness: 'live', stale: false, providerActivity: { data: [
    { id: 'error', kind: 'error', state: 'recorded', at: null, message: 'Bad Request <script>' },
    { id: 'reason', kind: 'reasoning', state: 'active', at: null },
  ], meta: { stale: false } } } as Node;
  const html = renderToStaticMarkup(createElement(ProviderActivity, { node }));
  assert.match(html, /Bad Request &lt;script&gt;/); assert.match(html, /provider-reasoning-dots/);
  assert.ok(!html.includes('Reasoning recorded'));
  const recorded = { ...node, providerActivity: { ...node.providerActivity!, data: [{ id: 'past', kind: 'reasoning' as const, state: 'recorded' as const, at: null }] } };
  assert.match(renderToStaticMarkup(createElement(ProviderActivity, { node: recorded })), /aria-label="Agent working"/);
  assert.equal(renderToStaticMarkup(createElement(ProviderActivity, { node: { ...recorded, state: 'completed' } })), '');
  for (const patch of [{ state: 'failed' }, { liveness: 'exited' }, { stale: true }]) {
    assert.ok(!renderToStaticMarkup(createElement(ProviderActivity, { node: { ...node, ...patch } as Node })).includes('provider-reasoning-dots'));
  }
});

test('all providers show one live working indicator before reasoning or assistant records are flushed', () => {
  for (const agentType of ['codebuddy', 'antigravity', 'opencode', 'opencode2', 'kilo', 'codex', 'claude']) {
    const node = { agentType, state: 'working', liveness: 'live', stale: false } as Node;
    const html = renderToStaticMarkup(createElement(ProviderActivity, { node }));
    assert.match(html, /aria-label="Agent working"/);
    assert.equal(html.match(/class="provider-reasoning-dots"/g)?.length, 1);
    assert.ok(!html.includes('Reasoning recorded'));
    for (const state of ['completed', 'failed', 'waiting', 'idle', 'unknown', 'interrupted'] as const) {
      assert.equal(renderToStaticMarkup(createElement(ProviderActivity, { node: { ...node, state } })), '');
    }
  }
});

test('top bar keeps Vade branding in the updated application layout', () => {
  const html = renderToStaticMarkup(createElement(TopBar, {
    topbarRef: { current: null }, runs: [], selectedRunId: null, onSelectRun: () => {},
  }));
  assert.match(html, /vade\.svg/);
  assert.match(html, />Vade<\/h1>/);
});
import { SettingsPage } from '../app/SettingsPage';
import { primaryWindow, remainingTime, usageGroups } from '../features/usage/usagePresentation';
import { ProviderUsageDetails } from '../features/usage/UsagePanel';
import type { ProviderUsage } from '../../shared/contracts';
import { isTerminalReply, isTerminalClipboardShortcut } from '../features/workflow/terminalInput';
import { ConversationToolCall, compactEditLines } from '../features/workflow/ConversationToolCall';
import { conversationTimeline } from '../features/workflow/ConversationHistory';

test('terminal protocol responses are excluded from keyboard input while commands and navigation remain input', () => {
  for (const reply of ['\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b[1;2R', '\x1b]10;rgb:eded/eded/eded\x1b\\', '\x1b]11;rgb:1818/1818/1818\x07']) assert.equal(isTerminalReply(reply), true);
  for (const input of ['node --version\r', '\x1b[A', '\x03', '\x1b[200~echo test\x1b[201~']) assert.equal(isTerminalReply(input), false);
});

test('chat tool records preserve chronological scope and edit disclosures open by default', () => {
  const edit = { id: 'edit', at: '2026-10-21T02:00:00Z', label: 'Edit: example.ts', edits: [{ path: 'example.ts', lines: [{ kind: 'remove' as const, text: 'before' }, { kind: 'add' as const, text: 'after' }], truncated: false }] };
  const run = { id: 'run', at: '2026-10-21T03:00:00Z', label: 'Run: npm test', detail: 'Run: npm test' };
  const markup = renderToStaticMarkup(createElement(ConversationToolCall, { tool: edit }));
  assert.match(markup, /aria-expanded="true"/); assert.match(markup, /tool-edit-remove/); assert.match(markup, /tool-edit-add/);
  const plain = renderToStaticMarkup(createElement(ConversationToolCall, { tool: run }));
  assert.match(plain, /conversation-tool-call-plain/); assert.doesNotMatch(plain, /aria-expanded/);
  assert.match(renderToStaticMarkup(createElement(ConversationToolCall, { tool: { ...run, detail: `Run: npm test -- ${'x'.repeat(200)}` } })), /aria-expanded="false"/);
  const excerpt = compactEditLines([...Array.from({ length: 6 }, () => ({ kind: 'remove' as const, text: 'before' })), ...Array.from({ length: 6 }, () => ({ kind: 'add' as const, text: 'after' }))]);
  assert.equal(excerpt.filter(line => line.kind === 'remove').length, 3);
  assert.equal(excerpt.filter(line => line.kind === 'add').length, 3);
  const message = { id: 'user', at: '2026-10-21T01:00:00Z', role: 'user' as const, text: 'Please edit' };
  assert.deepEqual(conversationTimeline([message], [run, edit, { ...run, id: 'old', at: '2026-10-20T00:00:00Z' }], true).map(item => item.id), ['user', 'edit', 'run']);
});

test('usage summaries preserve reset timing and distinguish Antigravity model pools', () => {
  const now = Date.parse('2026-10-21T00:00:00Z');
  assert.equal(remainingTime(null, now), null);
  assert.equal(remainingTime('invalid', now), null);
  assert.equal(remainingTime('2026-10-21T04:17:00Z', now), '4h 17m');
  const provider: ProviderUsage = { provider: 'codex', label: 'Codex', windows: [
    { label: '5h', usedPercent: 27, resetsAt: '2026-10-21T04:17:00Z' },
    { label: '7d', usedPercent: 41, resetsAt: '2026-10-26T16:00:00Z' },
  ], buckets: [], meta: { availability: 'ready', observedAt: new Date(now).toISOString(), attemptedAt: new Date(now).toISOString(), partial: false, stale: false, issue: null } };
  assert.deepEqual(usageGroups(provider), [{ label: null, windows: provider.windows }]);
  const agy = { ...provider, provider: 'antigravity', windows: [
    { label: 'Gemini Models weekly', usedPercent: 56, resetsAt: null },
    { label: 'Gemini Models 5h', usedPercent: 0, resetsAt: null },
    { label: 'Claude and GPT models weekly', usedPercent: 6, resetsAt: null },
  ] };
  assert.equal(primaryWindow(agy)?.usedPercent, 0);
  const groups = usageGroups(agy);
  assert.deepEqual(groups.map(group => group.label), ['Gemini', 'Claude/GPT']);
  assert.deepEqual(groups[0].windows.map(w => w.usedPercent), [0, 56]);
  assert.equal(groups[1].windows[0].usedPercent, 6);
  for (const id of ['codex', 'claude', 'antigravity']) {
    const html = renderToStaticMarkup(createElement(ProviderUsageDetails, { provider: { ...provider, provider: id, label: id } }));
    assert.match(html, /27% used/); assert.match(html, /41% used/);
    assert.match(html, /aria-valuenow="27"/); assert.match(html, /aria-valuenow="41"/);
    assert.match(html, /Updated/);
  }
});

test('Settings is a dedicated page with category navigation and existing preference values', () => {
  const html = renderToStaticMarkup(createElement(SettingsPage, {
    section: 'workflow', onBack: () => {}, theme: 'dark', onToggleTheme: () => {},
    cardStateColors: true, onToggleCardStateColors: () => {},
    toolActivityEnabled: false, onToggleToolActivity: () => {},
  }));
  assert.match(html, /Back to app/);
  assert.match(html, /Search settings/);
  assert.match(html, /href="#\/settings\/general"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /Live tool nodes/);
  assert.match(html, /Card state colors/);
  assert.ok(!html.includes('Agent details'));
  assert.ok(!html.includes('role="dialog"') && !html.includes('popover'));
  const general = renderToStaticMarkup(createElement(SettingsPage, {
    section: 'general', onBack: () => {}, theme: 'light', onToggleTheme: () => {},
    cardStateColors: true, onToggleCardStateColors: () => {},
  }));
  assert.match(general, /Appearance/);
  assert.match(general, /current theme is light/);
  assert.ok(!general.includes('Live tool nodes'));
});
import { DEFAULT_VISIBLE_SECTIONS } from '../features/workflow/NodeDetails';
import { PrerequisitesGate } from '../components/ui/PrerequisitesGate';
import { ConfirmationDialog } from '../components/ui/ConfirmationDialog';
import { RenameDialog } from '../components/ui/RenameDialog';
import { AddAgentDialog } from '../components/ui/AddAgentDialog';
import { AgentPicker } from '../components/ui/AgentPicker';
import { Disclosure } from '../components/ui/Disclosure';
import { Icon } from '../components/ui/Icon';
import { popoverPortalHost } from '../components/ui/Popover';
import { AgentChatControls } from '../features/workflow/AgentChatControls';
import { useConfirmationState } from '../hooks/useConfirmationState';
import type { PrerequisitesStatus } from '../../shared/contracts';
import { useDashboardLayoutPrefs } from '../app/useDashboardLayoutPrefs';
import { cachedAgentCatalog, fetchAgentCatalog, resumeTerminal, saveAgentPreferences } from '../api/client';

test('agent catalog shares reads, isolates cancellation and invalidates after preferences change', async () => {
  const original = globalThis.fetch;
  let calls = 0, release!: (response: Response) => void;
  globalThis.fetch = async () => { calls++; return new Promise<Response>(resolve => { release = resolve; }); };
  const value = { runtime: 'ade', installed: [], available: [], defaultAgentId: null };
  try {
    const abort = new AbortController();
    const cancelled = fetchAgentCatalog(abort.signal, true);
    const cancelledCheck = assert.rejects(cancelled, /abort/i);
    const active = fetchAgentCatalog(undefined, true);
    assert.equal(calls, 1); abort.abort();
    release(new Response(JSON.stringify(value))); await cancelledCheck; await active;
    assert.deepEqual(cachedAgentCatalog(), value);
    await fetchAgentCatalog(); assert.equal(calls, 1);
    const save = saveAgentPreferences({} as any); release(new Response('{}')); await save;
    assert.equal(cachedAgentCatalog(), null);
  } finally { globalThis.fetch = original; }
});

test('concurrent terminal recovery shares one exact-session request and allows later explicit recovery', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  let release!: (response: Response) => void;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/projects/project/nodes/agent/resume');
    assert.equal(options?.method, 'POST'); assert.equal(options?.body, '{}');
    calls++;
    return new Promise<Response>(resolve => { release = resolve; });
  };
  try {
    const first = resumeTerminal('project', 'agent');
    const second = resumeTerminal('project', 'agent');
    assert.equal(first, second); assert.equal(calls, 1);
    release(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await Promise.all([first, second]);
    const later = resumeTerminal('project', 'agent'); assert.equal(calls, 2);
    release(new Response(JSON.stringify({ ok: true }), { status: 200 })); await later;
  } finally { globalThis.fetch = original; }
});

test('composer picker starts closed and preserves observed model and effort without inventing capabilities', () => {
  const html = renderToStaticMarkup(createElement(AgentChatControls, { projectId: 'project', nodeId: 'agent', runId: 'run', model: 'gpt-5.6-sol', effort: 'high' }));
  assert.match(html, /gpt-5.6-sol/);
  assert.match(html, /high/);
  assert.match(html, /<button[^>]*type="button"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Search models|Standard|Fast|role="dialog"|aria-pressed/);
});

test('composer picker uses an explicit unknown label and disables actions while its session is busy', () => {
  const html = renderToStaticMarkup(createElement(AgentChatControls, { projectId: 'project', nodeId: 'agent', runId: null, model: 'unknown', effort: 'unknown', disabled: true }));
  assert.match(html, /Model settings/);
  assert.match(html, /<button[^>]*disabled=""/);
  assert.doesNotMatch(html, />unknown<|Standard|Fast|aria-pressed/);
});

test('portaled pickers remain inside their native modal so search and actions are not inert', () => {
  const body = {} as HTMLElement;
  const dialog = {} as Element;
  const trigger = { closest: (selector: string) => { assert.equal(selector, 'dialog[open]'); return dialog; } } as unknown as HTMLElement;
  assert.equal(popoverPortalHost(trigger, body), dialog);
  assert.equal(popoverPortalHost({ closest: () => null } as unknown as HTMLElement, body), body);
  assert.equal(popoverPortalHost(null, body), body);
});

test('mobile starts with closed drawers while preserving saved desktop sidebar preferences', () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const saved = new Map([['orca-sidebar-left-open', 'true'], ['orca-sidebar-right-open', 'true']]);
  const viewport = { innerWidth: 350, innerHeight: 740, matchMedia: () => ({ matches: false }) };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: viewport });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value),
  } });
  function LayoutProbe() {
    const prefs = useDashboardLayoutPrefs();
    return createElement('div', { 'data-left': prefs.leftSidebarOpen, 'data-right': prefs.rightSidebarOpen });
  }
  try {
    const mobile = renderToStaticMarkup(createElement(LayoutProbe));
    assert.match(mobile, /data-left="false"/);
    assert.match(mobile, /data-right="false"/);
    assert.equal(saved.get('orca-sidebar-left-open'), 'true');
    assert.equal(saved.get('orca-sidebar-right-open'), 'true');
    viewport.innerWidth = 1400;
    const desktop = renderToStaticMarkup(createElement(LayoutProbe));
    assert.match(desktop, /data-left="true"/);
    assert.match(desktop, /data-right="true"/);
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('provider icons distinguish Gemini and Antigravity and cover Orca’s bundled catalog', () => {
  assert.equal(normalizeProvider('gemini').id, 'gemini');
  assert.equal(normalizeProvider('agy').id, 'antigravity');
  assert.equal(normalizeProvider('opencode-go').id, 'opencode-go');
  assert.equal(normalizeProvider('claude-agent-teams').id, 'claude');
  assert.equal(normalizeProvider('dsb').id, 'dsh');
  for (const provider of [...Object.keys(ORCA_PROVIDER_IMAGES), 'codex', 'claude', 'minimax', 'opencode-go', 'opencode', 'kilo', 'pi', 'omp', 'aider', 'copilot', 'droid']) {
    assert.notEqual(normalizeProvider(provider).id, 'unknown', provider);
    const html = renderToStaticMarkup(createElement(ProviderIcon, { provider }));
    assert.ok(!html.includes('>?</text>'), provider);
  }
  assert.equal(normalizeProvider('unrecognized-agent').id, 'unknown');
  const ag = renderToStaticMarkup(createElement(ProviderIcon, { provider: 'antigravity' }));
  assert.ok(ag.includes('providers/orca/antigravity.png'));
});

test('shared disclosures keep collapsed controls inert and defer lazy history loading', () => {
  const collapsed = renderToStaticMarkup(createElement(Disclosure, { title: 'Advanced', children: createElement('input', { name: 'field' }), compact: true }));
  assert.ok(collapsed.includes('aria-expanded="false"'));
  assert.ok(collapsed.includes('inert=""'));
  assert.ok(collapsed.includes('disclosure-chevron'));
  const lazy = renderToStaticMarkup(createElement(Disclosure, { title: 'History', lazy: true, children: 'EXPENSIVE HISTORY' }));
  assert.ok(!lazy.includes('EXPENSIVE HISTORY'));
});

test('ProjectSelector renders settings controls in sidebar', () => {
  const html = renderToStaticMarkup(createElement(ProjectSelector, {
    standalone: true,
    inventorySection: null,
    loading: false,
    error: null,
    selectedProjectId: null,
    onSelectProject: () => {},
    snapshot: null,
    isLocallyStale: false,
    connectionMode: 'sse',
    theme: 'dark',
    onToggleTheme: () => {},
    cardStateColors: true,
    onToggleCardStateColors: () => {},
    visibleSections: DEFAULT_VISIBLE_SECTIONS,
    onToggleVisibleSection: () => {},
    onResetVisibleSections: () => {},
  }));
  assert.ok(html.includes('Dashboard settings'));
  assert.match(html, /aria-label="Dashboard settings"/);
  assert.ok(!html.includes('>Settings<'));
  assert.ok(!html.includes('runtime-status-card'));
});

test('ProjectSelector renders expandable chevron toggle and all projects when expanded', () => {
  const inventory = {
    meta: { availability: 'ready', stale: false, observedAt: null, attemptedAt: null, partial: false, issue: null },
    data: {
      version: '0.1.0',
      projects: [
        { id: 'proj-1', name: 'Alpha Project', kind: 'git', paths: ['/path/to/alpha'] },
        { id: 'proj-2', name: 'Beta Project', kind: 'folder', paths: ['/path/to/beta'] },
        { id: 'proj-3', name: 'Gamma Project', kind: 'git', paths: ['/path/to/gamma'] },
      ],
    },
  } as unknown as any;

  const html = renderToStaticMarkup(createElement(ProjectSelector, {
    inventorySection: inventory,
    loading: false,
    error: null,
    selectedProjectId: 'proj-2',
    onSelectProject: () => {},
    snapshot: null,
    isLocallyStale: false,
    connectionMode: 'sse',
    theme: 'dark',
    onToggleTheme: () => {},
    cardStateColors: true,
    onToggleCardStateColors: () => {},
    visibleSections: DEFAULT_VISIBLE_SECTIONS,
  }));

  assert.ok(html.includes('rail-section-toggle-btn'));
  assert.ok(html.includes('aria-expanded="true"'));
  assert.ok(html.includes('rail-chevron-icon is-expanded'));
  assert.ok(html.includes('Alpha Project'));
  assert.ok(html.includes('Beta Project'));
  assert.ok(html.includes('Gamma Project'));
  assert.equal(html.includes('is-collapsed-hidden'), false);
});

test('ProjectSelector marks non-current projects as collapsed-hidden for smooth animation when collapsed', () => {
  const inventory = {
    meta: { availability: 'ready', stale: false, observedAt: null, attemptedAt: null, partial: false, issue: null },
    data: {
      version: '0.1.0',
      projects: [
        { id: 'proj-1', name: 'Alpha Project', kind: 'git', paths: ['/path/to/alpha'] },
        { id: 'proj-2', name: 'Beta Project', kind: 'folder', paths: ['/path/to/beta'] },
        { id: 'proj-3', name: 'Gamma Project', kind: 'git', paths: ['/path/to/gamma'] },
      ],
    },
  } as unknown as any;

  const store = new Map<string, string>();
  store.set('orca-projects-expanded', 'false');
  const originalLocalStorage = (globalThis as any).localStorage;
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => store.set(key, String(val)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  };

  try {
    const html = renderToStaticMarkup(createElement(ProjectSelector, {
      inventorySection: inventory,
      loading: false,
      error: null,
      selectedProjectId: 'proj-2',
      onSelectProject: () => {},
      snapshot: null,
      isLocallyStale: false,
      connectionMode: 'sse',
      theme: 'dark',
      onToggleTheme: () => {},
      cardStateColors: true,
      onToggleCardStateColors: () => {},
      visibleSections: DEFAULT_VISIBLE_SECTIONS,
    }));

    assert.ok(html.includes('aria-expanded="false"'));
    assert.ok(!html.includes('rail-chevron-icon is-expanded'));

    const listHtml = html.slice(html.indexOf('id="rail-project-list"'));

    const betaIndex = listHtml.indexOf('Beta Project');
    const betaSnippet = listHtml.slice(Math.max(0, betaIndex - 250), betaIndex);
    assert.equal(betaSnippet.includes('is-collapsed-hidden'), false);

    const alphaIndex = listHtml.indexOf('Alpha Project');
    const alphaSnippet = listHtml.slice(Math.max(0, alphaIndex - 250), alphaIndex);
    assert.ok(alphaSnippet.includes('is-collapsed-hidden'));
    assert.ok(alphaSnippet.includes('aria-hidden="true"'));

    const gammaIndex = listHtml.indexOf('Gamma Project');
    const gammaSnippet = listHtml.slice(Math.max(0, gammaIndex - 250), gammaIndex);
    assert.ok(gammaSnippet.includes('is-collapsed-hidden'));
    assert.ok(gammaSnippet.includes('aria-hidden="true"'));

    const htmlNoSelection = renderToStaticMarkup(createElement(ProjectSelector, {
      inventorySection: inventory,
      loading: false,
      error: null,
      selectedProjectId: null,
      onSelectProject: () => {},
      snapshot: null,
      isLocallyStale: false,
      connectionMode: 'sse',
      theme: 'dark',
      onToggleTheme: () => {},
      cardStateColors: true,
      onToggleCardStateColors: () => {},
      visibleSections: DEFAULT_VISIBLE_SECTIONS,
    }));
    const listHtmlNoSelection = htmlNoSelection.slice(htmlNoSelection.indexOf('id="rail-project-list"'));

    const alphaNoSelectionIndex = listHtmlNoSelection.indexOf('Alpha Project');
    const alphaNoSelection = listHtmlNoSelection.slice(Math.max(0, alphaNoSelectionIndex - 250), alphaNoSelectionIndex);
    assert.equal(alphaNoSelection.includes('is-collapsed-hidden'), false);

    const betaNoSelectionIndex = listHtmlNoSelection.indexOf('Beta Project');
    const betaNoSelection = listHtmlNoSelection.slice(Math.max(0, betaNoSelectionIndex - 250), betaNoSelectionIndex);
    assert.ok(betaNoSelection.includes('is-collapsed-hidden'));
  } finally {
    if (originalLocalStorage !== undefined) {
      (globalThis as any).localStorage = originalLocalStorage;
    } else {
      delete (globalThis as any).localStorage;
    }
  }
});

test('PrerequisitesGate returns null when all prerequisites are ready', () => {
  const readyStatus: PrerequisitesStatus = {
    orcaApp: true,
    orcaAppOpen: true,
    orcaCli: true,
    orchestrationSkill: true,
    orcaCliSkill: true,
    ready: true,
    version: '1.4.224',
  };
  const html = renderToStaticMarkup(createElement(PrerequisitesGate, {
    prerequisites: readyStatus,
    loading: false,
    onRecheck: () => {},
    isChecking: false,
  }));
  assert.equal(html, '');
});

test('PrerequisitesGate shows "Orca not downloaded" and link to https://www.onorca.dev/ when orcaApp is missing', () => {
  const missingApp: PrerequisitesStatus = {
    orcaApp: false,
    orcaAppOpen: false,
    orcaCli: false,
    orchestrationSkill: false,
    orcaCliSkill: false,
    ready: false,
  };
  const html = renderToStaticMarkup(createElement(PrerequisitesGate, {
    prerequisites: missingApp,
    loading: false,
    onRecheck: () => {},
    isChecking: false,
  }));
  assert.ok(html.includes('Orca Prerequisites Required'));
  assert.ok(html.includes('Orca not downloaded'));
  assert.ok(html.includes('https://www.onorca.dev/'));
  assert.ok(html.includes('Download Orca'));
});

test('PrerequisitesGate shows app closed notice when installed but not open', () => {
  const appClosed: PrerequisitesStatus = {
    orcaApp: true,
    orcaAppOpen: false,
    orcaCli: true,
    orchestrationSkill: true,
    orcaCliSkill: true,
    ready: false,
    version: '1.4.224',
  };
  const html = renderToStaticMarkup(createElement(PrerequisitesGate, {
    prerequisites: appClosed,
    loading: false,
    onRecheck: () => {},
    isChecking: false,
  }));
  assert.ok(html.includes('Not Running'));
  assert.ok(html.includes('Installed (v1.4.224) - Closed'));
  assert.ok(html.includes('Orca desktop application is installed, but it is currently closed.'));
  assert.ok(html.includes('Please open the'));
  assert.ok(html.includes('data-testid="prereq-app-closed-notice"'));
});

test('PrerequisitesGate asks to download through Orca app when CLI or Orchestration skill is missing', () => {
  const missingCliAndSkill: PrerequisitesStatus = {
    orcaApp: true,
    orcaAppOpen: true,
    orcaCli: false,
    orchestrationSkill: false,
    orcaCliSkill: true,
    ready: false,
    version: '1.4.224',
  };
  const html = renderToStaticMarkup(createElement(PrerequisitesGate, {
    prerequisites: missingCliAndSkill,
    loading: false,
    onRecheck: () => {},
    isChecking: false,
  }));
  assert.ok(html.includes('Detected (v1.4.224)'));
  assert.ok(html.includes('Orca-cli not downloaded'));
  assert.ok(html.includes('Open the Orca desktop app, go to'));
  assert.ok(html.includes('Settings &gt; CLI'));
  assert.ok(html.includes('Orchestration skill not downloaded'));
  assert.ok(html.includes('Skills'));
});

test('PrerequisitesGate shows orca-cli skill missing and command to install', () => {
  const missingSkill: PrerequisitesStatus = {
    orcaApp: true,
    orcaAppOpen: true,
    orcaCli: true,
    orchestrationSkill: true,
    orcaCliSkill: false,
    ready: false,
    version: '1.4.224',
  };
  const html = renderToStaticMarkup(createElement(PrerequisitesGate, {
    prerequisites: missingSkill,
    loading: false,
    onRecheck: () => {},
    isChecking: false,
  }));
  assert.ok(html.includes('Orca CLI Agent Skill (orca-cli)'));
  assert.ok(html.includes('Orca-cli skill not installed'));
  assert.ok(html.includes('npx skills add https://github.com/stablyai/orca --skill orca-cli'));
});

test('PrerequisitesGate renders loading state when initially loading without data', () => {
  const html = renderToStaticMarkup(createElement(PrerequisitesGate, {
    prerequisites: null,
    loading: true,
    onRecheck: () => {},
    isChecking: false,
  }));
  assert.ok(html.includes('Connecting to Vade'));
  assert.ok(html.includes('prereq-spinner'));
});

test('ConfirmationDialog renders open modal with title, description, and action buttons', () => {
  const html = renderToStaticMarkup(createElement(ConfirmationDialog, {
    isOpen: true,
    isClosing: false,
    title: 'Delete Worktree?',
    description: 'Are you sure you want to delete worktree test-wt?',
    confirmLabel: 'Delete Worktree',
    confirmVariant: 'danger',
    isConfirming: false,
    error: null,
    onConfirm: () => {},
    onClose: () => {},
  }));

  assert.ok(html.includes('Delete Worktree?'));
  assert.ok(html.includes('Are you sure you want to delete worktree test-wt?'));
  assert.ok(html.includes('btn-danger'));
  assert.ok(html.includes('confirmation-dialog'));
  assert.equal(html.includes('is-closing'), false);
});

test('ConfirmationDialog renders with is-closing animation class during exit phase', () => {
  const html = renderToStaticMarkup(createElement(ConfirmationDialog, {
    isOpen: true,
    isClosing: true,
    title: 'Close Agent Tab?',
    description: 'Are you sure?',
    onConfirm: () => {},
    onClose: () => {},
  }));

  assert.ok(html.includes('confirmation-dialog'));
  assert.ok(html.includes('is-closing'));
});

test('ConfirmationDialog displays error alert when error is provided', () => {
  const html = renderToStaticMarkup(createElement(ConfirmationDialog, {
    isOpen: true,
    isClosing: false,
    title: 'Delete Worktree?',
    description: 'Are you sure?',
    error: 'Worktree is locked by git',
    onConfirm: () => {},
    onClose: () => {},
  }));

  assert.ok(html.includes('panel-alert alert-error'));
  assert.ok(html.includes('Worktree is locked by git'));
});

test('ConfirmationDialog shows processing label and disables buttons when isConfirming is true', () => {
  const html = renderToStaticMarkup(createElement(ConfirmationDialog, {
    isOpen: true,
    isClosing: false,
    title: 'Close Agent Tab?',
    description: 'Are you sure?',
    confirmLabel: 'Close Tab',
    isConfirming: true,
    onConfirm: () => {},
    onClose: () => {},
  }));

  assert.ok(html.includes('Processing…'));
  assert.ok(html.includes('disabled=""'));
});

test('ConfirmationDialog returns null when isOpen is false', () => {
  const html = renderToStaticMarkup(createElement(ConfirmationDialog, {
    isOpen: false,
    isClosing: false,
    title: 'Delete Worktree?',
    description: 'Are you sure?',
    onConfirm: () => {},
    onClose: () => {},
  }));

  assert.equal(html, '');
});

test('useConfirmationState initializes closed and reset() ensures closed state', () => {
  let hookResult: any;
  function TestComponent() {
    hookResult = useConfirmationState();
    return null;
  }
  renderToStaticMarkup(createElement(TestComponent));
  assert.equal(hookResult.present, false);
  assert.equal(hookResult.closing, false);
  assert.equal(hookResult.data, null);

  hookResult.close();
  assert.equal(hookResult.closing, false);

  hookResult.reset();
  assert.equal(hookResult.present, false);
  assert.equal(hookResult.closing, false);
  assert.equal(hookResult.data, null);
});

test('ConfirmationDialog renders standardized Reset layout dialog', () => {
  const html = renderToStaticMarkup(createElement(ConfirmationDialog, {
    isOpen: true,
    isClosing: false,
    title: 'Reset layout?',
    description: 'Return cards and worktrees in this project to their default positions. Your saved layout will be cleared.',
    confirmLabel: 'Reset layout',
    confirmVariant: 'danger',
    onConfirm: () => {},
    onClose: () => {},
  }));

  assert.ok(html.includes('Reset layout?'));
  assert.ok(html.includes('Your saved layout will be cleared.'));
  assert.ok(html.includes('btn-danger'));
});

test('RenameDialog renders input field with initial title and action buttons', () => {
  const html = renderToStaticMarkup(
    createElement(RenameDialog, {
      isOpen: true,
      isClosing: false,
      initialTitle: 'Original Title',
      onRename: () => {},
      onClose: () => {},
    })
  );

  assert.ok(html.includes('Rename Tab Title'));
  assert.ok(html.includes('value="Original Title"'));
  assert.ok(html.includes('Cancel'));
  assert.ok(html.includes('Save'));
});

test('AddAgentDialog waits for detected agents instead of fabricating installed choices', () => {
  const html = renderToStaticMarkup(
    createElement(AddAgentDialog, {
      isOpen: true,
      isClosing: false,
      worktreeName: 'feature-branch',
      onCreate: () => {},
      onClose: () => {},
    })
  );

  assert.ok(html.includes('Add New Agent'));
  assert.ok(html.includes('aria-label="Close add agent"'));
  assert.ok(html.includes('overlay-close-button'));
  assert.ok(html.includes('feature-branch'));
  assert.ok(html.includes('Detecting agents'));
  assert.ok(!html.includes('Codex'));
  assert.ok(!html.includes('Claude'));
  assert.ok(!html.includes('Agent command'), 'custom commands stay hidden until a legacy catalog confirms support');
  assert.ok(html.includes('Create Agent'));
});

test('AgentPicker renders observed catalog names with provider icons and optional blank terminal', () => {
  const props = { agents: [{ id: 'observed-id', name: 'Detected custom agent', provider: 'codex', command: 'observed-command', detectCmd: 'observed-command', installed: true }], onChange: () => {}, onRetry: () => {} };
  const selected = renderToStaticMarkup(createElement(AgentPicker, { ...props, value: 'observed-id' }));
  assert.ok(selected.includes('Detected custom agent'));
  assert.ok(selected.includes('Provider: codex'));
  assert.ok(!selected.includes('Claude'));
  assert.ok(selected.includes('aria-haspopup="dialog"'));
  const blank = renderToStaticMarkup(createElement(AgentPicker, { ...props, value: '', optional: true }));
  assert.ok(blank.includes('Blank Terminal'));
});

test('Icon component renders arrow-down and arrow-up paths correctly', () => {
  const downHtml = renderToStaticMarkup(createElement(Icon, { name: 'arrow-down', size: 12 }));
  assert.ok(downHtml.includes('<polyline points="19 12 12 19 5 12"'), 'arrow-down polyline must render');

  const upHtml = renderToStaticMarkup(createElement(Icon, { name: 'arrow-up', size: 12 }));
  assert.ok(upHtml.includes('<polyline points="5 12 12 5 19 12"'), 'arrow-up polyline must render');
});


test('clipboard shortcuts bypass Kitty encoding without stealing Ctrl+C interruption', () => {
  const key = { ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: 'v' };
  assert.equal(isTerminalClipboardShortcut(key, false), true);
  assert.equal(isTerminalClipboardShortcut({ ...key, shiftKey: true }, false), true);
  assert.equal(isTerminalClipboardShortcut({ ...key, key: 'c' }, false), false);
  assert.equal(isTerminalClipboardShortcut({ ...key, key: 'c' }, true), true);
  assert.equal(isTerminalClipboardShortcut({ ...key, key: 'Insert', shiftKey: true, ctrlKey: false }, false), true);
  assert.equal(isTerminalClipboardShortcut({ ...key, key: 'a' }, false), false);
});

import { AgentHistoryPanel } from '../features/agents/AgentHistoryPanel';
test('agent history exposes workspace/project/all scopes and an explicit target worktree', () => {
  const html = renderToStaticMarkup(createElement(AgentHistoryPanel, { projectId: 'project', worktrees: [{ id: 'worktree', label: 'Main checkout', kind: 'worktree' } as any], onResume: async () => {}, onOpen: () => {} }));
  assert.match(html, /Session scope/);
  for (const label of ['Workspace', 'Project', 'All', 'Target worktree', 'Search sessions', 'Refresh session history']) assert.ok(html.includes(label));
  assert.match(html, /Main checkout/);
  assert.match(html, /Drag a stopped session/);
});
