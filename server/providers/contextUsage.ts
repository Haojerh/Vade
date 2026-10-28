import type { AgentContextUsage } from '../../shared/contracts.js';
import { toIsoOrNull } from './transcriptUtils.js';
import {claudeLocalCommandModel} from './shared.js';

export const tokenCount = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1e12 ? value : null;
const capacity = (value: unknown) => { const count = tokenCount(value); return count && count > 0 ? count : null; };
export function unknownContext(source: string, reason = 'No context measurement has been reported for this session.'): AgentContextUsage {
  return { usedTokens: null, windowTokens: null, observedAt: null, source, measurement: 'last-request', reason };
}

/** Fold native records in source order; never add cumulative session spend. */
export function transcriptContextUsage(provider: string, sessionId: string, lines: string[]): AgentContextUsage {
  let result = unknownContext(provider), model: string | undefined;
  let reportedWindow: { model:string; tokens:number } | undefined;
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.sessionId && row.sessionId !== sessionId || row.isSidechain || row._fromSubAgent || row.isApiErrorMessage || row.isSynthetic) continue;
      if(provider==='claude'&&row.sessionId===sessionId&&row.type==='system'&&row.subtype==='local_command'&&row.commandRun?.command==='model'&&claudeLocalCommandModel(row)&&!/^<local-command-stdout>\s*Kept model\b/i.test(row.content)){
        model=undefined;reportedWindow=undefined;result=unknownContext(provider,'Model changed; waiting for a new context measurement.');continue;
      }
      const nextModel = provider === 'codex' || provider === 'dsh' ? row.type === 'turn_context' ? row.payload?.model : undefined
        : provider === 'codebuddy' ? row.providerData?.model : row.message?.model;
      if (typeof nextModel === 'string' && nextModel.length > 0 && nextModel.length <= 200 && !/[\x00-\x1f\x7f]/.test(nextModel) && nextModel !== '<synthetic>') {
        if (model && model !== nextModel) { result = unknownContext(provider, 'Model changed; waiting for a new context measurement.'); reportedWindow = undefined; }
        model = nextModel;
      }
      if (row.type === 'compacted' || row.type === 'conversation_reset' || row.subtype === 'compact_boundary' || row.providerData?.isSessionSeparator) {
        result = unknownContext(provider, 'Context was reset or compacted; waiting for a new measurement.'); continue;
      }
      if(provider==='claude'&&row.sessionId===sessionId&&row.type==='system'&&row.subtype==='local_command'&&row.commandRun?.command==='context'&&!row.isMeta&&typeof row.content==='string'&&row.content.length<=65536){
        const report=/^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(row.content)?.[1].replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
        if(report&&/^\s*Context Usage\s*$/m.test(report)){
          const lines=report.split(/\r?\n/),index=lines.findIndex(line=>/\d(?:\.\d+)?[kKmM]?\s*\/\s*\d/.test(line));
          const values=index>=0?/([\d.]+[kKmM]?)\s*\/\s*([\d.]+[kKmM]?)\s+tokens\s*\(\d+(?:\.\d+)?%\)/.exec(lines[index]):null;
          const reportedModel=index>0?/([a-zA-Z0-9][a-zA-Z0-9_.:/\[\]-]{0,199})\s*$/.exec(lines[index-1])?.[1]:undefined;
          const parse=(value:string)=>{const match=/^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(value);return match?tokenCount(Math.round(Number(match[1])*({k:1000,m:1000000}[match[2].toLowerCase()]??1))):null;};
          const used=values?parse(values[1]):null,window=values?parse(values[2]):null;
          if(reportedModel&&used!==null&&window&&used<=window){
            // Bind the report to the exact response model observed in this session;
            // configured aliases are not normalized into guessed model identities.
            model??=reportedModel;reportedWindow={model,tokens:window};
            result={usedTokens:used,windowTokens:window,observedAt:toIsoOrNull(row.timestamp),source:'Claude /context report (rounded)',measurement:'reported',estimated:true,reason:'Native context estimate. Capacity is the window reported by /context.'};
          }
        }
      }
      if (provider === 'codebuddy' && row.type === 'message' && row.role === 'user' && row.providerData?.skipRun === true && Array.isArray(row.content)) {
        for (const part of row.content.slice(0,20)) {
          if (!['input_text','text'].includes(part?.type) || typeof part.text !== 'string' || part.text.length > 65536) continue;
          const report = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(part.text)?.[1].replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
          if (!report?.includes('Context Usage')) continue;
          const values = /([a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199})\s*·\s*([\d.]+[kKmM]?)\s*\/\s*([\d.]+[kKmM]?)\s+tokens\s*\(\d+%\)/.exec(report);
          if (!values || model && model !== values[1]) continue;
          const tokens = (value:string) => { const match=/^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(value); return match ? tokenCount(Math.round(Number(match[1])*(match[2].toLowerCase()==='k'?1000:match[2].toLowerCase()==='m'?1000000:1))) : null; };
          const used=tokens(values[2]), window=tokens(values[3]);
          if (used === null || !window) continue;
          model = values[1]; reportedWindow={model,tokens:window};
          result={ usedTokens:used, windowTokens:window, observedAt:toIsoOrNull(row.timestamp), source:'CodeBuddy /context report (rounded)', measurement:'reported', estimated:true };
        }
      }
      if (provider === 'codex') {
        if (row.type !== 'event_msg' || row.payload?.type !== 'token_count') continue;
        const info = row.payload.info;
        // info:null is not a fresh observation and must not erase a real reading.
        if (!info) continue;
        const usage = info.last_token_usage, used = tokenCount(usage?.total_tokens);
        result = { usedTokens: used && used > 0 ? used : null, windowTokens: capacity(info.model_context_window), observedAt: toIsoOrNull(row.timestamp),
          source: 'Codex token_count', measurement: 'reported', cacheAccounting: 'included-in-input',
          ...(tokenCount(usage?.input_tokens) !== null ? { inputTokens: usage.input_tokens } : {}),
          ...(tokenCount(usage?.output_tokens) !== null ? { outputTokens: usage.output_tokens } : {}),
          ...(tokenCount(usage?.cached_input_tokens) !== null ? { cacheReadTokens: usage.cached_input_tokens } : {}) };
      } else if (provider === 'dsh' && row.type === 'context_usage') {
        const value = row.payload;
        result = { usedTokens: tokenCount(value?.usedTokens), windowTokens: capacity(value?.windowTokens), observedAt: toIsoOrNull(row.timestamp), source: 'DSH native channel', measurement: value?.measurement === 'reported' ? 'reported' : 'last-request', ...(value?.estimated === true ? { estimated: true } : {}),
          ...Object.fromEntries(['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].flatMap(key => tokenCount(value?.[key]) !== null ? [[key,value[key]]] : [])) };
      } else if (provider === 'claude' || provider === 'codebuddy') {
        if (provider === 'claude' && (row.type !== 'assistant' || row.message?.role !== 'assistant' || row.message.model === '<synthetic>')) continue;
        if (provider === 'codebuddy' && (row.type !== 'message' || row.role !== 'assistant' || row.providerData?.skipRun)) continue;
        const usage = provider === 'claude' ? row.message?.usage : row.providerData?.usage;
        const input = tokenCount(provider === 'claude' ? usage?.input_tokens : usage?.inputTokens);
        if (input === null) continue;
        const read = tokenCount(provider === 'claude' ? usage?.cache_read_input_tokens : usage?.cacheReadTokens);
        const write = tokenCount(provider === 'claude' ? usage?.cache_creation_input_tokens : usage?.cacheWriteTokens);
        const output = tokenCount(provider === 'claude' ? usage?.output_tokens : usage?.outputTokens);
        // Claude reports uncached input separately; CodeBuddy input includes caches.
        const used = input + (provider === 'claude' ? (read ?? 0) + (write ?? 0) : 0);
        if (used === 0) continue;
        result = { usedTokens: used, windowTokens: capacity(usage.contextWindow ?? usage.model_context_window) ?? (reportedWindow?.model === model ? reportedWindow?.tokens ?? null : null), inputTokens: input, cacheAccounting: provider === 'claude' ? 'separate' : 'included-in-input',
          ...(read !== null ? { cacheReadTokens: read } : {}), ...(write !== null ? { cacheWriteTokens: write } : {}), ...(output !== null ? { outputTokens: output } : {}),
          observedAt: toIsoOrNull(row.timestamp), source: provider === 'claude' ? 'Claude response usage' : 'CodeBuddy response usage', measurement: 'last-request' };
      }
    } catch { /* Malformed native records cannot supply context facts. */ }
  }
  return { ...result, ...(model ? { model } : {}), ...(provider === 'dsh' ? { cacheAccounting: 'separate' as const } : {}) };
}

export function isContextRecord(line: string): boolean {
  try { const row = JSON.parse(line); return ['turn_context','context_usage','compacted','conversation_reset'].includes(row.type)
    || row.type === 'event_msg' && row.payload?.type === 'token_count' || Boolean(row.message?.usage || row.providerData?.usage || row.providerData?.model || row.message?.model || row.providerData?.isSessionSeparator || row.subtype === 'compact_boundary')
    || row.type==='system'&&row.subtype==='local_command'&&['context','model'].includes(row.commandRun?.command)
    || row.providerData?.skipRun === true && Array.isArray(row.content) && row.content.some((part:any) => typeof part?.text === 'string' && part.text.startsWith('<local-command-stdout>') && part.text.includes('Context Usage')); }
  catch { return false; }
}
