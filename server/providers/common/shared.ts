export const localTranscriptProviders = ['codex', 'dsh', 'codebuddy', 'claude', 'omp', 'pi', 'opencode', 'opencode2', 'kilocode', 'kilo'];

export function sameTranscriptProvider(a: string, b: string): boolean {
  return a === b || (['kilo', 'kilocode'].includes(a) && ['kilo', 'kilocode'].includes(b));
}

export function stripAnsiCodes(str: string): string {
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

const claudeInterruptionNotices = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);

/** Exact Claude interruption bookkeeping, never ordinary prose that mentions it. */
export function isClaudeInterruptionNotice(record:any):boolean {
  if (record?.type !== 'user' || record.message?.role !== 'user') return false;
  const content = record.message.content;
  if (Array.isArray(content) && !content.every((block:any)=>block?.type === 'text')) return false;
  const text = typeof content === 'string'
    ? content.trim()
    : Array.isArray(content) ? content.map((block:any)=>block.text).join('\n').trim() : '';
  return claudeInterruptionNotices.has(text);
}

// Only public user/assistant text is projected. Tool output, thinking, and
// provider-injected bookkeeping never become conversation turns.
// `includeSidechain` is set only when reading one recorded child agent's own transcript.
export function publicTranscriptRecord(line: string, provider: string, includeSidechain = false): any | null {
  if (!localTranscriptProviders.includes(provider)) return null;
  const record = JSON.parse(line);
  if(!includeSidechain&&(record.isSidechain||record._fromSubAgent))return null;
  if (provider === 'codebuddy') {
    if (record.type !== 'message' || !['user','assistant'].includes(record.role) || record.providerData?.skipRun || record.isMeta || record.isSynthetic) return null;
    return { type: 'response_item', timestamp: record.timestamp, payload: { type: 'message', role: record.role, id: record.id, content: Array.isArray(record.content) ? record.content.filter((p: any) => ['input_text','output_text','text'].includes(p.type) && typeof p.text === 'string') : [] } };
  }
  if (provider === 'codex' || provider === 'dsh' || provider === 'opencode' || provider === 'opencode2' || provider === 'kilo' || provider === 'kilocode') return record;
  if (provider === 'claude' && !['user', 'assistant'].includes(record.type)) return null;
  if (['pi', 'omp'].includes(provider) && record.type !== 'message') return null;
  const message = record.message;
  if (record.isApiErrorMessage || message?.model === '<synthetic>') return null;
  if (!message || !['user', 'assistant'].includes(message.role)) return null;
  if (message.role === 'user' && (record.isMeta || record.isSynthetic || record.isCompactSummary)) return null;
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
  if (provider === 'claude' && message.role === 'user') {
    const text = Array.isArray(content) ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim() : '';
    if(isClaudeInterruptionNotice(record))return null;
    if (/^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)\b/.test(text)) return null;
  }
  return {
    type: 'response_item',
    timestamp: record.timestamp,
    payload: {
      type: 'message',
      role: message.role,
      id: record.uuid || record.id || message.id,
      content: Array.isArray(content) ? content.filter((b: any) => b.type === 'text' && typeof b.text === 'string') : [],
    },
  };
}

export function transcriptSettings(record: any): { model?: string; effort?: string } {
  const message = record.message;
  if (record.isApiErrorMessage || message?.model === '<synthetic>') return {};
  const model = message?.role === 'assistant' ? message.model : record.type === 'model_change' ? record.modelId : null;
  const effort = record.effort ?? message?.effort ?? record.thinkingLevel;
  return {
    ...(typeof model === 'string' && model.trim() ? { model } : {}),
    ...(typeof effort === 'string' && effort.trim() ? { effort } : {}),
  };
}

/** Native /effort acknowledgements are metadata, never public chat turns. */
export function claudeEffortAcknowledgement(output:string):string|undefined{
  return /^\s*(?:[└⎿│─]\s*)*(?:Set effort level to|Effort level set to)\s+`?(low|medium|high|xhigh|max|auto)`?(?=\s|[.(:]|$)/i.exec(output)?.[1]?.toLowerCase();
}
export function claudeLocalCommandEffort(record: any): string | undefined {
  if(record.isSidechain||record._fromSubAgent||record.isMeta||record.isSynthetic)return undefined;
  const parts = record.type==='system'&&record.subtype==='local_command'&&record.commandRun?.command==='effort'&&typeof record.content==='string'
    ?[{type:'text',text:record.content}]:record.type === 'user' && record.message?.role === 'user' && Array.isArray(record.message.content) ? record.message.content : [];
  for (const part of parts.slice().reverse()) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    const output = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(stripAnsiCodes(part.text).trim())?.[1].trim();
    const effort = output?claudeEffortAcknowledgement(output):undefined;
    if (effort) return effort.toLowerCase();
  }
}

/** Only native local-command acknowledgements establish a /model selection. */
export function claudeLocalCommandModel(record:any):string|undefined {
  if(record.isSidechain||record._fromSubAgent||record.isMeta||record.isSynthetic)return undefined;
  const outputs=record.type==='system'&&record.subtype==='local_command'&&record.commandRun?.command==='model'&&typeof record.content==='string'
    ?[record.content]
    :record.type==='user'&&record.message?.role==='user'&&Array.isArray(record.message.content)
      ?record.message.content.filter((part:any)=>part?.type==='text'&&typeof part.text==='string').map((part:any)=>part.text):[];
  for(const text of outputs){
    const output=/^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(stripAnsiCodes(text).trim())?.[1].trim();
    const match=output?.match(/^(?:Kept model as|Set model to|Model set to)\s+(?:`([^`\r\n]+)`|([^\r\n]+))$/);
    const model=(match?.[1]??match?.[2])?.trim();
    if(model&&model.length<=200&&!/[\x00-\x1f\x7f]/.test(model))return model;
  }
  return undefined;
}
