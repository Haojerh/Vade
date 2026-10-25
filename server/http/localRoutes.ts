import type http from 'node:http';
import type { AgentPreferences, AnswerAgentRequest, CreateWorktreeRequest, GitHubQuery, InboxItem, RegisterProjectRequest, SendMessageRequest, TerminalShell, SetAgentChatOptionRequest } from '../../shared/contracts.js';
import { permissionArgs, readAgentPreferences, saveAgentPreferences } from '../runtime/agentPreferences.js';
import { CliError } from '../integrations/cli.js';
import { collectGitHubData } from '../integrations/github.js';
import { LocalRuntime, section } from '../runtime/localRuntime.js';
import { agentCatalog } from '../runtime/sessions.js';
import { createResponseHelpers, parseJsonBody } from './httpUtils.js';
import { listProjectFolders } from '../runtime/projectFolders.js';
import { addProject } from '../runtime/projects.js';
import { projectShortcuts, runProjectShortcut, saveProjectShortcuts } from '../runtime/projectShortcuts.js';

function text(value: unknown, label: string, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new CliError('INVALID_ARGUMENT', `Invalid ${label}`);
  return value.trim();
}

export async function handleLocalRoute(runtime: LocalRuntime, req: http.IncomingMessage, res: http.ServerResponse, requestId: string, url: URL): Promise<void> {
  const { sendJson, sendError } = createResponseHelpers(res, requestId);
  const method = req.method ?? 'GET';
  const pathname = url.pathname;
  const query = url.searchParams;
  const requireMethod = (allowed: string) => {
    if (method !== allowed && !(allowed === 'GET' && method === 'HEAD')) throw new CliError('METHOD_NOT_ALLOWED', `Use ${allowed} for this endpoint`);
  };
  const queryKeys = (...keys: string[]) => {
    if ([...query.keys()].some(key => !keys.includes(key)) || [...query.keys()].some(key => query.getAll(key).length !== 1 || !query.get(key))) throw new CliError('INVALID_ARGUMENT', 'Unexpected, empty or duplicate query parameter');
    if (query.has('runId')) throw new CliError('RUN_NOT_FOUND', 'Standalone ADE has no orchestration runs');
  };
  const body = async <T extends object>(keys: string[], max = 8192): Promise<T> => {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new CliError('INVALID_ARGUMENT', 'Actions require application/json');
    const value = await parseJsonBody<T>(req, max);
    if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !keys.includes(key))) throw new CliError('INVALID_ARGUMENT', 'Unexpected request field');
    return value;
  };
  try {
    const reviewPage=pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/source-control\/review$/);
    if(reviewPage){requireMethod('GET');queryKeys('worktreeId','base');const location=await runtime.sourceControl.reviewUrl(reviewPage[1],text(query.get('worktreeId'),'worktree ID'),query.get('base')??undefined);res.writeHead(302,{Location:location,'Cache-Control':'no-store'});res.end();return;}
    const commitFiles=pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/commit-files$/);
    if(commitFiles){requireMethod('GET');queryKeys('sha','nodeId');sendJson(200,await runtime.sourceControl.commitFiles(commitFiles[1],text(query.get('sha'),'commit SHA',64),query.get('nodeId')??undefined));return;}
    const commitDiff=pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/commit-diff$/);
    if(commitDiff){requireMethod('GET');queryKeys('sha','nodeId','path');sendJson(200,await runtime.sourceControl.commitDiff(commitDiff[1],text(query.get('sha'),'commit SHA',64),query.get('path')??'',query.get('nodeId')??undefined));return;}
    const scm=pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/source-control\/(status|diff|compare|action)$/);
    if(scm){const [,projectId,action]=scm;
      if(action==='action'){requireMethod('POST');queryKeys();const request=await body<import('../../shared/contracts.js').SourceActionRequest>(['worktreeId','action','version','paths','message','base','title','body'],50000);if(typeof request.worktreeId!=='string')throw new CliError('INVALID_ARGUMENT','Select a worktree');sendJson(200,await runtime.sourceControl.action(projectId,request));return;}
      requireMethod('GET');queryKeys('worktreeId',...(action==='diff'?['path','kind','base']:action==='compare'?['base']:[]));const worktreeId=text(query.get('worktreeId'),'worktree ID');
      if(action==='status')sendJson(200,await runtime.sourceControl.status(projectId,worktreeId));
      else if(action==='compare')sendJson(200,await runtime.sourceControl.compare(projectId,worktreeId,query.get('base')??undefined));
      else{const kind=query.get('kind');if(kind!=='staged'&&kind!=='working'&&kind!=='branch')throw new CliError('INVALID_ARGUMENT','Choose a diff kind');sendJson(200,await runtime.sourceControl.diff(projectId,worktreeId,query.get('path')??'',kind,query.get('base')??undefined));}return;
    }
    const workspaceFiles = pathname.match(/^\/api\/projects\/([^/]+)\/files\/(roots|list|read|diff|search|save|open|stat|action|browser)$/);
    if (workspaceFiles) {
      const projectId = workspaceFiles[1], action = workspaceFiles[2];
      if (action === 'action') {
        requireMethod('POST'); queryKeys(); const request=await body<import('../../shared/contracts.js').WorkspaceFileActionRequest>(['worktreeId','action','path','destination','version','restoreId']);
        sendJson(200,await runtime.fileActions.change(projectId,request));
      } else if (action === 'stat') {
        requireMethod('GET'); queryKeys('worktreeId','path'); sendJson(200,await runtime.fileActions.stat(projectId,query.get('worktreeId')??'',query.get('path')??''));
      } else if (action === 'browser') {
        requireMethod('GET'); queryKeys('worktreeId','path');
        const file=await runtime.files.read(projectId,query.get('worktreeId')??'',query.get('path')??'');
        if(file.preview && !file.preview.dataUrl) throw new CliError('INVALID_ARGUMENT','This file does not have a browser preview');
        res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:;");
        res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Cache-Control','no-store');
        res.setHeader('Content-Type',file.preview?.mime??(/\.html?$/i.test(file.path)?'text/html; charset=utf-8':'text/plain; charset=utf-8'));
        res.statusCode=200; res.end(method==='HEAD'?undefined:file.preview?.dataUrl?Buffer.from(file.preview.dataUrl.split(',')[1],'base64'):file.text);
      } else if (action === 'roots') {
        requireMethod('GET'); queryKeys(); sendJson(200, await runtime.files.discoverRoots(projectId));
      } else if (action === 'open') {
        requireMethod('POST'); queryKeys(); const request = await body<{worktreeId: string; target: string; path?: string}>(['worktreeId', 'target','path']);
        sendJson(200, await runtime.files.open(projectId, request.worktreeId, request.target, request.path));
      } else if (action === 'save') {
        requireMethod('POST'); queryKeys();
        const request = await body<import('../../shared/contracts.js').SaveWorkspaceFileRequest>(['worktreeId', 'path', 'text', 'version'], 13 * 1024 * 1024);
        sendJson(200, await runtime.files.save(projectId, request.worktreeId, request.path, request.text, request.version));
      } else {
        requireMethod('GET'); queryKeys('worktreeId', 'path', 'q', 'mode', 'matchCase', 'wholeWord', 'regex', 'include', 'exclude', 'showDotfiles', 'showIgnored');
        for (const key of ['matchCase', 'wholeWord', 'regex', 'showDotfiles', 'showIgnored']) if (query.has(key) && !['true','false'].includes(query.get(key)!)) throw new CliError('INVALID_ARGUMENT', 'Invalid search option');
        const worktree = query.get('worktreeId') ?? '';
        const options = Object.fromEntries([...query].filter(([key]) => ['matchCase', 'wholeWord', 'regex', 'include', 'exclude', 'showDotfiles', 'showIgnored'].includes(key)).map(([key,value]) => [key, ['include','exclude'].includes(key) ? value : value === 'true']));
        sendJson(200, action === 'list' ? await runtime.files.list(projectId, worktree, query.get('path') ?? '') : action === 'read' || action === 'diff' ? await runtime.files.read(projectId, worktree, query.get('path') ?? '', action === 'diff') : await runtime.files.search(projectId, worktree, query.get('q') ?? '', query.get('mode') ?? 'names', options));
      }
      return;
    }
    if (pathname === '/api/speech/models') { requireMethod('GET'); queryKeys(); sendJson(200, runtime.speech.catalog()); return; }
    const speechModel = pathname.match(/^\/api\/speech\/models\/([a-z0-9-]+)\/(download|cancel)$/);
    if (speechModel) {
      requireMethod('POST'); queryKeys(); await body<{}>([]);
      if (speechModel[2] === 'download') runtime.speech.download(speechModel[1]); else runtime.speech.cancelDownload(speechModel[1]);
      sendJson(200, runtime.speech.catalog()); return;
    }
    if (pathname === '/api/speech/sessions') {
      requireMethod('POST'); queryKeys(); const request = await body<import('../../shared/contracts.js').StartSpeechRequest>(['modelId']);
      sendJson(200, await runtime.speech.start(text(request.modelId, 'speech model', 100))); return;
    }
    const speechSession = pathname.match(/^\/api\/speech\/sessions\/([0-9a-f-]{36})\/(audio|finish|cancel)$/);
    if (speechSession) {
      requireMethod('POST'); queryKeys();
      if (speechSession[2] === 'audio') sendJson(200, await runtime.speech.audio(speechSession[1], await body<import('../../shared/contracts.js').SpeechAudioRequest>(['pcm', 'sequence'], 95000)));
      else {
        await body<{}>([]);
        if (speechSession[2] === 'finish') sendJson(200, await runtime.speech.finish(speechSession[1]));
        else { runtime.speech.cancel(speechSession[1]); sendJson(200, { ok: true }); }
      }
      return;
    }
    if (pathname === '/api/workflow/setup-terminal') { requireMethod('POST'); queryKeys(); await body<{}>([]); sendJson(200, await runtime.organization.setup.prepareTerminal()); return; }
    if (pathname === '/api/workflow/setup-terminal/close') { requireMethod('POST'); queryKeys(); const owner = await body<{ projectId: string; nodeId: string }>(['projectId', 'nodeId']); runtime.organization.setup.closeTerminal(text(owner.projectId, 'setup project ID', 36), text(owner.nodeId, 'setup terminal ID', 36)); sendJson(200, { ok: true }); return; }
    if (pathname === '/api/workflow/config') {
      queryKeys();
      if (method === 'POST') sendJson(200, await runtime.organization.configure(await body<import('../../shared/contracts.js').OrganizationConfig>(['version', 'enabled', 'isolatedWorktrees', 'nodes', 'edges', 'orchestratorPosition'], 150000)));
      else { requireMethod('GET'); sendJson(200, runtime.organization.config()); } return;
    }
    if (pathname === '/api/workflow/setup') {
      queryKeys();
      requireMethod('GET'); sendJson(200, runtime.organization.setup.status()); return;
    }
    if (pathname === '/api/workflow/models') {
      requireMethod('GET'); queryKeys('provider'); const provider = query.get('provider');
      if (!['codex', 'claude', 'antigravity', 'codebuddy', 'opencode', 'opencode2', 'kilo'].includes(provider ?? '')) throw new CliError('INVALID_ARGUMENT', 'Select a supported provider');
      sendJson(200, await runtime.organization.models.list(provider as import('../../shared/contracts.js').WorkflowProvider)); return;
    }
    if (pathname === '/api/workflow/runs') {
      requireMethod('GET'); queryKeys('projectId','summary'); const projectId = query.get('projectId') ?? undefined;
      if (projectId) runtime.store.project(projectId);
      if(query.has('summary')&&query.get('summary')!=='1')throw new CliError('INVALID_ARGUMENT','Invalid workflow summary option');
      sendJson(200, query.get('summary')==='1'?runtime.organization.summaries(projectId):runtime.organization.runs(projectId)); return;
    }
    const workflowDetails=pathname.match(/^\/api\/workflow\/runs\/([0-9a-f-]{36})$/i);
    if(workflowDetails){requireMethod('GET');queryKeys();sendJson(200,runtime.organization.details(workflowDetails[1]));return;}
    const workflowCancel = pathname.match(/^\/api\/workflow\/runs\/([0-9a-f-]{36})\/cancel$/i);
    if (workflowCancel) { requireMethod('POST'); queryKeys(); await body<{}>([]); await runtime.organization.cancel(workflowCancel[1]); sendJson(200, { ok: true }); return; }
    if (pathname === '/api/workflow/control') {
      requireMethod('POST'); queryKeys();
      const request = await body<any>(['action', 'runId', 'sessionId', 'nodes', 'reason', 'streams', 'nodeId', 'task', 'to', 'text', 'outcome', 'summary', 'request', 'edges', 'isolatedWorktrees', 'provider'], 160000);
      sendJson(200, await runtime.organization.control(req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1], request)); return;
    }
    const shortcutRoute = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/shortcuts(?:\/([a-zA-Z0-9_-]+)\/run)?$/);
    if (shortcutRoute) {
      queryKeys();
      if (shortcutRoute[2]) {
        requireMethod('POST'); const request = await body<{ worktreeId: string }>(['worktreeId']);
        sendJson(200, await runProjectShortcut(runtime, shortcutRoute[1], shortcutRoute[2], text(request.worktreeId, 'worktree ID')));
      } else if (method === 'POST') {
        const request = await body<{ shortcuts: unknown }>(['shortcuts'], 350000); sendJson(200, saveProjectShortcuts(runtime.store, shortcutRoute[1], request.shortcuts));
      } else { requireMethod('GET'); sendJson(200, projectShortcuts(runtime.store, shortcutRoute[1])); }
      return;
    }
    if (pathname === '/api/agent-history') {
      requireMethod('GET'); queryKeys('scope', 'projectId', 'worktreeId', 'search', 'offset', 'refresh');
      const scope = query.get('scope') ?? 'project';
      if (!['workspace', 'project', 'all'].includes(scope) || (query.has('refresh') && query.get('refresh') !== '1')) throw new CliError('INVALID_ARGUMENT', 'Invalid history scope or refresh');
      const projectId = query.get('projectId') ?? undefined;
      if (scope !== 'all' && !projectId) throw new CliError('INVALID_ARGUMENT', 'Select a project for this history scope');
      const project = projectId ? runtime.store.project(projectId) : null;
      const trees = project ? await runtime.git.worktrees(project) : [];
      const workspace = query.get('worktreeId') ? trees.find(tree => tree.id === query.get('worktreeId')) : trees.find(tree => tree.main);
      if (query.has('worktreeId') && !workspace) throw new CliError('NODE_NOT_FOUND', 'Worktree does not belong to the selected project');
      const offset = query.get('offset') ?? '0', search = query.get('search') ?? '';
      if (!/^\d{1,6}$/.test(offset) || Number(offset) > 100000 || search.length > 200) throw new CliError('INVALID_ARGUMENT', 'Invalid history offset or search');
      await runtime.history.refresh(query.get('refresh') === '1');
      sendJson(200, runtime.history.list({ scope: scope as 'workspace' | 'project' | 'all', projectId, paths: trees.map(tree => tree.path), workspace: workspace?.path, search, offset: Number(offset) }, (projectId, id) => runtime.sessions.page(projectId, id, Number.MAX_SAFE_INTEGER).live)); return;
    }
    const historyResume = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/resume-history$/);
    if (historyResume) {
      requireMethod('POST'); queryKeys();
      const request = await body<{ sessionId: string; worktreeId: string }>(['sessionId', 'worktreeId']);
      const project = runtime.store.project(historyResume[1]), tree = await runtime.git.requireWorktree(project, text(request.worktreeId, 'worktree ID'));
      const source = await runtime.history.get(text(request.sessionId, 'history session ID', 40));
      const record = await runtime.sessions.resumeHistory(project.id, tree.id, tree.path, source);
      sendJson(200, { nodeId: record.id, projectId: record.projectId }); return;
    }
    const accountRoute = pathname.match(/^\/api\/provider-accounts\/(codex|claude|opencode)(?:\/(select|login|delete))?$/);
    if (accountRoute) {
      queryKeys();
      const provider = accountRoute[1] as 'codex' | 'claude' | 'opencode';
      if (!accountRoute[2] && (method === 'GET' || method === 'HEAD')) { sendJson(200, await runtime.accounts.list(provider)); return; }
      requireMethod('POST');
      if (accountRoute[2]) {
        const request = await body<{ accountId: string }>(['accountId']);
        const id = text(request.accountId, 'account ID', 36);
        if (accountRoute[2] === 'select') runtime.accounts.select(provider, id);
        else if (accountRoute[2] === 'login') await runtime.accounts.startLogin(provider, id);
        else await runtime.accounts.remove(provider, id);
      } else {
        const request = await body<{ label: string }>(['label']);
        await runtime.accounts.add(provider, text(request.label, 'account name', 60));
      }
      runtime.connectionsService.invalidate();
      sendJson(200, await runtime.accounts.list(provider)); return;
    }
    if (pathname === '/api/health') { requireMethod('GET'); queryKeys(); sendJson(200, { status: 'ok', readOnly: false, runtime: 'ade' }); return; }
    if (pathname === '/api/prerequisites') {
      requireMethod('GET'); queryKeys();
      let git = false;
      try { await runtime.git.run(runtime.store.directory, ['--version']); git = true; } catch { /* Report installation failure without blocking agent detection. */ }
      sendJson(200, { runtime: 'ade', git, ready: git, orcaApp: false, orcaAppOpen: false, orcaCli: false, orcaCliSkill: false,
        orchestrationSkill: false, version: 'ADE v1', issues: git ? [] : ['Install Git and make it available on PATH, then retry.'] }); return;
    }
    if (pathname === '/api/agents/settings') {
      queryKeys();
      if (method === 'POST') saveAgentPreferences(runtime.store, await body<AgentPreferences>(['defaultAgent', 'providers']));
      else requireMethod('GET');
      sendJson(200, readAgentPreferences(runtime.store)); return;
    }
    if (pathname === '/api/agents/catalog') {
      requireMethod('GET'); queryKeys();
      const catalog = agentCatalog(), preferences = readAgentPreferences(runtime.store);
      catalog.installed = catalog.installed.filter(agent => agent.id === 'terminal' || preferences.providers[agent.id as keyof typeof preferences.providers]?.enabled);
      for (const entry of catalog.available) {
        entry.isDefault = entry.id === preferences.defaultAgent;
        const modes = permissionArgs[entry.id as keyof typeof permissionArgs];
        if (modes) entry.permissionCommands = Object.fromEntries(Object.entries(modes).filter(([, args]) => args !== null).map(([mode, args]) => [mode, [entry.command, ...args!].join(' ')]));
      }
      catalog.defaultAgentId = catalog.installed.find(agent => agent.id === preferences.defaultAgent)?.id ?? catalog.installed[0]?.id ?? null;
      sendJson(200, catalog); return;
    }
    if (pathname === '/api/connections') { requireMethod('GET'); queryKeys('scope', 'refresh'); if (query.has('refresh') && query.get('refresh') !== '1') throw new CliError('INVALID_ARGUMENT', 'Invalid refresh'); const scope = query.get('scope') ?? 'all'; if (scope !== 'all' && scope !== 'accounts' && scope !== 'integrations') throw new CliError('INVALID_ARGUMENT', 'Invalid connection scope'); sendJson(200, await runtime.connectionsService.connections(scope, query.get('refresh') === '1')); return; }
    if (pathname === '/api/usage') { requireMethod('GET'); queryKeys('refresh'); if (query.has('refresh') && query.get('refresh') !== '1') throw new CliError('INVALID_ARGUMENT', 'refresh must be 1'); sendJson(200, await runtime.connectionsService.usage(query.get('refresh') === '1')); return; }
    if (pathname === '/api/computer-awake') {
      queryKeys();
      if (method === 'POST') { const request = await body<{ mode: string }>(['mode']); sendJson(200, runtime.awake.set(request.mode)); }
      else { requireMethod('GET'); sendJson(200, runtime.awake.status()); }
      return;
    }
    if (pathname === '/api/resources/details') {
      requireMethod('GET'); queryKeys(); sendJson(200, await runtime.resources.details(runtime.sessions.processGroups(), runtime.desktopMemory)); return;
    }
    if (pathname === '/api/ports') { requireMethod('GET'); queryKeys(); sendJson(200, await runtime.ports.read()); return; }
    const stopPort = pathname.match(/^\/api\/ports\/([a-f0-9]{40})\/stop$/);
    if (stopPort) { requireMethod('POST'); queryKeys(); await body<{}>([]); sendJson(200, await runtime.ports.stop(stopPort[1])); return; }
    if (pathname === '/api/resources') {
      requireMethod('GET'); queryKeys();
      sendJson(200, await runtime.resources.read(runtime.sessions.processRoots(), runtime.desktopMemory)); return;
    }
    if (pathname === '/api/inbox') {
      requireMethod('GET'); queryKeys();
      const open = new Map<string, Set<string>>();
      const items: InboxItem[] = runtime.store.db.prepare('SELECT data FROM (SELECT at, data FROM turn_results UNION ALL SELECT at, data FROM inbox_attention) ORDER BY at DESC LIMIT 200').all().map(row => {
        const item: InboxItem = JSON.parse(String(row.data));
        if (!open.has(item.projectId)) open.set(item.projectId, new Set(runtime.store.sessions(item.projectId).filter(session => !session.closed).map(session => session.id)));
        return item.nodeId && !open.get(item.projectId)!.has(item.nodeId) ? { ...item, nodeId: null } : item;
      });
      sendJson(200, section({ items }, items.length ? 'ready' : 'empty')); return;
    }
    const deleteProject = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)$/);
    if (deleteProject && pathname !== '/api/projects/folders') {
      requireMethod('DELETE'); queryKeys();
      runtime.store.deleteProject(deleteProject[1]);
      sendJson(200, { ok: true }); return;
    }
    if (pathname === '/api/projects/folders') {
      requireMethod('GET'); queryKeys('path'); sendJson(200, listProjectFolders(query.get('path') ?? undefined)); return;
    }
    if (pathname === '/api/projects') {
      queryKeys();
      if (method === 'POST') {
        const request = await body<RegisterProjectRequest>(['path', 'name', 'mode', 'url']);
        const project = await addProject(runtime.git, request);
        sendJson(201, { project });
      } else { requireMethod('GET'); sendJson(200, section({ projects: runtime.store.projects() })); }
      return;
    }
    const match = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/(snapshot|events|github|commit-graph|worktrees|nodes\/([a-zA-Z0-9_.-]+)(?:\/(handoff|handoff-message|interaction|interrupt|terminal|terminal-input|terminal-resize|resume|create-agent|close-tab|rename|rename-worktree|delete-worktree|worktree|message|chat-options|events))?)$/);
    if (!match) { sendError(404, 'INVALID_ARGUMENT', 'Unknown standalone ADE endpoint'); return; }
    const [, projectId, route, nodeId, action] = match;
    const project = runtime.store.project(projectId);
    if (action === 'interaction') {
      queryKeys();
      if (method === 'POST') {
        await runtime.sessions.answer(projectId, nodeId!, await body<AnswerAgentRequest>(['promptId', 'optionId', 'text']));
        sendJson(200, { ok: true });
      } else { requireMethod('GET'); const prompt = runtime.sessions.interaction(projectId, nodeId!); sendJson(200, section(prompt, prompt ? 'ready' : 'empty')); }
      return;
    }
    if (route === 'snapshot') { requireMethod('GET'); queryKeys('runId'); sendJson(200, await runtime.snapshot(projectId)); return; }
    if (route === 'events') {
      requireMethod('GET'); queryKeys('runId');
      if (runtime.connections >= 32) throw new CliError('RATE_LIMITED', 'Too many event streams');
      runtime.connections++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      let closed = false, busy = false, pending = false;
      const tick = async () => {
        if (closed) return;
        if (busy) { pending = true; return; }
        busy = true;
        try {
          const snapshot = await runtime.snapshot(projectId);
          if (!closed && !res.destroyed && !res.writableNeedDrain) res.write(`event: snapshot\nid: ${snapshot.revision}\ndata: ${JSON.stringify(snapshot)}\n\n`);
        } finally { busy = false; if (pending && !closed) { pending = false; void tick().catch(() => close()); } }
      };
      const timer = setInterval(() => { void tick().catch(() => close()); }, 2000);
      const heartbeat = setInterval(() => { if (!res.writableNeedDrain) res.write(': heartbeat\n\n'); }, 15000);
      const unsubscribeStatus = runtime.sessions.subscribeStatus(projectId, () => { void tick().catch(() => close()); });
      const close = () => {
        if (closed) return;
        closed = true; clearInterval(timer); clearInterval(heartbeat); unsubscribeStatus(); runtime.connections--; runtime.streams.delete(close); res.end();
      };
      runtime.streams.add(close); res.once('close', close);
      await tick(); return;
    }
    if (route === 'github') {
      requireMethod('GET'); queryKeys('scope', 'nodeId', 'activity', 'page');
      const scope = query.get('scope') ?? 'general';
      if (!['general', 'worktree'].includes(scope) || (scope === 'worktree' && !query.get('nodeId')) || (scope === 'general' && query.has('nodeId'))) throw new CliError('INVALID_ARGUMENT', 'Invalid GitHub scope');
      if (query.has('activity') && !['commits', 'prs', 'issues'].includes(query.get('activity')!)) throw new CliError('INVALID_ARGUMENT', 'Invalid GitHub activity');
      if (query.has('page') && !/^[1-9][0-9]{0,4}$/.test(query.get('page')!)) throw new CliError('INVALID_ARGUMENT', 'Invalid GitHub page');
      const selection = { scope, ...(scope === 'worktree' ? { nodeId: query.get('nodeId')! } : {}),
        ...(query.has('activity') ? { activity: query.get('activity') } : {}), ...(query.has('page') ? { page: Number(query.get('page')) } : {}) } as GitHubQuery;
      const snapshot = await runtime.snapshot(projectId);
      if (!snapshot.graph.data || snapshot.graph.meta.stale) throw new CliError('SCOPE_UNAVAILABLE', 'Repository scope is unavailable');
      sendJson(200, await collectGitHubData(project, selection, runtime.git.runner, snapshot.graph.data)); return;
    }
    if (route === 'commit-graph') { requireMethod('GET'); queryKeys('nodeId'); sendJson(200, await runtime.git.history(project, query.get('nodeId') ?? undefined)); return; }
    if (route === 'worktrees') {
      requireMethod('POST'); queryKeys();
      const request = await body<CreateWorktreeRequest>(['name', 'baseBranch', 'from', 'setup', 'agentId']);
      if (request.agentId && !agentCatalog().installed.some(agent => agent.id === request.agentId)) throw new CliError('INVALID_ARGUMENT', 'Select an installed agent');
      const tree = await runtime.git.create(project, request);
      if (request.agentId) {
        try { await runtime.sessions.launch(projectId, tree.id, tree.path, request.agentId); }
        catch { sendJson(200, { ok: true, message: 'Worktree created. Agent could not start; open the worktree and add an agent.' }); return; }
      }
      sendJson(200, { ok: true, message: 'Worktree created' }); return;
    }
    if (!action) {
      requireMethod('GET'); queryKeys('runId', 'limit', 'cursor', 'direction');
      if ((query.has('cursor') && query.get('cursor')!.length > 512) || (query.has('direction') && query.get('direction') !== 'older')) throw new CliError('INVALID_ARGUMENT', 'Invalid conversation cursor or direction');
      if (query.has('limit') && (!/^[1-9][0-9]*$/.test(query.get('limit')!) || Number(query.get('limit')) > 200)) throw new CliError('INVALID_ARGUMENT', 'Invalid conversation limit');
      sendJson(200, await runtime.details(projectId, nodeId, { direction: 'older', cursor: query.get('cursor'), limit: Number(query.get('limit') ?? 20) })); return;
    }
    if (action === 'terminal') {
      requireMethod('GET'); queryKeys('cursor');
      const raw = query.get('cursor') ?? '0';
      if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new CliError('INVALID_ARGUMENT', 'Invalid terminal cursor');
      sendJson(200, runtime.sessions.page(projectId, nodeId, Number(raw))); return;
    }
    if (action === 'events') {
      requireMethod('GET'); queryKeys('runId', 'cursor');
      if (query.has('cursor') && query.get('cursor')!.length > 512) throw new CliError('INVALID_ARGUMENT', 'Invalid conversation cursor');
      runtime.sessions.require(projectId, nodeId);
      if (runtime.connections >= 32) throw new CliError('RATE_LIMITED', 'Too many event streams');
      let cursor = query.get('cursor'), closed = false, busy = false;
      const read = () => runtime.conversations.read(runtime.sessions.require(projectId, nodeId), { cursor, limit: 20 });
      const initial = await read();
      if (res.destroyed) return;
      if (runtime.connections >= 32) throw new CliError('RATE_LIMITED', 'Too many event streams');
      runtime.connections++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const publish = (conversation: typeof initial, first = false) => {
        if (closed) return;
        if (conversation.data?.nextCursor) cursor = conversation.data.nextCursor;
        if (first || conversation.data?.messages.length || conversation.meta.issue) res.write(`event: conversation\ndata: ${JSON.stringify(conversation)}\n\n`);
      };
      const update = async () => {
        if (closed || busy || res.writableNeedDrain) return;
        busy = true;
        try { publish(await read()); }
        catch { if (!closed) res.write('event: stream-reset\ndata: {}\n\n'); close(); }
        finally { busy = false; }
      };
      const stopWatching = runtime.conversations.watch(runtime.sessions.require(projectId, nodeId), () => { void update(); });
      const timer = setInterval(update, 2000);
      const heartbeat = setInterval(() => { if (!closed && !res.writableNeedDrain) res.write(': heartbeat\n\n'); }, 15000);
      const close = () => {
        if (closed) return;
        closed = true; clearInterval(timer); clearInterval(heartbeat); stopWatching(); runtime.connections--; runtime.streams.delete(close); res.end();
      };
      runtime.streams.add(close); res.once('close', close); publish(initial, true); return;
    }
    queryKeys('runId');
    if (action === 'chat-options') {
      if (req.method === 'GET') { sendJson(200, section(await runtime.chatOptions(projectId, nodeId))); return; }
      requireMethod('POST');
      const request = await body<SetAgentChatOptionRequest>(['key', 'value']);
      if (!['model', 'effort', 'fastMode', 'serviceTier', 'providerPicker', 'fastToggle'].includes(request.key) || typeof request.value !== 'string' || !request.value.length || request.value.length > 200 || /[\x00-\x1f\x7f]/.test(request.value)) throw new CliError('INVALID_ARGUMENT', 'Select a supported model setting');
      sendJson(200, await runtime.chatOptions(projectId, nodeId, request)); return;
    }
    requireMethod(action === 'worktree' ? 'DELETE' : 'POST');
    if (action === 'handoff') {
      queryKeys(); const request = await body<import('../../shared/contracts.js').HandoffSessionRequest>(['agentId','context']);
      sendJson(200, await runtime.handoffs.start(projectId, nodeId, request)); return;
    } else if (action === 'handoff-message') {
      queryKeys(); await body<{}>([]); sendJson(200, await runtime.handoffs.deliver(projectId, nodeId)); return;
    } else if (action === 'resume') {
      if (query.size) throw new CliError('INVALID_ARGUMENT', 'Resume does not accept query parameters');
      await body<Record<string, never>>([]);
      const record = runtime.sessions.require(projectId, nodeId);
      const tree = await runtime.git.requireWorktree(project, record.worktreeId);
      if (tree.path !== record.cwd) throw new CliError('INVALID_ARGUMENT', 'The original session folder is no longer available');
      await runtime.sessions.resume(projectId, nodeId);
    }
    else if (action === 'interrupt') { queryKeys(); await body<import('../../shared/contracts.js').InterruptAgentRequest>([]); await runtime.sessions.interrupt(projectId,nodeId); }
    else if (action === 'terminal-input') { const request = await body<{ data: string }>(['data'], 65536); await runtime.sessions.input(projectId, nodeId, request.data); }
    else if (action === 'terminal-resize') { const request = await body<{ cols: number; rows: number }>(['cols', 'rows']); await runtime.sessions.resize(projectId, nodeId, request.cols, request.rows); }
    else if (action === 'create-agent') {
      const tree = await runtime.git.requireWorktree(project, nodeId);
      const request = await body<{ command: string; title?: string; shell?: TerminalShell }>(['command', 'title', 'shell']);
      const session = await runtime.sessions.launch(projectId, tree.id, tree.path, text(request.command, 'agent', 32), request.title === undefined ? undefined : text(request.title, 'title'), request.shell === undefined ? undefined : text(request.shell, 'shell', 16) as TerminalShell);
      sendJson(200, { ok: true, handle: session.id, title: session.title }); return;
    } else if (action === 'close-tab') { runtime.sessions.closeSession(projectId, nodeId); }
    else if (action === 'rename' || action === 'rename-worktree') {
      const request = await body<{ title: string }>(['title']);
      if (action === 'rename-worktree') await runtime.git.requireWorktree(project, nodeId);
      else runtime.sessions.require(projectId, nodeId);
      const title = text(request.title, 'title'); runtime.store.rename(nodeId, title); sendJson(200, { ok: true, title }); return;
    } else if (action === 'delete-worktree' || action === 'worktree') {
      if (runtime.store.sessions(projectId).some(session => !session.closed && session.worktreeId === nodeId)) throw new CliError('INVALID_ARGUMENT', 'Close this worktree’s agent sessions before deleting it');
      await runtime.git.remove(project, nodeId);
    } else if (action === 'message') {
      const request = await body<SendMessageRequest>(['message', 'attachments', 'workflowConfirmed', 'requireIdle'], 29 * 1024 * 1024);
      if (request.requireIdle !== undefined && typeof request.requireIdle !== 'boolean') throw new CliError('INVALID_ARGUMENT', 'Invalid idle requirement');
      if (request.workflowConfirmed !== undefined && typeof request.workflowConfirmed !== 'boolean') throw new CliError('INVALID_ARGUMENT', 'Invalid workflow confirmation');
      sendJson(200, await runtime.organization.send(projectId, nodeId, request)); return;
    }
    else throw new CliError('METHOD_NOT_ALLOWED', 'Action is not available in standalone ADE');
    sendJson(200, { ok: true });
  } catch (error) {
    if (res.headersSent) { res.end(); return; }
    const issue = error instanceof CliError ? error.issue : { code: 'INTERNAL' as const, message: 'Standalone ADE operation failed', retryable: false };
    const status = issue.code === 'FORBIDDEN_ORIGIN' ? 403 : issue.code === 'INVALID_ARGUMENT' ? 400 : issue.code === 'METHOD_NOT_ALLOWED' ? 405 : issue.code.endsWith('_NOT_FOUND') ? 404 : issue.code === 'RATE_LIMITED' ? 429 : 500;
    sendError(status, issue.code, issue.message, issue.retryable);
  }
}
