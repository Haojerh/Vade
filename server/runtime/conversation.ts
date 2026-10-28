import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConversationImage, ConversationPage, NodeDetailsQuery, Section, ToolActivity, ProviderActivity } from '../../shared/contracts.js';
import { databaseProviderActivity, transcriptProviderActivity } from '../providers/providerActivity.js';
import type { SessionRecord } from './store.js';
import { validCodexThreadId } from './codexThread.js';
import { CliError } from '../integrations/cli.js';
import { hashId, isPathInsideRoots, readBoundedTranscriptLines, readOlderTranscriptLines,toIsoOrNull } from '../providers/transcriptUtils.js';
import { issueStoredCursor, validateStoredCursor } from '../providers/conversationCursors.js';
import { parseCoordinatorTranscriptLine } from '../providers/publicTranscript.js';
import { CONVERSATION_PAGE_READ_BYTES, MAX_CONVERSATION_PAGE_IMAGE_BYTES, imageContentDigest, readRecordAt, readRecordedImage, recordedUserImages, recordsTranscriptImages, stripImagePromptMarkers, verifyConversationImageId } from '../providers/conversationImages.js';
import {stagedUserImages,readStagedUserImage,stripStagedImagePaths} from './stagedConversationImages.js';
import {publicRewindTarget,type NativeUserAnchor} from './providerRewind.js';
import {forkClaudeBefore} from './claudeRewind.js';
import {codeBuddyBranch} from './codeBuddyBranch.js';
import {claudeNativeRounds,codexNativeRounds,mergeConversationRounds,nativeRoundRows} from './conversationRounds.js';
import { parseAntigravityTranscriptLine, readAntigravityModel, readAntigravityToolActivity } from '../providers/antigravity.js';
import { transcriptSettings, claudeLocalCommandEffort, claudeLocalCommandModel,stripAnsiCodes } from '../providers/shared.js';
import { codeBuddyEffortAcknowledgement } from '../providers/codeBuddySettings.js';
import { isOpenCode, verifyOpenCode, withOpenCode } from './openCodeSessions.js';
import { readOpenCodePage, readOpenCodeModel } from '../providers/opencode.js';
import { readOpenCodeV2Page, readOpenCodeV2Model, openCodeV2Tools } from '../providers/openCodeV2.js';
import { databaseToolActivity, mergeToolActivity, transcriptToolActivity } from '../providers/toolActivity.js';
import { dshTranscript } from './dsh.js';
import { isContextRecord, transcriptContextUsage, unknownContext } from '../providers/contextUsage.js';
import type { AgentContextUsage } from '../../shared/contracts.js';
import { readDatabaseContext } from './providerContext.js';

/** Native item_completed events connect one public draft to its native UserMessage.
 * Never match message text or assume response-item IDs equal native item IDs. */
export function codexRecordedUserAnchors(lines:string[],source:string):Map<string,NativeUserAnchor>{
  const result=new Map<string,NativeUserAnchor>();let turn:string|undefined,pending:string[]=[],completed=false;
  for(const line of lines){try{
    const row=JSON.parse(line);
    if(row.type==='event_msg'&&row.payload?.type==='task_started'){turn=typeof row.payload.turn_id==='string'?row.payload.turn_id:undefined;pending=[];completed=false;continue;}
    if(row.type==='event_msg'&&['task_complete','turn_aborted'].includes(row.payload?.type)){turn=undefined;pending=[];continue;}
    if(!turn||completed)continue;
    const message=parseCoordinatorTranscriptLine(line,'codex',source).message;
    if(message?.role==='user')pending.push(message.id);
    if(row.type==='event_msg'&&row.payload?.type==='item_completed'&&row.payload.turn_id===turn&&row.payload.item?.type==='UserMessage'){
      const id=row.payload.item.id;
      if(pending.length===1&&typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id))result.set(pending[0],{provider:'codex',field:'codex-item-id',nativeId:id});
      completed=true;pending=[];
    }
  }catch{/* Incomplete native records provide no anchor. */}}
  return result;
}

