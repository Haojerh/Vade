import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentChatOptions, SetAgentChatOptionRequest } from '../../../shared/contracts.js';
import type { SessionRecord } from '../../runtime/store.js';
import { CliError } from '../../integrations/cli.js';
import type { ChatControlIO } from '../../runtime/chat/controls/chatControlTypes.js';
import { isPathInsideRoots } from '../common/transcriptUtils.js';
import { DSH_PLUGIN } from './dshPlugin.js';

export const validDshId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(id);
export const dshDirectory = (directory: string, record: SessionRecord) => path.join(directory, 'dsh', record.id, record.statusToken!);
function read(directory: string, record: SessionRecord, name: string, limit: number): any {
  const root = dshDirectory(directory, record), file = path.join(root, name);
  if (!record.statusToken || !isPathInsideRoots(file, [root]) || fs.statSync(file).size > limit) throw new Error('DSH observation unavailable');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.token !== record.statusToken || !validDshId(value.id) || value.cwd !== record.cwd || record.providerThreadId && value.id !== record.providerThreadId) throw new Error('Foreign DSH observation');
  return value;
}
export function dshBinding(directory: string, record: SessionRecord): string | undefined {
  if (record.provider !== 'dsh') return record.providerThreadId;
  try { return read(directory, record, 'binding.json', 4096).id; } catch { return record.providerThreadId; }
}
/** Older observers did not report durability; native resume still validates those sessions. */
export function dshResumable(directory: string, record: SessionRecord): boolean {
  try { return read(directory, record, 'binding.json', 4096).saved !== false; } catch { return true; }
}
export function prepareDsh(directory: string, record: SessionRecord): string {
  const root = dshDirectory(directory, record);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const plugin = path.join(root, 'observer.mjs'), patch = path.join(root, 'launch.patch.json');
  let continuationReceipt=path.join(directory,'dsh',record.id,`continuation-${record.providerThreadId}.json`);
  const legacy=path.join(directory,'dsh',record.id,'continuation.json');
  try{if(record.dshContinuation&&fs.statSync(legacy).size<=4096){const value=JSON.parse(fs.readFileSync(legacy,'utf8'));if(value.target===record.providerThreadId&&value.source===record.dshContinuation.threadId&&value.cwd===record.cwd)continuationReceipt=legacy;}}catch{/* No legacy receipt for this target. */}
  fs.writeFileSync(plugin, DSH_PLUGIN, { mode: 0o600 });
  let registry: string | undefined;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  for (const base of [path.join(home, 'profiles', 'dsh-tui'), ...((process.env.PATH ?? '').split(path.delimiter).filter(Boolean))]) {
    try {
      const candidate = path.join(base, 'node_modules', '@deepseek-harness-tui', 'dsh-tui', 'lib', 'types', 'adapter', 'channel', 'host-registry.js');
      if (fs.existsSync(candidate)) { registry = fs.realpathSync(candidate); break; }
    } catch { /* Try the next fixed installed package root. */ }
  }
  const patches: object[] = [{ insert: [{ id: 'vade-dsh-observer', name: plugin.replaceAll('\\','/'), config: { directory: root, statusFile: path.join(directory, 'status', record.id + '.json'), token: record.statusToken, cwd: record.cwd, expected: record.providerThreadId, registry,
    ...(record.dshContinuation ? { continuation: record.dshContinuation, continuationReceipt } : {}) } }] }];
  if (!record.providerThreadId && record.workflowLaunch?.model) {
    const split = record.workflowLaunch.model.indexOf('/');
    if (split < 1) throw new CliError('INVALID_ARGUMENT', 'DSH models require an exact provider route');
    patches.push({ id: 'agent-default-model', config: { provider: record.workflowLaunch.model.slice(0, split), model: record.workflowLaunch.model.slice(split + 1), ...(record.workflowLaunch.effort ? { reasoningEffort: record.workflowLaunch.effort } : {}) } });
  }
  fs.writeFileSync(patch, JSON.stringify(patches), { mode: 0o600 });
  return patch;
}
export function dshTranscript(directory: string, record: SessionRecord): { file: string; root: string } {
  if (dshBinding(directory, record) !== record.providerThreadId || !record.providerThreadId) throw new Error('DSH session is not bound');
  read(directory, record, 'binding.json', 4096);
  const root = dshDirectory(directory, record), file = path.join(root, 'conversation.jsonl');
  if (!isPathInsideRoots(file, [root]) || !fs.statSync(file).isFile()) throw new Error('DSH transcript unavailable');
  return { file, root };
}
export function dshStatus(directory: string, record: SessionRecord): any {
  return read(directory, record, 'status.json', 4096);
}
export function dshReady(directory: string, record: SessionRecord): boolean {
  try { return Boolean(record.providerThreadId && read(directory, record, 'options.json', 262144).ready === true); } catch { return false; }
}
export function dshOptions(directory: string, record: SessionRecord): AgentChatOptions {
  let value: any;
  try { value = read(directory, record, 'options.json', 262144); }
  catch { throw new CliError('RUNTIME_UNAVAILABLE', 'The native DSH session settings are not available yet. Finish setup in Terminal and retry.'); }
  const safe = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,199}$/.test(s);
  const label = (s: string, limit: number) => s.replace(/[\x00-\x1f\x7f]/g, '').slice(0,limit);
  const models = (Array.isArray(value.models) ? value.models : []).slice(0,200).filter((m: any) => safe(m.id) && typeof m.label === 'string').map((m: any) => ({ id: m.id, label: label(m.label,160), efforts: (Array.isArray(m.efforts) ? m.efforts : []).slice(0,16).filter((e: any) => safe(e.value) && typeof e.label === 'string').map((e: any) => ({value:e.value,label:label(e.label,80)})) }));
  const current = { ...(safe(value.current?.model) ? { model: value.current.model } : {}), ...(safe(value.current?.effort) ? { effort: value.current.effort } : {}), ...(safe(value.current?.permission) ? { permission: value.current.permission } : {}) };
  const permissions=value.ready===true?(Array.isArray(value.permissions)?value.permissions:[]).slice(0,32).filter((p:any)=>safe(p.value)&&typeof p.label==='string').map((p:any)=>({value:p.value,label:label(p.label,160),...(typeof p.description==='string'?{description:label(p.description,400)}:{})})):[];
  return { provider: 'dsh', transport: 'terminal', models, current, ...(permissions.length?{permissions}:{}), controls: { model: value.ready === true && models.length > 0, effort: value.ready === true && Boolean(models.find((m: any) => m.id === current.model)?.efforts.length), fastMode: false, fastToggle: false, serviceTier: false, providerPicker: false } };
}
export async function applyDshOption(directory: string, record: SessionRecord, request: SetAgentChatOptionRequest, io: ChatControlIO): Promise<AgentChatOptions> {
  if (!dshReady(directory, record)) throw new CliError('RUNTIME_UNAVAILABLE', 'Wait for the native DSH session to finish opening');
  const options = dshOptions(directory, record), model = options.models.find(m => m.id === options.current.model);
  if (request.key !== 'model' && request.key !== 'effort' && request.key !== 'permission' || request.key === 'model' && !options.models.some(m => m.id === request.value) || request.key === 'effort' && !model?.efforts.some(e => e.value === request.value) || request.key === 'permission' && !options.permissions?.some(p=>p.value===request.value)) throw new CliError('INVALID_ARGUMENT', 'Choose an advertised native DSH setting');
  if (options.current[request.key] === request.value) return options;
  const command = `/${request.key} ${request.value}`;
  await io.write(`\x1b[200~${command}\x1b[201~`);
  await io.waitFor(screen => screen.split('\n').some(line => line.trim().replace(/^⌸\s*/, '').replace(/\s*⛶$/, '').trim() === `❯ ${command}`));
  await io.write('\r');
  await io.waitFor(() => { try { return dshOptions(directory, record).current[request.key as 'model' | 'effort'] === request.value; } catch { return false; } });
  return dshOptions(directory, record);
}
