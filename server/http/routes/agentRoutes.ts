import type { AgentPreferences } from '../../../shared/contracts.js';
import { CliError } from '../../integrations/cli.js';
import { permissionArgs, readAgentPreferences, saveAgentPreferences } from '../../runtime/system/agentPreferences.js';
import { section } from '../../runtime/localRuntime.js';
import { agentCatalog } from '../../runtime/sessions/sessions.js';
import { readInstalledSkills } from '../../runtime/workflow/skills.js';
import { type RouteContext, text } from '../routeContext.js';

export async function handleAgentRoutes(ctx: RouteContext): Promise<boolean> {
  const { runtime, method, pathname, query, sendJson, requireMethod, queryKeys, body } = ctx;

  if (pathname === '/api/agent-history') {
    requireMethod('GET');
    queryKeys('scope', 'projectId', 'worktreeId', 'search', 'offset', 'refresh');
    const scope = query.get('scope') ?? 'project';
    if (!['workspace', 'project', 'all'].includes(scope) || (query.has('refresh') && query.get('refresh') !== '1')) {
      throw new CliError('INVALID_ARGUMENT', 'Invalid history scope or refresh');
    }
    const projectId = query.get('projectId') ?? undefined;
    if (scope !== 'all' && !projectId) throw new CliError('INVALID_ARGUMENT', 'Select a project for this history scope');
    const project = projectId ? runtime.store.project(projectId) : null;
    const trees = project ? await runtime.git.worktrees(project) : [];
    const workspace = query.get('worktreeId') ? trees.find(tree => tree.id === query.get('worktreeId')) : trees.find(tree => tree.main);
    if (query.has('worktreeId') && !workspace) throw new CliError('NODE_NOT_FOUND', 'Worktree does not belong to the selected project');
    const offset = query.get('offset') ?? '0';
    const search = query.get('search') ?? '';
    if (!/^\d{1,6}$/.test(offset) || Number(offset) > 100000 || search.length > 200) {
      throw new CliError('INVALID_ARGUMENT', 'Invalid history offset or search');
    }
    await runtime.history.refresh(query.get('refresh') === '1');
    sendJson(
      200,
      runtime.history.list(
        {
          scope: scope as 'workspace' | 'project' | 'all',
          projectId,
          paths: trees.map(tree => tree.path),
          workspace: workspace?.path,
          search,
          offset: Number(offset),
        },
        (pid, id) => runtime.sessions.page(pid, id, Number.MAX_SAFE_INTEGER).live,
      ),
    );
    return true;
  }

  const historyResume = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/resume-history$/);
  if (historyResume) {
    requireMethod('POST');
    queryKeys();
    const request = await body<{ sessionId: string; worktreeId: string }>(['sessionId', 'worktreeId']);
    const project = runtime.store.project(historyResume[1]);
    const tree = await runtime.git.requireWorktree(project, text(request.worktreeId, 'worktree ID'));
    const source = await runtime.history.get(text(request.sessionId, 'history session ID', 40));
    const record = await runtime.sessions.resumeHistory(project.id, tree.id, tree.path, source);
    sendJson(200, { nodeId: record.id, projectId: record.projectId });
    return true;
  }

  if (pathname === '/api/agents/settings') {
    queryKeys();
    if (method === 'POST') saveAgentPreferences(runtime.store, await body<AgentPreferences>(['defaultAgent', 'providers']));
    else requireMethod('GET');
    sendJson(200, readAgentPreferences(runtime.store));
    return true;
  }

  if (pathname === '/api/agents/catalog') {
    requireMethod('GET');
    queryKeys();
    const catalog = agentCatalog();
    const preferences = readAgentPreferences(runtime.store);
    catalog.installed = catalog.installed.filter(
      agent => agent.id === 'terminal' || preferences.providers[agent.id as keyof typeof preferences.providers]?.enabled,
    );
    for (const entry of catalog.available) {
      entry.isDefault = entry.id === preferences.defaultAgent;
      const modes = permissionArgs[entry.id as keyof typeof permissionArgs];
      if (modes) {
        entry.permissionCommands = Object.fromEntries(
          Object.entries(modes)
            .filter(([, args]) => args !== null)
            .map(([mode, args]) => [mode, [entry.command, ...args!].join(' ')]),
        );
      }
    }
    catalog.defaultAgentId = catalog.installed.find(agent => agent.id === preferences.defaultAgent)?.id ?? catalog.installed[0]?.id ?? null;
    sendJson(200, catalog);
    return true;
  }

  if (pathname === '/api/skills') {
    requireMethod('GET');
    queryKeys();
    // Personal skills are a bounded directory read; a missing directory is an empty list.
    sendJson(200, section(readInstalledSkills()));
    return true;
  }

  return false;
}