/** Exact-session local command records supply settings without entering public chat. */
export function codeBuddyRecordedSettings(lines: string[], record: SessionRecord): { model?: string | null; effort?: string | null } {
  const aliases = new Map<string, Set<string>>();
  const evidence: Array<{ model?: string; effort?: string; commandModel?: string; output: string }> = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.sessionId !== record.providerThreadId || typeof row.cwd !== 'string' || ![record.cwd, record.sourceCwd].some(cwd => cwd && path.relative(path.resolve(cwd), path.resolve(row.cwd)) === '')) continue;
      const output = row.type === 'message' && row.role === 'user' && row.providerData?.skipRun === true && Array.isArray(row.content)
        ? row.content.flatMap((part: any) => part?.type === 'input_text' && typeof part.text === 'string' && part.text.startsWith('<local-command-stdout>') && part.text.endsWith('</local-command-stdout>') ? [part.text.slice(22, -23)] : []).join('\n') : '';
      for (const match of output.matchAll(/^\s*-\s+(.+?)\s+\(([a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199})\)(?:\s+← current)?\s*$/gm)) {
        const ids = aliases.get(match[1]) ?? new Set<string>(); ids.add(match[2]); aliases.set(match[1], ids);
      }
      for (const match of output.matchAll(/^\s*-\s+([a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199})(?:\s+← current)?\s*$/gm)) {
        const ids = aliases.get(match[1]) ?? new Set<string>(); ids.add(match[1]); aliases.set(match[1], ids);
      }
      const commandModel = row.type === 'message' && row.role === 'user' && row.providerData?.skipRun === true && Array.isArray(row.content)
        ? row.content.flatMap((part: any) => part?.type === 'input_text' && typeof part.text === 'string' && /^<command-name>\/?model<\/command-name>/.test(part.text)
          ? [part.text.match(/<command-args>([a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199})<\/command-args>/)?.[1]] : []).find(Boolean) : undefined;
      evidence.push({ model: row.providerData?.skipRun === true ? undefined : row.providerData?.model, effort: row.providerData?.skipRun === true ? undefined : row.providerData?.effort, commandModel, output });
    } catch { /* Ignore incomplete or foreign records. */ }
  }
  const result: { model?: string | null; effort?: string | null } = {};
  let requestedModel: string | undefined;
  let ultracode = false;
  for (const row of evidence) {
    if (row.commandModel) requestedModel = row.commandModel;
    if (typeof row.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(row.model)) {
      if (row.model !== result.model && !ultracode) result.effort = null;
      result.model = row.model;
      if (!ultracode && typeof row.effort === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(row.effort)) result.effort = row.effort;
    }
    const current = row.output.match(/^\s*-\s+.+?\s+\(([a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199})\)\s+← current\s*$/m)?.[1]
      ?? row.output.match(/^\s*-\s+([a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199})\s+← current\s*$/m)?.[1];
    const switched = row.output.match(/^Switched (?:model|this session) to (.+?)(?:\.|, but the global default could not be saved\.)\s*$/m)?.[1];
    const ids = switched ? aliases.get(switched) : undefined;
    const model = current ?? (ids?.has(requestedModel ?? '') ? requestedModel : ids?.size === 1 ? [...ids][0] : undefined);
    if (model) { if (model !== result.model && !ultracode) result.effort = null; result.model = model; }
    else if (switched && ids && ids.size > 1) { result.model = null; if (!ultracode) result.effort = null; }
    if (switched || current || /^(?:Error:|Failed to switch)/m.test(row.output)) requestedModel = undefined;
    const effort = codeBuddyEffortAcknowledgement(row.output);
    if (effort) { ultracode = effort === 'ultracode'; result.effort = effort; }
  }
  return result;
}

function unavailable(message: string): Section<ConversationPage> {
  return { data: null, meta: { availability: 'unavailable', observedAt: null, attemptedAt: new Date().toISOString(), partial: false, stale: false,
    issue: { code: 'RUNTIME_UNAVAILABLE', message, retryable: true } } };
}

// Only exact UUID filenames under provider roots are eligible. Directory work is bounded.
function findFile(root: string, id: string, depth: number): string | null {
  let remaining = 4096;
  const visit = (directory: string, level: number): string | null => {
    if (!isPathInsideRoots(directory, [root])) return null;
    const entries = fs.opendirSync(directory);
    try {
      let entry: fs.Dirent | null;
      while ((entry = entries.readSync())) {
        if (--remaining < 0) return null;
        if (entry.isFile() && (entry.name === `${id}.jsonl` || entry.name.endsWith(`-${id}.jsonl`))) return path.join(directory, entry.name);
        if (level && entry.isDirectory()) { const match = visit(path.join(directory, entry.name), level - 1); if (match) return match; }
      }
    } finally { entries.closeSync(); }
    return null;
  };
  try { return visit(root, depth); } catch { return null; }
}

function verifyJsonSession(file: string, record: SessionRecord): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(65536);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, size).toString('utf8').split('\n').slice(0, 100)) {
      try {
        const row = JSON.parse(line);
        const metadata = record.provider === 'codex' && row.type === 'session_meta' ? row.payload : ['claude','codebuddy'].includes(record.provider) ? row : null;
        const id = record.provider === 'codex' ? metadata?.id : metadata?.sessionId;
        if (id === record.providerThreadId && typeof metadata.cwd === 'string' && [record.cwd, record.sourceCwd].some(cwd => cwd && path.relative(path.resolve(cwd), path.resolve(metadata.cwd)) === '')) return true;
      } catch { /* A partial or non-message record cannot establish provenance. */ }
    }
    return false;
  } finally { fs.closeSync(fd); }
}

/** Private local-command evidence, never public conversation. Start at the exact
 * owned transcript's current byte cursor so historical acknowledgements cannot confirm a new setting. */
