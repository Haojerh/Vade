import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { LocalFolders } from '../../../shared/contracts.js';
import { CliError } from '../../integrations/cli.js';

export function localDirectory(input: string): string {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.length > 4096 || /[\x00-\x1f]/.test(input) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(input))) {
    throw new CliError('INVALID_ARGUMENT', 'Choose an absolute local folder path');
  }
  try {
    const canonical = fs.realpathSync(input);
    if (!fs.statSync(canonical).isDirectory()) throw new Error('Not a directory');
    return canonical;
  } catch { throw new CliError('INVALID_ARGUMENT', 'Folder does not exist or cannot be opened'); }
}

export function listProjectFolders(input = os.homedir()): LocalFolders {
  const directory = localDirectory(input);
  const folders: LocalFolders['folders'] = [];
  let limited = false;
  let handle: fs.Dir;
  try { handle = fs.opendirSync(directory); } catch { throw new CliError('INVALID_ARGUMENT', 'This folder cannot be read. Choose another folder.'); }
  try {
    for (let scanned = 0; ; scanned++) {
      const entry = handle.readSync();
      if (!entry) break;
      if (scanned >= 2000 || folders.length >= 200) { limited = true; break; }
      if (entry.isDirectory() && !entry.name.startsWith('.')) folders.push({ name: entry.name, path: path.join(directory, entry.name) });
    }
  } finally { handle.closeSync(); }
  const parent = path.dirname(directory);
  return { path: directory, home: os.homedir(), parent: parent === directory ? null : parent,
    folders: folders.sort((a, b) => a.name.localeCompare(b.name)), limited };
}
