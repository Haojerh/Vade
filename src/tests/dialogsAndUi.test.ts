import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { normalizeProvider, ProviderIcon } from '../components/providers/ProviderIcon';
import { ORCA_PROVIDER_IMAGES } from '../components/providers/OrcaProviderAssets';
import { ProjectSelector } from '../features/projects/ProjectSelector';
import { DEFAULT_VISIBLE_SECTIONS } from '../features/workflow/NodeDetails';
import { PrerequisitesGate } from '../components/ui/PrerequisitesGate';
import { ConfirmationDialog } from '../components/ui/ConfirmationDialog';
import { RenameDialog } from '../components/ui/RenameDialog';
import { AddAgentDialog } from '../components/ui/AddAgentDialog';
import { AgentPicker } from '../components/ui/AgentPicker';
import { Disclosure } from '../components/ui/Disclosure';
import { Icon } from '../components/ui/Icon';
import { useConfirmationState } from '../hooks/useConfirmationState';
import type { PrerequisitesStatus } from '../../shared/contracts';
import { useDashboardLayoutPrefs } from '../app/useDashboardLayoutPrefs';

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
  assert.ok(html.includes('Settings'));
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
  assert.ok(html.includes('Checking Orca Environment...'));
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
  assert.ok(html.includes('Agent command'));
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