export function codeBuddyCommandOutput(record: SessionRecord): () => string {
  const root = path.join(process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy'), 'projects');
  const file = record.provider === 'codebuddy' && record.providerThreadId ? findFile(root, record.providerThreadId, 1) : null;
  if (!file || !verifyJsonSession(file, record)) throw new CliError('RUNTIME_UNAVAILABLE', 'The exact CodeBuddy command history is not available yet. Use Terminal until its session is recorded.');
  const original = fs.statSync(file), offset = original.size;
  const initial = fs.openSync(file, 'r');
  const last = Buffer.alloc(1);
  let skipFirst = false;
  try { if (offset) { fs.readSync(initial, last, 0, 1, offset - 1); skipFirst = last[0] !== 10; } } finally { fs.closeSync(initial); }
  return () => {
    const fd = fs.openSync(file, 'r');
    try {
      const current = fs.fstatSync(fd), size = current.size - offset;
      if (current.dev !== original.dev || current.ino !== original.ino || size < 0 || size > 262144) throw new CliError('RUNTIME_UNAVAILABLE', 'CodeBuddy command history changed or exceeded its read limit. Inspect Terminal before retrying.');
      const buffer = Buffer.alloc(size); fs.readSync(fd, buffer, 0, size, offset);
      const lines = buffer.toString('utf8').split('\n');
      if (skipFirst) lines.shift();
      return lines.flatMap(line => {
        try {
          const row = JSON.parse(line);
          if (row.type !== 'message' || row.role !== 'user' || row.sessionId !== record.providerThreadId || row.providerData?.skipRun !== true
            || typeof row.cwd !== 'string' || ![record.cwd, record.sourceCwd].some(cwd => cwd && path.relative(path.resolve(cwd), path.resolve(row.cwd)) === '')) return [];
          return Array.isArray(row.content) ? row.content.flatMap((part: any) => part?.type === 'input_text' && typeof part.text === 'string'
            && part.text.startsWith('<local-command-stdout>') && part.text.endsWith('</local-command-stdout>') ? [part.text.slice(22, -23)] : []) : [];
        } catch { return []; }
      }).join('\n');
    } finally { fs.closeSync(fd); }
  };
}

/** Observe only records appended after the operation began; never replay controls. */
export function claudeSettingConfirmation(record:SessionRecord,request:{key:string;value:string},expectedLabel?:string):(()=>boolean)|undefined{
  if(record.provider!=='claude'||!['model','effort'].includes(request.key)||!record.providerThreadId)return;
  const root=path.join(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude'),'projects');
  const file=findFile(root,record.providerThreadId,1);
  if(!file||!verifyJsonSession(file,record))return;
  const original=fs.statSync(file),offset=original.size,since=Date.now()-1000;
  return ()=>{
    let fd:number|undefined;
    try{
      fd=fs.openSync(file,'r');const current=fs.fstatSync(fd),length=current.size-offset;
      if(current.dev!==original.dev||current.ino!==original.ino||length<0||length>262144)return false;
      const buffer=Buffer.alloc(length);fs.readSync(fd,buffer,0,length,offset);
      return buffer.toString('utf8').split('\n').slice(0,200).some(line=>{try{
        const row=JSON.parse(line);
        if(row.sessionId!==record.providerThreadId||Date.parse(row.timestamp)<since||!Number.isFinite(Date.parse(row.timestamp))||row.isSidechain||row._fromSubAgent||row.isMeta||row.isSynthetic||row.type!=='system'||row.subtype!=='local_command'||row.commandRun?.command!==request.key||row.commandRun.args?.trim()!==request.value||typeof row.cwd!=='string'||![record.cwd,record.sourceCwd].some(cwd=>cwd&&path.relative(path.resolve(cwd),path.resolve(row.cwd))===''))return false;
        if(request.key==='effort')return claudeLocalCommandEffort(row)===request.value;
        const model=claudeLocalCommandModel(row);if(!model)return false;
        const normalize=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]/g,'');
        return /^<local-command-stdout>\s*(?:Set model to|Model set to)\b/.test(stripAnsiCodes(row.content).trim())||[request.value,expectedLabel].some(value=>value&&normalize(value)===normalize(model));
      }catch{return false;}});
    }catch{return false;}finally{if(fd!==undefined)fs.closeSync(fd);}
  };
}

