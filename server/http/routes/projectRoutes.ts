import type { CreateWorktreeRequest, GitHubQuery, Project, RegisterProjectRequest } from '../../../shared/contracts.js';
import { CliError } from '../../integrations/cli.js';
import { collectGitHubData } from '../../integrations/github.js';
import { section } from '../../runtime/localRuntime.js';
import { listProjectFolders } from '../../runtime/workspace/projectFolders.js';
import { addProject } from '../../runtime/workspace/projects.js';
import { projectShortcuts, runProjectShortcut, saveProjectShortcuts } from '../../runtime/workspace/projectShortcuts.js';
import { agentCatalog } from '../../runtime/sessions/sessions.js';
import { type RouteContext, text } from '../routeContext.js';
import { handleProjectStreamRoute } from './projectStreamRoutes.js';

export async function handleProjectTopLevelRoutes(ctx: RouteContext): Promise<boolean> {
  const { runtime, method, pathname, query, sendJson, requireMethod, queryKeys, body } = ctx;

  const shortcutRoute = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/shortcuts(?:\/([a-zA-Z0-9_-]+)\/run)?$/);
  if (shortcutRoute) {
    queryKeys();
    if (shortcutRoute[2]) {
      requireMethod('POST');
      const request = await body<{ worktreeId: string }>(['worktreeId']);
      sendJson(200, await runProjectShortcut(runtime, shortcutRoute[1], shortcutRoute[2], text(request.worktreeId, 'worktree ID')));
    } else if (method === 'POST') {
      const request = await body<{ shortcuts: unknown }>(['shortcuts'], 350000);
      sendJson(200, saveProjectShortcuts(runtime.store, shortcutRoute[1], request.shortcuts));
    } else {
      requireMethod('GET');
      sendJson(200, projectShortcuts(runtime.store, shortcutRoute[1]));
    }
    return true;
  }

  const deleteProject = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)$/);
  if (deleteProject && pathname !== '/api/projects/folders') {
    requireMethod('DELETE');
    queryKeys();
    runtime.store.deleteProject(deleteProject[1]);
    sendJson(200, { ok: true });
    return true;
  }

  if (pathname === '/api/projects/folders') {
    requireMethod('GET');
    queryKeys('path');
    sendJson(200, listProjectFolders(query.get('path') ?? undefined));
    return true;
  }

  if (pathname === '/api/projects') {
    queryKeys();
    if (method === 'POST') {
      const request = await body<RegisterProjectRequest>(['path', 'name', 'mode', 'url']);
      const project = await addProject(runtime.git, request);
      sendJson(201, { project });
    } else {
      requireMethod('GET');
      sendJson(200, section({ projects: await runtime.git.projects() }));
    }
    return true;
  }

  return false;
}

export async function handleProjectSubRoute(ctx: RouteContext, projectId: string, project: Project, route: string): Promise<boolean> {
  const { runtime, query, sendJson, requireMethod, queryKeys, body } = ctx;

  if (await handleProjectStreamRoute(ctx, projectId, route)) return true;

  if (route === 'github') {
    requireMethod('GET');
    queryKeys('scope', 'nodeId', 'activity', 'page');
    const scope = query.get('scope') ?? 'general';
    if (!['general', 'worktree'].includes(scope) || (scope === 'worktree' && !query.get('nodeId')) || (scope === 'general' && query.has('nodeId'))) {
      throw new CliError('INVALID_ARGUMENT', 'Invalid GitHub scope');
    }
    if (query.has('activity') && !['commits', 'prs', 'issues'].includes(query.get('activity')!)) {
      throw new CliError('INVALID_ARGUMENT', 'Invalid GitHub activity');
    }
    if (query.has('page') && !/^[1-9][0-9]{0,4}$/.test(query.get('page')!)) {
      throw new CliError('INVALID_ARGUMENT', 'Invalid GitHub page');
    }
    const selection = {
      scope,
      ...(scope === 'worktree' ? { nodeId: query.get('nodeId')! } : {}),
      ...(query.has('activity') ? { activity: query.get('activity') } : {}),
      ...(query.has('page') ? { page: Number(query.get('page')) } : {}),
    } as GitHubQuery;
    const snapshot = await runtime.snapshot(projectId);
    if (!snapshot.graph.data || snapshot.graph.meta.stale) {
      throw new CliError('SCOPE_UNAVAILABLE', 'Repository scope is unavailable');
    }
    sendJson(200, await collectGitHubData(project, selection, runtime.git.runner, snapshot.graph.data));
    return true;
  }

  if (route === 'commit-graph') {
    requireMethod('GET');
    queryKeys('nodeId');
    sendJson(200, await runtime.git.history(project, query.get('nodeId') ?? undefined));
    return true;
  }

  if (route === 'worktrees') {
    requireMethod('POST');
    queryKeys();
    const request = await body<CreateWorktreeRequest>(['name', 'baseBranch', 'from', 'setup', 'agentId']);
    if (request.agentId && !agentCatalog().installed.some(agent => agent.id === request.agentId)) {
      throw new CliError('INVALID_ARGUMENT', 'Select an installed agent');
    }
    const tree = await runtime.git.create(project, request);
    if (request.agentId) {
      try {
        await runtime.sessions.launch(projectId, tree.id, tree.path, request.agentId);
      } catch {
        sendJson(200, { ok: true, message: 'Worktree created. Agent could not start; open the worktree and add an agent.' });
        return true;
      }
    }
    sendJson(200, { ok: true, message: 'Worktree created' });
    return true;
  }

  return false;
}
