import type { SaveWorkspaceFileRequest, SourceActionRequest, WorkspaceFileActionRequest } from '../../../shared/contracts.js';
import { CliError } from '../../integrations/cli.js';
import { type RouteContext, text } from '../routeContext.js';

export async function handleWorkspaceRoutes(ctx: RouteContext): Promise<boolean> {
  const { runtime, res, method, pathname, query, sendJson, requireMethod, queryKeys, body } = ctx;

  const reviewPage = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/source-control\/review$/);
  if (reviewPage) {
    requireMethod('GET');
    queryKeys('worktreeId', 'base');
    const location = await runtime.sourceControl.reviewUrl(
      reviewPage[1],
      text(query.get('worktreeId'), 'worktree ID'),
      query.get('base') ?? undefined,
    );
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  const commitFiles = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/commit-files$/);
  if (commitFiles) {
    requireMethod('GET');
    queryKeys('sha', 'nodeId');
    sendJson(200, await runtime.sourceControl.commitFiles(
      commitFiles[1],
      text(query.get('sha'), 'commit SHA', 64),
      query.get('nodeId') ?? undefined,
    ));
    return true;
  }

  const commitDiff = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/commit-diff$/);
  if (commitDiff) {
    requireMethod('GET');
    queryKeys('sha', 'nodeId', 'path');
    sendJson(200, await runtime.sourceControl.commitDiff(
      commitDiff[1],
      text(query.get('sha'), 'commit SHA', 64),
      query.get('path') ?? '',
      query.get('nodeId') ?? undefined,
    ));
    return true;
  }

  const scm = pathname.match(/^\/api\/projects\/([a-zA-Z0-9_.-]+)\/source-control\/(status|diff|compare|action)$/);
  if (scm) {
    const [, projectId, action] = scm;
    if (action === 'action') {
      requireMethod('POST');
      queryKeys();
      const request = await body<SourceActionRequest>(['worktreeId', 'action', 'version', 'paths', 'message', 'base', 'title', 'body'], 50000);
      if (typeof request.worktreeId !== 'string') throw new CliError('INVALID_ARGUMENT', 'Select a worktree');
      sendJson(200, await runtime.sourceControl.action(projectId, request));
      return true;
    }
    requireMethod('GET');
    queryKeys('worktreeId', ...(action === 'diff' ? ['path', 'kind', 'base'] : action === 'compare' ? ['base'] : []));
    const worktreeId = text(query.get('worktreeId'), 'worktree ID');
    if (action === 'status') {
      sendJson(200, await runtime.sourceControl.status(projectId, worktreeId));
    } else if (action === 'compare') {
      sendJson(200, await runtime.sourceControl.compare(projectId, worktreeId, query.get('base') ?? undefined));
    } else {
      const kind = query.get('kind');
      if (kind !== 'staged' && kind !== 'working' && kind !== 'branch') {
        throw new CliError('INVALID_ARGUMENT', 'Choose a diff kind');
      }
      sendJson(200, await runtime.sourceControl.diff(projectId, worktreeId, query.get('path') ?? '', kind, query.get('base') ?? undefined));
    }
    return true;
  }

  const workspaceFiles = pathname.match(/^\/api\/projects\/([^/]+)\/files\/(roots|list|read|diff|search|save|open|stat|action|browser)$/);
  if (workspaceFiles) {
    const projectId = workspaceFiles[1];
    const action = workspaceFiles[2];
    if (action === 'action') {
      requireMethod('POST');
      queryKeys();
      const request = await body<WorkspaceFileActionRequest>(['worktreeId', 'action', 'path', 'destination', 'version', 'restoreId']);
      sendJson(200, await runtime.fileActions.change(projectId, request));
    } else if (action === 'stat') {
      requireMethod('GET');
      queryKeys('worktreeId', 'path');
      sendJson(200, await runtime.fileActions.stat(projectId, query.get('worktreeId') ?? '', query.get('path') ?? ''));
    } else if (action === 'browser') {
      requireMethod('GET');
      queryKeys('worktreeId', 'path');
      const file = await runtime.files.read(projectId, query.get('worktreeId') ?? '', query.get('path') ?? '');
      if (file.preview && !file.preview.dataUrl) throw new CliError('INVALID_ARGUMENT', 'This file does not have a browser preview');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:;");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', file.preview?.mime ?? (/\.html?$/i.test(file.path) ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8'));
      res.statusCode = 200;
      res.end(method === 'HEAD' ? undefined : file.preview?.dataUrl ? Buffer.from(file.preview.dataUrl.split(',')[1], 'base64') : file.text);
    } else if (action === 'roots') {
      requireMethod('GET');
      queryKeys();
      sendJson(200, await runtime.files.discoverRoots(projectId));
    } else if (action === 'open') {
      requireMethod('POST');
      queryKeys();
      const request = await body<{ worktreeId: string; target: string; path?: string }>(['worktreeId', 'target', 'path']);
      sendJson(200, await runtime.files.open(projectId, request.worktreeId, request.target, request.path));
    } else if (action === 'save') {
      requireMethod('POST');
      queryKeys();
      const request = await body<SaveWorkspaceFileRequest>(['worktreeId', 'path', 'text', 'version'], 13 * 1024 * 1024);
      sendJson(200, await runtime.files.save(projectId, request.worktreeId, request.path, request.text, request.version));
    } else {
      requireMethod('GET');
      queryKeys('worktreeId', 'path', 'q', 'mode', 'matchCase', 'wholeWord', 'regex', 'include', 'exclude', 'showDotfiles', 'showIgnored');
      for (const key of ['matchCase', 'wholeWord', 'regex', 'showDotfiles', 'showIgnored']) {
        if (query.has(key) && !['true', 'false'].includes(query.get(key)!)) {
          throw new CliError('INVALID_ARGUMENT', 'Invalid search option');
        }
      }
      const worktree = query.get('worktreeId') ?? '';
      const options = Object.fromEntries(
        [...query]
          .filter(([key]) => ['matchCase', 'wholeWord', 'regex', 'include', 'exclude', 'showDotfiles', 'showIgnored'].includes(key))
          .map(([key, value]) => [key, ['include', 'exclude'].includes(key) ? value : value === 'true']),
      );
      sendJson(
        200,
        action === 'list'
          ? await runtime.files.list(projectId, worktree, query.get('path') ?? '')
          : action === 'read' || action === 'diff'
            ? await runtime.files.read(projectId, worktree, query.get('path') ?? '', action === 'diff')
            : await runtime.files.search(projectId, worktree, query.get('q') ?? '', query.get('mode') ?? 'names', options),
      );
    }
    return true;
  }

  return false;
}
