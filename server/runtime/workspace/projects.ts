import fs from 'node:fs';
import path from 'node:path';
import type { Project, RegisterProjectRequest } from '../../../shared/contracts.js';
import { CliError, GIT_PATH } from '../../integrations/cli.js';
import { AdeGit } from './git.js';
import { localDirectory } from './projectFolders.js';

export async function addProject(git: AdeGit, request: RegisterProjectRequest): Promise<Project> {
  if (!request || typeof request.path !== 'string' || (request.name !== undefined && (typeof request.name !== 'string' || !request.name.trim() || request.name.length > 100 || /[\x00-\x1f]/.test(request.name)))) throw new CliError('INVALID_ARGUMENT', 'Choose a valid project folder and name');
  if (request.mode === undefined || request.mode === 'existing') {
    if ('url' in request) throw new CliError('INVALID_ARGUMENT', 'Existing folders do not accept a clone URL');
    return git.register(request.path, request.name?.trim());
  }
  if (!['create', 'clone'].includes(request.mode)) throw new CliError('INVALID_ARGUMENT', 'Unknown project source');
  if (typeof request.name !== 'string' || !request.name.trim()) throw new CliError('INVALID_ARGUMENT', 'Enter a project name');
  const parent = localDirectory(request.path);
  const name = request.name.trim();
  if (!name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || name === '.' || name === '..' || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new CliError('INVALID_ARGUMENT', 'Use a valid folder name without slashes or reserved characters');
  const destination = path.join(parent, name);
  if (fs.existsSync(destination)) throw new CliError('INVALID_ARGUMENT', 'A folder with this name already exists. Choose another name or browse to add it.');
  let args: string[];
  if (request.mode === 'clone') {
    let remote: URL;
    try { remote = new URL(request.url); } catch { throw new CliError('INVALID_ARGUMENT', 'Enter an HTTPS Git repository URL'); }
    if (remote.protocol !== 'https:' || remote.username || remote.password || !remote.hostname || remote.pathname === '/' || remote.search || remote.hash || request.url.length > 2048 || /[\x00-\x20]/.test(request.url)) throw new CliError('INVALID_ARGUMENT', 'Use an HTTPS repository URL without credentials, query parameters or fragments');
    args = ['clone', '--quiet', '--no-recurse-submodules', '--', remote.href, destination];
  } else {
    if ('url' in request) throw new CliError('INVALID_ARGUMENT', 'New projects do not accept a clone URL');
    args = ['init', '--', destination];
  }
  const result = await git.runner(GIT_PATH, args, { cwd: parent, timeoutMs: request.mode === 'clone' ? 120000 : 15000,
    maxStdout: 8192, maxStderr: 8192, env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } });
  if (result.exitCode !== 0) throw new CliError('CLI_FAILED', request.mode === 'clone'
    ? 'Clone failed. Check the URL and your local Git authentication. Inspect the destination before retrying.'
    : 'The project could not be initialized. Check folder permissions and inspect the destination before retrying.');
  return git.register(destination, name);
}
