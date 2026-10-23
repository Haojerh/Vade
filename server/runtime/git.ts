import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Project, CreateWorktreeRequest, CommitGraphData, Section } from '../../shared/contracts.js';
import { CliError, GIT_PATH, defaultCommandRunner, type CommandRunner } from '../integrations/cli.js';
import { COMMIT_GRAPH_ARGS, parseCommitGraph } from '../integrations/commitGraph.js';
import { AdeStore } from './store.js';
import { localDirectory } from './projectFolders.js';

export interface LocalWorktree { id: string; path: string; branch: string | null; main: boolean; locked: boolean }

export function worktreeId(projectId: string, directory: string): string {
  return 'wt-' + crypto.createHash('sha256').update(`${projectId}\0${directory}`).digest('hex').slice(0, 24);
}

export class AdeGit {
  constructor(readonly store: AdeStore, readonly runner: CommandRunner = defaultCommandRunner) {}

  async run(cwd: string, args: string[]): Promise<string> {
    const result = await this.runner(GIT_PATH, args, { cwd, timeoutMs: 15000, maxStdout: 2 * 1024 * 1024, maxStderr: 8192 });
    if (result.exitCode !== 0) throw new CliError('CLI_FAILED', result.stderr.trim().slice(0, 1000) || 'Git command failed', false);
    return result.stdout;
  }

  async headCommit(cwd: string): Promise<string | null> {
    const options = { cwd, timeoutMs: 15000, maxStdout: 8192, maxStderr: 8192 };
    const head = await this.runner(GIT_PATH, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], options);
    if (head.exitCode === 0) {
      const sha = head.stdout.trim();
      if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new CliError('INVALID_UPSTREAM', 'Git returned an invalid commit');
      return sha;
    }
    // Only a symbolic HEAD whose branch is absent is an unborn checkout.
    // Repository, permission and object errors must remain failures.
    if (head.exitCode === 1) {
      const symbolic = await this.runner(GIT_PATH, ['symbolic-ref', '--quiet', 'HEAD'], options);
      const ref = symbolic.stdout.trim();
      if (symbolic.exitCode === 0 && /^refs\/heads\/[^\s]+$/.test(ref)) {
        const branch = await this.runner(GIT_PATH, ['show-ref', '--verify', '--quiet', ref], options);
        if (branch.exitCode === 1) return null;
      }
    }
    throw new CliError('CLI_FAILED', head.stderr.trim().slice(0, 1000) || 'Unable to resolve the checkout HEAD commit', false);
  }

  async register(directory: string, name?: string): Promise<Project> {
    const canonical = localDirectory(directory);
    // A plain folder is also a valid workspace. Only run Git if a checkout marker exists.
    let ancestor = canonical;
    while (!fs.existsSync(path.join(ancestor, '.git'))) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return this.store.register(canonical, name, 'folder');
      ancestor = parent;
    }
    const root = (await this.run(canonical, ['rev-parse', '--show-toplevel'])).trim();
    return this.store.register(fs.realpathSync(root), name);
  }

  async worktrees(project: Project): Promise<LocalWorktree[]> {
    if (project.kind === 'folder') {
      const directory = localDirectory(project.paths[0]);
      return [{ id: worktreeId(project.id, directory), path: directory, branch: null, main: true, locked: false }];
    }
    const raw = await this.run(project.paths[0], ['worktree', 'list', '--porcelain', '-z']);
    const trees: LocalWorktree[] = [];
    let current: LocalWorktree | null = null;
    for (const field of raw.split('\0')) {
      if (field.startsWith('worktree ')) {
        const directory = field.slice(9);
        current = { id: worktreeId(project.id, directory), path: directory, branch: null, main: trees.length === 0, locked: false };
        trees.push(current);
      } else if (current && field.startsWith('branch ')) current.branch = field.slice(7).replace(/^refs\/heads\//, '');
      else if (current && field.startsWith('locked')) current.locked = true;
    }
    if (trees.length > 200) throw new CliError('INVALID_UPSTREAM', 'Repository exceeds the 200 worktree collection limit');
    return trees;
  }

  async requireWorktree(project: Project, id: string): Promise<LocalWorktree> {
    const tree = (await this.worktrees(project)).find(item => item.id === id);
    if (!tree) throw new CliError('NODE_NOT_FOUND', 'Worktree does not belong to this project');
    return tree;
  }

  async create(project: Project, body: CreateWorktreeRequest): Promise<LocalWorktree> {
    if (project.kind !== 'git') throw new CliError('INVALID_ARGUMENT', 'Worktrees require a Git project');
    if (!body || Object.keys(body).some(key => !['name', 'baseBranch', 'from', 'setup', 'agentId'].includes(key)) ||
        typeof body.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(body.name) || body.name.includes('..')) throw new CliError('INVALID_ARGUMENT', 'Use a worktree name containing letters, numbers, dots, underscores or hyphens');
    if (body.from && body.from.kind !== 'branch') throw new CliError('INVALID_ARGUMENT', 'Standalone ADE currently creates worktrees from local branches only');
    if (body.setup && !['inherit', 'skip'].includes(body.setup)) throw new CliError('INVALID_ARGUMENT', 'Setup scripts are not supported in standalone ADE yet');
    const base = body.from?.value ?? body.baseBranch ?? 'HEAD';
    if (typeof base !== 'string' || base.length > 256 || !base || base.startsWith('-') || /[\x00-\x20\x7f]/.test(base)) throw new CliError('INVALID_ARGUMENT', 'Invalid base branch');
    // Resolve the user-selected ref before using it as a worktree source.
    const sha = (await this.run(project.paths[0], ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])).trim();
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new CliError('INVALID_UPSTREAM', 'Git returned an invalid commit');
    const parent = path.join(this.store.directory, 'worktrees', project.id);
    fs.mkdirSync(parent, { recursive: true });
    const destination = path.join(parent, body.name);
    await this.run(project.paths[0], ['worktree', 'add', '-b', body.name, '--', destination, sha]);
    const tree = (await this.worktrees(project)).find(item => path.resolve(item.path) === path.resolve(destination));
    if (!tree) throw new CliError('INVALID_UPSTREAM', 'Worktree was created but could not be rediscovered; refresh before retrying');
    return tree;
  }

  async remove(project: Project, id: string): Promise<void> {
    const tree = await this.requireWorktree(project, id);
    if (tree.main || tree.locked) throw new CliError('INVALID_ARGUMENT', 'The main or a locked worktree cannot be deleted');
    // Git rejects dirty worktrees; do not discard local changes.
    await this.run(project.paths[0], ['worktree', 'remove', '--', tree.path]);
  }

  async history(project: Project, nodeId?: string): Promise<Section<CommitGraphData>> {
    if (project.kind !== 'git') {
      const now = new Date().toISOString();
      return { data: null, meta: { availability: 'unsupported', attemptedAt: now, observedAt: null, stale: false, partial: false, issue: null } };
    }
    const tree = nodeId ? await this.requireWorktree(project, nodeId) : null;
    const args = nodeId ? COMMIT_GRAPH_ARGS.filter(arg => arg !== '--all') : COMMIT_GRAPH_ARGS;
    const data = parseCommitGraph(await this.run(tree?.path ?? project.paths[0], args));
    const now = new Date().toISOString();
    return { data, meta: { availability: data.commits.length ? 'ready' : 'empty', attemptedAt: now, observedAt: now, stale: false, partial: data.truncated, issue: null } };
  }
}