export function publicMessage(record: SessionRecord, line: string, sourceIdentity: string, offset?: number, imageBudget?: { remaining: number },attachmentRoot?:string) {
  const visible = (message: ReturnType<typeof parseCoordinatorTranscriptLine>['message']) => {
    if (!message || message.role !== 'user' || !message.text.startsWith('[Vade workflow assignment; protocol 1.0.0]')) return message;
    if (!message.text.includes('\nYou are the orchestrator.')) {
      const role = message.text.indexOf('\nRole:\n'), task = message.text.indexOf('\nTask:\n', role), original = message.text.indexOf('\nOriginal user request:\n', task), end = message.text.lastIndexOf('\nPredecessor results (full results via context):\n');
      if (role < 0 || task < role || original < task || end < original) return null;
      return { ...message, text: 'Workflow assignment\n\nRole:\n' + message.text.slice(role + 7, task) + '\n\nTask:\n' + message.text.slice(task + 7, original) + '\n\nOriginal user request:\n' + message.text.slice(original + 24, end) };
    }
    const marker = '\nOriginal user request:\n', start = message.text.indexOf(marker);
    return start < 0 ? null : { ...message, text: message.text.slice(start + marker.length) };
  };
  // Recorded user images are metadata only; their bytes are served by the exact-record route.
  const projected = (message: ReturnType<typeof parseCoordinatorTranscriptLine>['message']) => {
    if (!message || message.role!=='user' || offset === undefined) return message;
    const { images, markerNumbers } = recordedUserImages(record.provider, line, sourceIdentity, offset);
    const staged=!images.length&&attachmentRoot?stagedUserImages(record.provider,line,attachmentRoot,sourceIdentity,offset):{images:[],paths:[]};
    const kept: ConversationImage[] = [], keptMarkers: number[] = [];
    const keptPaths:string[]=[];
    (images.length?images:staged.images).forEach((image, index) => {
      if (imageBudget && image.bytes > imageBudget.remaining) return;
      if (imageBudget) imageBudget.remaining -= image.bytes;
      kept.push(image);
      if(staged.paths[index])keptPaths.push(staged.paths[index]);else keptMarkers.push(markerNumbers[index]!);
    });
    if (!kept.length) return message;
    return { ...message, text: stripStagedImagePaths(stripImagePromptMarkers(message.text, keptMarkers),keptPaths), images: kept };
  };
  try {
    const row = JSON.parse(line);
    const codeBuddySummaryCompaction=row.providerData?.isSummary===true&&typeof row.providerData?.compactionId==='string'&&row.providerData?.isCompactInternal!==true&&row.providerData?.isCompactRecovery!==true;
    const codeBuddyManualCompaction=row.providerData?.isCompacted===true&&typeof row.providerData?.compactionId==='string'&&row.providerData?.compactType==='user-command'&&row.providerData?.compactionKind==='manual'&&row.providerData?.compactionTrigger==='manual'&&row.providerData?.isCompactRecovery!==true;
    const compaction=!row.isSidechain&&!row._fromSubAgent&&(!row.sessionId||row.sessionId===record.providerThreadId)&&(
      ['codex','dsh','opencode','kilo','opencode2'].includes(record.provider)&&row.type==='compacted'
      ||record.provider==='claude'&&row.type==='system'&&row.subtype==='compact_boundary'
      ||record.provider==='codebuddy'&&(codeBuddySummaryCompaction||codeBuddyManualCompaction));
    if(compaction)return {id:hashId('msg',`${sourceIdentity}:compaction:${row.uuid??row.id??hashId('record',line)}`),role:'agent' as const,kind:'compaction' as const,text:'Context compacted',at:toIsoOrNull(row.timestamp)};
    if(record.provider==='codebuddy'&&typeof row.providerData?.compactionId==='string'&&(row.providerData?.isCompacted===true||row.providerData?.isSummary===true||row.providerData?.isCompactInternal===true))return null;
    if (record.provider !== 'antigravity') {
      if (['claude','codebuddy'].includes(record.provider) && row.sessionId && row.sessionId !== record.providerThreadId) return null;
      const message=projected(visible(parseCoordinatorTranscriptLine(line, record.provider, sourceIdentity).message));
      if(message?.role==='user'&&record.provider==='claude'&&!message.images?.length&&publicRewindTarget('claude',line,sourceIdentity)?.messageId===message.id&&!row.message?.content?.some?.((part:any)=>['image','document','tool_result'].includes(part?.type)))return {...message,rewindable:true};
      return message&&record.provider==='dsh'&&message.role==='user'&&!row.payload?.hasAttachments&&Number.isSafeInteger(row.payload?.nativeSeq)&&row.payload.nativeSeq>=0&&row.payload.nativeSeq<4000?{...message,rewindable:true}:message;
    }
    if (['USER_EXPLICIT', 'USER'].includes(row.source) && ['USER_INPUT', 'REQUEST'].includes(row.type)) {
      return visible(parseAntigravityTranscriptLine(JSON.stringify({ ...row, type: 'USER_INPUT' }), sourceIdentity).message);
    }
    return (row.source === 'MODEL' && row.type === 'PLANNER_RESPONSE'||row.type==='CHECKPOINT'&&row.source==='SYSTEM') ? parseAntigravityTranscriptLine(line, sourceIdentity).message : null;
  } catch { return null; }
}

