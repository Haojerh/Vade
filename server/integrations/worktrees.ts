import type { CreateWorktreeRequest, CreateWorktreeResponse, RenameNodeTitleResponse, Project } from '../../shared/contracts.js';
import { CliError, runOrca, type CommandRunner, defaultCommandRunner } from './cli.js';
import { collectInventory } from './orca/inventory.js';
import { hashId } from './orca/utils.js';
import { KNOWN_AGENTS } from './agents.js';

export async function requireProject(projectId: string, runner: CommandRunner): Promise<Project> {
  const { inventory, meta } = await collectInventory(runner);
  if (meta.availability === 'unavailable') throw new CliError(meta.issue?.code ?? 'RUNTIME_UNAVAILABLE', meta.issue?.message ?? 'Project discovery unavailable', true);
  const project = inventory.projects.find(p => p.id === projectId);
  if (!project) throw new CliError('PROJECT_NOT_FOUND', 'Project not found');
  return project;
}

export async function requireWorktree(project: Project, nodeId: string, runner: CommandRunner): Promise<any> {
  const response = await runOrca<any>(['worktree', 'ps', '--limit', '200', '--json'], runner);
  const worktree = (response.result?.worktrees ?? []).find((w: any) => {
    const id = hashId('node', String(w.worktreeId || w.path || w.displayName));
    return id === nodeId && (project.repoIds.includes(w.repoId) || project.paths.some(p => p.toLowerCase() === w.path?.toLowerCase()));
  });
  if (!worktree) throw new CliError('NODE_NOT_FOUND', 'Worktree does not belong to this project');
  return worktree;
}

export async function renameWorktree(projectId: string, nodeId: string, title: string, runner = defaultCommandRunner): Promise<RenameNodeTitleResponse> {
  const project = await requireProject(projectId, runner);
  const wt = await requireWorktree(project, nodeId, runner);
  await runOrca(['worktree', 'set', '--worktree', wt.worktreeId ? `id:${wt.worktreeId}` : `path:${wt.path}`, '--display-name', title.trim(), '--json'], runner);
  return { ok: true, title: title.trim(), message: 'Worktree renamed successfully' };
}

export function validateCreateWorktree(body: unknown): asserts body is CreateWorktreeRequest {
  const b = body as CreateWorktreeRequest;
  const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !v.trim().startsWith('-') && !/[\x00-\x1f\x7f]/.test(v);
  if (!b || !text(b.name, 100) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(b.name) || b.name.includes('..'))
    throw new CliError('INVALID_ARGUMENT', 'Name must use letters, numbers, dots, underscores or hyphens (up to 100 characters)');
  if (b.baseBranch !== undefined && !text(b.baseBranch, 256)) throw new CliError('INVALID_ARGUMENT', 'Invalid base branch');
  if (b.from !== undefined && (!b.from || !['branch', 'pr', 'issue'].includes(b.from.kind) || !text(b.from.value, 256) ||
      (b.from.kind !== 'branch' && !/^[1-9][0-9]{0,8}$/.test(b.from.value)))) throw new CliError('INVALID_ARGUMENT', 'Invalid worktree source');
  if (b.agentId !== undefined && !KNOWN_AGENTS.some(a => a.id === b.agentId)) throw new CliError('INVALID_ARGUMENT', 'Unknown agent');
  if (b.setup !== undefined && !['inherit', 'run', 'skip'].includes(b.setup)) throw new CliError('INVALID_ARGUMENT', 'Invalid setup policy');
  if (Object.keys(b).some(k => !['name', 'baseBranch', 'from', 'agentId', 'setup'].includes(k))) throw new CliError('INVALID_ARGUMENT', 'Unexpected worktree field');
}

export async function createProjectWorktree(projectId: string, body: CreateWorktreeRequest, runner = defaultCommandRunner): Promise<CreateWorktreeResponse> {
  validateCreateWorktree(body);
  const project = await requireProject(projectId, runner);
  if (project.kind !== 'git' || project.repoIds.length !== 1) throw new CliError('INVALID_ARGUMENT', 'Select a Git project with one backing repository');
  const args = ['worktree', 'create', '--repo', `id:${project.repoIds[0]}`, '--name', body.name, '--no-parent'];
  const base = body.from?.kind === 'branch' ? body.from.value : body.baseBranch;
  if (base) args.push('--base-branch', base);
  if (body.from && body.from.kind !== 'branch') args.push(body.from.kind === 'pr' ? '--pr' : '--issue', body.from.value);
  if (body.agentId) args.push('--agent', body.agentId);
  args.push('--setup', body.setup ?? 'inherit', '--json');
  await runOrca(args, runner, { timeoutMs: 120000 });
  return { ok: true, message: 'Worktree created successfully' };
}
