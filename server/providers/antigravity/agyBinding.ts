import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionRecord } from '../../runtime/store.js';
import { validCodexThreadId } from '../codex/codexThread.js';
import { CliError } from '../../integrations/cli.js';
import { DatabaseSync } from 'node:sqlite';

export function agyConversationSaved(record: SessionRecord): boolean {
  if (!validCodexThreadId(record.providerThreadId)) return false;
  const root = process.env.GEMINI_APPDATA_DIR || process.env.ANTIGRAVITY_APPDATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli');
  const file = path.join(root, 'conversations', record.providerThreadId + '.db');
  let db;
  try {
    if (!fs.statSync(file).isFile()) return false;
    db = new DatabaseSync(file, { readOnly: true });
    return Boolean(db.prepare('SELECT 1 FROM trajectory_meta WHERE cascade_id = ? LIMIT 1').get(record.providerThreadId));
  } catch { return false; } finally { db?.close(); }
}

// Observe identity only. No tool hooks, approvals, prompt text, or provider credentials are retained.
export const AGY_IDENTITY_HOOK = String.raw`
const fs = require('node:fs');
const path = require('node:path');
process.stdout.write('{}\n');
const file = process.env.ADE_BINDING_FILE, token = process.env.ADE_BINDING_TOKEN;
if (!file || !token) process.exit(0);
let text = '', bytes = 0;
const timer = setTimeout(() => process.exit(0), 1500);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  bytes += Buffer.byteLength(chunk); if (bytes > 131072) process.exit(0);
  text += chunk;
  try {
    const payload = JSON.parse(text);
    const id = payload.conversationId;
    const cwd = process.env.ADE_BINDING_CWD;
    const matchesWorkspace = cwd && Array.isArray(payload.workspacePaths) && payload.workspacePaths.slice(0,32).some(p => typeof p === 'string' && p.length <= 4096 && path.resolve(p) === path.resolve(cwd));
    if (matchesWorkspace && typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      fs.writeFileSync(file + '.tmp', JSON.stringify({ token, id }), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    }
    clearTimeout(timer); process.exit(0);
  } catch {}
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
`;

export function installAgyHook(directory: string, node: string, configFile = path.join(os.homedir(), '.gemini', 'config', 'hooks.json')): void {
  const script = path.join(directory, 'agy-identity-hook.cjs');
  if (/["%\r\n]/.test(node + script)) throw new CliError('INVALID_ARGUMENT', 'The runtime path cannot be used by the Antigravity identity hook');
  fs.mkdirSync(path.join(directory, 'bindings'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(script, AGY_IDENTITY_HOOK, { mode: 0o600 });
  let original = '{}';
  if (fs.existsSync(configFile)) {
    if (fs.statSync(configFile).size > 524288) throw new CliError('INVALID_ARGUMENT', 'Antigravity hook configuration is too large');
    original = fs.readFileSync(configFile, 'utf8');
  }
  let config: Record<string, unknown>;
  try { config = JSON.parse(original); if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error(); }
  catch { throw new CliError('INVALID_ARGUMENT', 'Antigravity hooks.json could not be parsed; existing settings were preserved'); }
  let command = `"${node}" "${script}"`;
  if (process.platform === 'win32') {
    const wrapper = path.join(directory, 'agy-identity-hook.cmd');
    fs.writeFileSync(wrapper, `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${node}" "${script}"\r\nexit /b 0\r\n`);
    command = /^[a-zA-Z]:[\\/][a-zA-Z0-9_./\\-]+$/.test(wrapper) ? wrapper.replaceAll('\\', '/') : `"${wrapper}"`;
  }
  const handler = [{ type: 'command', command, timeout: 2 }];
  const bundle = { SessionStart: handler, PreInvocation: handler, PostInvocation: handler };
  if (JSON.stringify(config['ade-session-identity']) === JSON.stringify(bundle)) return;
  config['ade-session-identity'] = bundle;
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  if (original !== '{}' && !fs.existsSync(configFile + '.ade-backup')) fs.writeFileSync(configFile + '.ade-backup', original, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export function agyBindingFile(directory: string, record: SessionRecord): string {
  if (!validCodexThreadId(record.id)) throw new CliError('INVALID_ARGUMENT', 'Invalid ADE session identity');
  return path.join(directory, 'bindings', record.id + '.json');
}

export function readAgyBinding(directory: string, record: SessionRecord): string | undefined {
  if (record.provider !== 'antigravity' || !record.bindingToken) return record.providerThreadId;
  try {
    const file = agyBindingFile(directory, record);
    if (fs.statSync(file).size > 4096) return record.providerThreadId;
    const binding = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (binding.token === record.bindingToken && validCodexThreadId(binding.id)) return binding.id;
  } catch { /* No provider event yet. Keep the last exact binding, if any. */ }
  return record.providerThreadId;
}