export class AdeConversations {
  private roundCache=new Map<string,{stamp:string;rounds:import('../../shared/contracts.js').ConversationRound[]}>();
  private nativeRounds(record:SessionRecord,file:string,source:string,stat:fs.Stats){
    if(!['claude','codex'].includes(record.provider))return [];
    const stamp=`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,cached=this.roundCache.get(source);if(cached?.stamp===stamp)return cached.rounds;
    const rows=nativeRoundRows(file,stat.size),rounds=(record.provider==='claude'?claudeNativeRounds:codexNativeRounds)(record.providerThreadId!,rows,source);
    if(this.roundCache.size>=32)this.roundCache.delete(this.roundCache.keys().next().value!);this.roundCache.set(source,{stamp,rounds});return rounds;
  }
  constructor(private directory = process.env.ADE_DATA_DIR || path.join(os.homedir(), '.ade'),private nativeRewindAvailable:(record:SessionRecord)=>boolean=()=>false,private savedRounds:(record:SessionRecord)=>import('../../shared/contracts.js').ConversationRound[]=()=>[]) {}
  watch(record: SessionRecord, changed: () => void): () => void {
    let watcher: fs.FSWatcher | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { file } = this.resolve(record);
      // Watch the parent so atomic transcript replacement is observed as well.
      watcher = fs.watch(path.dirname(file), (_event, name) => {
        if (name && ![path.basename(file), ...(isOpenCode(record.provider) ? [path.basename(file) + '-wal'] : [])].includes(name.toString())) return;
        clearTimeout(timer); timer = setTimeout(changed, 75);
      });
      watcher.on('error', () => { watcher?.close(); });
    } catch { /* A not-yet-bound transcript is discovered by the polling fallback. */ }
    return () => { clearTimeout(timer); watcher?.close(); };
  }
  private paths = new Map<string, string>();

  resumeAvailable(record:SessionRecord):boolean {
    if(record.provider==='terminal')return false;
    try{this.resolve(record);return true;}catch{return false;}
  }

  private resolve(record: SessionRecord): { file: string; root: string } {
    if (record.provider === 'dsh') return dshTranscript(this.directory, record);
    if (isOpenCode(record.provider)) { const file = verifyOpenCode(record); return { file, root: path.dirname(file) }; }
    if (!validCodexThreadId(record.providerThreadId)) throw new Error('No verified provider conversation binding');
    const id = record.providerThreadId;
    const agy = record.provider === 'antigravity';
    const root = agy ? process.env.GEMINI_APPDATA_DIR || process.env.ANTIGRAVITY_APPDATA_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli')
      : record.provider === 'codex' ? path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions')
      : record.provider === 'codebuddy' ? path.join(process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy'), 'projects')
      : path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
    const key = `${root}:${record.provider}:${id}:${record.cwd}`;
    let file = this.paths.get(key);
    if (!file || !fs.existsSync(file)) file = agy ? path.join(root, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl') : findFile(root, id, record.provider === 'codex' ? 3 : 1) ?? undefined;
    if (!file || !isPathInsideRoots(file, [root])) throw new Error('No exact provider transcript');
    if (agy) {
      const database = path.join(root, 'conversations', `${id}.db`);
      if (!isPathInsideRoots(database, [root])) throw new Error('Antigravity conversation database is unavailable');
      const db = new DatabaseSync(database, { readOnly: true });
      try { if (!db.prepare('SELECT 1 FROM trajectory_meta WHERE cascade_id = ? LIMIT 1').get(id)) throw new Error('Antigravity conversation identity does not match'); }
      finally { db.close(); }
    } else if (!verifyJsonSession(file, record)) throw new Error('Transcript session or workspace does not match this agent');
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('Provider transcript is not a regular file');
    if (this.paths.size >= 200) this.paths.delete(this.paths.keys().next().value!);
    this.paths.set(key, file);
    return { file, root };
  }

  private metadataCache = new Map<string, { stamp: string; value: Awaited<ReturnType<AdeConversations['readMetadata']>> }>();
  private metadataPending = new Map<string, Promise<Awaited<ReturnType<AdeConversations['readMetadata']>>>>();
  async metadata(record: SessionRecord): Promise<Awaited<ReturnType<AdeConversations['readMetadata']>>> {
    // Antigravity also reads a separate database, so transcript stamps alone cannot cache it.
    if (record.provider === 'antigravity' || isOpenCode(record.provider)) return this.readMetadata(record);
    try {
      const { file } = this.resolve(record), stat = fs.statSync(file);
      const key = `${record.projectId}:${record.id}:${record.provider}:${record.providerThreadId}:${record.cwd}`;
      const stamp = `${file}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`;
      const cached = this.metadataCache.get(key); if (cached?.stamp === stamp) return cached.value;
      const pendingKey = `${key}:${stamp}`, previous = this.metadataPending.get(pendingKey); if (previous) return previous;
      const pending = this.readMetadata(record).then(value => {
        if (value.toolActivity.meta.availability === 'ready' || value.toolActivity.meta.availability === 'empty') {
          if (this.metadataCache.size >= 128) this.metadataCache.delete(this.metadataCache.keys().next().value!);
          this.metadataCache.set(key, { stamp, value });
        }
        return value;
      }).finally(() => this.metadataPending.delete(pendingKey));
      this.metadataPending.set(pendingKey, pending); return pending;
    } catch { return this.readMetadata(record); }
  }

  private async readMetadata(record: SessionRecord): Promise<{ preview: string | null; model: string | null; effort: string | null; contextUsage: AgentContextUsage; toolActivity: Section<ToolActivity[]>; providerActivity: Section<ProviderActivity[]> }> {
    const now = new Date().toISOString();
    const result = { preview: null as string | null, model: null as string | null, effort: null as string | null, contextUsage: unknownContext(record.provider), providerActivity: {
      data: null, meta: { availability: 'unavailable', attemptedAt: now, observedAt: null, partial: true, stale: false, issue: null },
    } as Section<ProviderActivity[]>, toolActivity: {
      data: null, meta: { availability: 'unavailable', attemptedAt: now, observedAt: null, partial: true, stale: false,
        issue: { code: 'RUNTIME_UNAVAILABLE', message: 'Metadata is not available for this exact provider session yet.', retryable: true } },
    } as Section<ToolActivity[]> };
    try {
      const { file, root } = this.resolve(record), id = record.providerThreadId!;
      const nativeBranch=record.provider==='codebuddy'?codeBuddyBranch(file,id):null;
      const allowed=(line:string)=>nativeBranch?.allows(line)??true;
      const nativePage = record.provider === 'opencode2' ? readOpenCodeV2Page : readOpenCodePage;
      const latest = isOpenCode(record.provider) ? nativePage(file, id, null, 1) : await readOlderTranscriptLines(file, fs.statSync(file).size, 1,
        recordsTranscriptImages(record.provider) ? CONVERSATION_PAGE_READ_BYTES : 1024 * 1024, false,
        line => {const message=allowed(line)?publicMessage(record,line,id):null;return Boolean(message&&!message.kind);});
      result.preview = latest.lines.length ? publicMessage(record, latest.lines[0], id, latest.offsets?.[0])?.text.replace(/\s+/g, ' ').trim().slice(0, 300) || null : null;
      let tools: ToolActivity[];
      if (isOpenCode(record.provider)) {
        result.contextUsage = { ...readDatabaseContext(record, file), cacheAccounting: 'separate' };
        Object.assign(result, (record.provider === 'opencode2' ? readOpenCodeV2Model : readOpenCodeModel)(file, id) ?? {});
        tools = (record.provider === 'opencode2' ? openCodeV2Tools : databaseToolActivity)(file, id);
        const data = databaseProviderActivity(file, id, record.provider === 'opencode2');
        result.providerActivity = { data, meta: { availability: data.length ? 'ready' : 'empty', attemptedAt: now, observedAt: now, partial: true, stale: false, issue: null } };
      } else if (record.provider === 'antigravity') {
        const allowed = (file: string) => isPathInsideRoots(file, [root]);
        const contextFile = path.join(root, 'conversations', `${id}.db`);
        if (allowed(contextFile)) result.contextUsage = readDatabaseContext(record, contextFile);
        const model = readAntigravityModel(id, allowed);
        if (model) Object.assign(result, model);
        tools = readAntigravityToolActivity(id, allowed);
        result.providerActivity.meta.availability = 'unsupported';
      } else {
        const contextRows = await readOlderTranscriptLines(file, fs.statSync(file).size, 200, 4 * 1024 * 1024, false, line=>allowed(line)&&isContextRecord(line));
        result.contextUsage = transcriptContextUsage(record.provider, id, contextRows.lines);
        const settings = (line: string) => {
          if(!allowed(line))return {};
          try {
            const row = JSON.parse(line);
            if (row.sessionId && row.sessionId !== id) return {};
            if (record.provider === 'codex' || record.provider === 'dsh') return row.type === 'turn_context'
              ? { model: row.payload?.model, effort: row.payload?.effort } : {};
            if (record.provider === 'codebuddy') return { model: row.providerData?.model, effort: row.providerData?.effort };
            const effort = record.provider === 'claude' ? claudeLocalCommandEffort(row) : undefined;
            const model = record.provider === 'claude' ? claudeLocalCommandModel(row) : undefined;
            return { ...transcriptSettings(row), ...(effort ? { effort } : {}),...(model?{model}:{}) };
          } catch { return {}; }
        };
        // Scan settings separately so long tool records cannot hide an earlier turn context.
        const recent = await readOlderTranscriptLines(file, fs.statSync(file).size, 200, 4 * 1024 * 1024, false,
          line => Boolean(settings(line).model || settings(line).effort));
        for (const line of recent.lines) {
          const observed = settings(line);
          if (typeof observed.model === 'string' && observed.model.length <= 200 && observed.model !== '<synthetic>') {
            if (result.model !== observed.model) result.effort = null;
            result.model = observed.model;
          }
          if (typeof observed.effort === 'string' && observed.effort.length <= 80) result.effort = observed.effort;
        }
        const activity = await readBoundedTranscriptLines(file, null, 200, 512 * 1024, false,
          line => allowed(line)&&transcriptToolActivity(record.provider, id, line).length > 0);
        tools = activity.lines.flatMap(line => transcriptToolActivity(record.provider, id, line));
        const events = await readOlderTranscriptLines(file, fs.statSync(file).size, 200, 512 * 1024, false, allowed);
        const data = transcriptProviderActivity(record.provider, id, events.lines);
        result.providerActivity = { data, meta: { availability: data.length ? 'ready' : 'empty', attemptedAt: now, observedAt: now, partial: true, stale: false, issue: null } };
        if (record.provider === 'codebuddy') {
          const records = await readOlderTranscriptLines(file, fs.statSync(file).size, 200, 4 * 1024 * 1024, false, line => {
            if(!allowed(line))return false;
            try {
              const row = JSON.parse(line);
              return Boolean(row.providerData?.model || row.providerData?.effort || row.providerData?.skipRun === true && Array.isArray(row.content)
                && row.content.some((part: any) => part?.type === 'input_text' && typeof part.text === 'string' && /^(?:<command-name>\/?model<\/command-name>|<local-command-stdout>)/.test(part.text)));
            } catch { return false; }
          });
          Object.assign(result, codeBuddyRecordedSettings(records.lines, record));
        }
      }
      result.toolActivity = { data: mergeToolActivity(tools),
        meta: { availability: tools.length ? 'ready' : 'empty', attemptedAt: now, observedAt: now, partial: true, stale: false, issue: null } };
    } catch { /* Missing exact-session evidence remains explicitly unavailable. */ }
    return result;
  }

  async rewindTarget(record: SessionRecord, request: import('../../shared/contracts.js').RewindConversationRequest) {
    if(!['dsh','claude','codex'].includes(record.provider)||record.provider==='codex'&&!this.nativeRewindAvailable(record))throw new CliError('RUNTIME_UNAVAILABLE','This terminal provider does not expose verified native rewind.');
    const page=(await this.read(record,{direction:'older',limit:1})).data;
    if(!page||page.sourceIdentity!==request.sourceIdentity||page.revision!==request.revision)throw new CliError('INVALID_ARGUMENT','Conversation changed. Refresh before rewinding.');
    const {file}=this.resolve(record),stat=fs.statSync(file);
    if(record.provider==='claude'&&stat.size>16*1024*1024)throw new CliError('RUNTIME_UNAVAILABLE','This transcript exceeds the bounded native rewind limit.');
    if(hashId('rev',`${page.sourceIdentity}:${stat.size}:${stat.mtimeMs}`)!==request.revision)throw new CliError('INVALID_ARGUMENT','Conversation changed. Refresh before rewinding.');
    const current=()=>{const next=fs.statSync(file);return next.size===stat.size&&next.mtimeMs===stat.mtimeMs&&next.ino===stat.ino;};
    const rows=await readOlderTranscriptLines(file,stat.size,2000,16*1024*1024,false,line=>{if(record.provider==='codex'){try{const row=JSON.parse(line);if(row.type==='event_msg'&&(['task_started','task_complete','turn_aborted'].includes(row.payload?.type)||row.payload?.type==='item_completed'&&row.payload.item?.type==='UserMessage'))return true;}catch{}}const message=publicMessage(record,line,page.sourceIdentity);return Boolean(message&&(message.rewindable||record.provider==='codex'&&message.role==='user'&&publicRewindTarget('codex',line,page.sourceIdentity)));});
    if(!current())throw new CliError('INVALID_ARGUMENT','Conversation changed. Refresh before rewinding.');
    for(const line of rows.lines){
      const message=publicMessage(record,line,page.sourceIdentity);
      if(message?.id!==request.messageId||message.role!=='user'||record.provider!=='codex'&&!message.rewindable)continue;
      const row=JSON.parse(line);
      if(recordedUserImages(record.provider,line,page.sourceIdentity,0).images.length||stagedUserImages(record.provider,line,path.join(this.directory,'attachments'),page.sourceIdentity,0).images.length)throw new CliError('RUNTIME_UNAVAILABLE','Messages with image attachments cannot be restored as text-only drafts.');
      if(record.provider==='codex'){
        const native=publicRewindTarget('codex',line,page.sourceIdentity);
        if(!native||native.messageId!==message.id||row.payload?.content?.some((part:any)=>!['input_text','text'].includes(part?.type)))break;
        const anchor=codexRecordedUserAnchors(rows.lines,page.sourceIdentity).get(message.id);
        if(!anchor)throw new CliError('RUNTIME_UNAVAILABLE','This message has no unambiguous recorded native UserMessage boundary. Use Terminal to rewind.');
        return {anchor,message:message.text,current};
      }
      if(record.provider==='claude'){
        const anchor=publicRewindTarget('claude',line,page.sourceIdentity)?.anchor;
        if(!anchor)break;
        return {message:message.text,current,materialize:()=>forkClaudeBefore(file,record.providerThreadId!,anchor.nativeId,current)};
      }
      if(typeof row.payload?.id!=='string'||row.payload.id.length>200)break;
      return {beforeSeq:row.payload.nativeSeq as number,beforeMessageId:row.payload.id as string,message:message.text,current};
    }
    throw new CliError('INVALID_ARGUMENT','This public message is not an available native rewind target.');
  }

  /** One source identity for both page cursors and projected images, so an image ID can
   *  never outlive the exact transcript binding it was minted against. */
  private identity(record: SessionRecord, file: string): string {
    const stat = fs.statSync(file);
    const branch=record.provider==='codebuddy'?codeBuddyBranch(file,record.providerThreadId!).epoch:'';
    return hashId('src', `${record.projectId}:${record.id}:${record.cwd}:${record.provider}:${record.providerThreadId}:${fs.realpathSync(file)}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}${record.provider==='codebuddy'?':'+branch:''}`);
  }

  /** Exact recorded bytes for one previously projected image locator on this exact session. */
  image(record: SessionRecord, sourceIdentity: string, id: string): { mimeType: string; bytes: Buffer } {
    const locator = verifyConversationImageId(id, sourceIdentity);
    if (!locator) throw new CliError('INVALID_ARGUMENT', 'This conversation image is not available.');
    const { file } = this.resolve(record);
    if (this.identity(record, file) !== sourceIdentity) throw new CliError('INVALID_ARGUMENT', 'Conversation changed. Reload the conversation before opening its images.');
    const line = readRecordAt(file, locator.offset);
    if(line&&record.provider==='codebuddy'&&!codeBuddyBranch(file,record.providerThreadId!).allows(line))throw new CliError('RUNTIME_UNAVAILABLE','This image is not in the active conversation branch.');
    // A structurally valid image token must still refer to a public root user
    // turn. Re-check session and sidechain filters on the serving path too.
    const attachmentRoot=path.join(this.directory,'attachments');
    const message=line?publicMessage(record,line,sourceIdentity,locator.offset,undefined,attachmentRoot):null;
    if(message?.role!=='user'||!message.images?.some(image=>image.id===id))throw new CliError('RUNTIME_UNAVAILABLE','This recorded image changed or is no longer part of the public session.');
    const image = line ? readRecordedImage(record.provider, line, locator.index)??readStagedUserImage(record.provider,line,attachmentRoot,locator.index) : null;
    if (!image) throw new CliError('RUNTIME_UNAVAILABLE', 'This recorded image is no longer available.');
    // A native log may rewrite this row in place; never serve different bytes under an old ID.
    if (imageContentDigest(image.bytes.toString('base64')) !== locator.contentDigest) {
      throw new CliError('RUNTIME_UNAVAILABLE', 'This recorded image changed. Reload the conversation before opening it.');
    }
    return image;
  }

  async read(record: SessionRecord, query: NodeDetailsQuery = {}): Promise<Section<ConversationPage>> {
    try {
      const { file } = this.resolve(record), id = record.providerThreadId!, agy = record.provider === 'antigravity', stat = fs.statSync(file);
      const sourceIdentity = this.identity(record, file);
      const older = query.direction === 'older';
      const expected = { projectId: record.projectId, nodeId: record.id, runId: null, sourceIdentity };
      const cursor = query.cursor ? validateStoredCursor(query.cursor, expected) : null;
      if (cursor && (cursor.direction !== query.direction || (!isOpenCode(record.provider) && Number(cursor.upstreamCursor) > stat.size))) throw new CliError('INVALID_ARGUMENT', 'Conversation cursor direction or source changed');
      const branch=record.provider==='codebuddy'?codeBuddyBranch(file,id):null;
      const parse = (line: string) => branch&&!branch.allows(line)?null:publicMessage(record, line, sourceIdentity);
      // Recorded image bytes are bounded per page, never per message alone.
      const imageBudget = { remaining: MAX_CONVERSATION_PAGE_IMAGE_BYTES };
      const project = (line: string, offset?: number) => {
        if(branch&&!branch.allows(line))return null;
        const message=publicMessage(record,line,sourceIdentity,offset,imageBudget,path.join(this.directory,'attachments'));
        if(record.provider==='codex'&&this.nativeRewindAvailable(record)&&message?.role==='user'&&!message.images?.length&&publicRewindTarget('codex',line,sourceIdentity)?.messageId===message.id){
          const row=JSON.parse(line);
          if(!row.payload?.content?.some((part:any)=>!['input_text','text'].includes(part?.type)))return {...message,rewindable:true};
        }
        return message;
      };
      const database = isOpenCode(record.provider);
      const revision = database ? withOpenCode(record.provider as 'opencode' | 'opencode2' | 'kilo', db => {
        if (record.provider === 'opencode2') return String(db.prepare('SELECT max(time_updated) AS updated FROM (SELECT time_updated FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 200)').get(id)?.updated ?? 0);
        const messages = db.prepare('SELECT max(time_updated) AS updated FROM (SELECT time_updated FROM message WHERE session_id = ? ORDER BY rowid DESC LIMIT 200)').get(id);
        const parts = db.prepare('SELECT max(time_updated) AS updated FROM (SELECT time_updated FROM part WHERE session_id = ? ORDER BY rowid DESC LIMIT 200)').get(id);
        return String(Math.max(Number(messages?.updated) || 0, Number(parts?.updated) || 0));
      }) : '';
      const databaseOffset = cursor ? Number(cursor.upstreamCursor.split(':')[0]) : null;
      const nativePage = record.provider === 'opencode2' ? readOpenCodeV2Page : readOpenCodePage;
      // A turn carrying recorded images serializes larger than a plain text turn, so its
      // read window must cover one whole recorded row or the turn would disappear.
      const pageBytes = recordsTranscriptImages(record.provider) ? CONVERSATION_PAGE_READ_BYTES : 1024 * 1024;
      let result = database ? nativePage(file, id, databaseOffset, Math.min(200, Math.max(1, query.limit ?? 20)), query.direction) : await (older || !cursor ? readOlderTranscriptLines : readBoundedTranscriptLines)(file, cursor ? Number(cursor.upstreamCursor) : stat.size,
        Math.min(200, Math.max(1, query.limit ?? 20)), pageBytes, cursor?.seekingNewline ?? false, line => Boolean(parse(line)));
      if (database && cursor && !older && !result.lines.length && cursor.upstreamCursor.split(':')[1] !== revision) {
        const tail = nativePage(file, id, null, Math.min(20, query.limit ?? 20));
        result = { ...result, lines: tail.lines };
      }
      // Reuse unchanged forward cursors so idle streams do not exhaust the bounded cursor store.
      const offset = !older && !cursor && !isOpenCode(record.provider) ? stat.size : result.nextByteOffset;
      const upstreamCursor = database ? `${offset}:${revision}` : String(offset);
      const nextCursor = older && !result.hasMore ? null : cursor && upstreamCursor === cursor.upstreamCursor && Boolean(result.seekingNewline) === Boolean(cursor.seekingNewline) ? query.cursor! : issueStoredCursor({
        ...expected, upstreamCursor, direction: query.direction, sourceMode: isOpenCode(record.provider) ? 'opencode-db' : agy ? 'antigravity-transcript' : 'coordinator-transcript', seekingNewline: result.seekingNewline,
      });
      const messages = result.lines.flatMap((line, index) => { const message = project(line, result.offsets?.[index]); return message ? [message] : []; });
      const rounds=mergeConversationRounds(this.savedRounds(record),this.nativeRounds(record,file,sourceIdentity,stat));
      const now = new Date().toISOString();
      return { data: { messages, rounds, source: 'transcript', sourceIdentity, ...(['dsh','claude'].includes(record.provider)||record.provider==='codex'&&this.nativeRewindAvailable(record)?{revision:hashId('rev',`${sourceIdentity}:${stat.size}:${stat.mtimeMs}`)}:{}), provider: record.provider, cursor: query.cursor ?? null, nextCursor, limited: result.hasMore || result.limited || record.provider === 'dsh'||Boolean(branch?.limited), truncated: false, warnings: record.provider === 'dsh' ? ['DSH history is a bounded public projection of this Vade-owned session.'] : branch?.limited?['CodeBuddy active history is limited to the bounded native branch window.']:[] },
        meta: { availability: messages.length ? 'ready' : 'empty', observedAt: now, attemptedAt: now, partial: result.hasMore || result.limited, stale: false, issue: null } };
    } catch (error) {
      if (error instanceof CliError) throw error;
      return unavailable('The exact provider transcript cannot be read yet. Use Terminal and retry after a recorded conversation turn.');
    }
  }
}
