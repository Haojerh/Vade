export const localTranscriptProviders = ['codex', 'codebuddy', 'claude', 'omp', 'pi', 'opencode', 'opencode2', 'kilocode', 'kilo'];

export function sameTranscriptProvider(a: string, b: string): boolean {
  return a === b || (['kilo', 'kilocode'].includes(a) && ['kilo', 'kilocode'].includes(b));
}

export function stripAnsiCodes(str: string): string {
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

// Only public user/assistant text is projected. Tool output, thinking, and
// provider-injected bookkeeping never become conversation turns.
export function publicTranscriptRecord(line: string, provider: string): any | null {
  if (!localTranscriptProviders.includes(provider)) return null;
  const record = JSON.parse(line);
  if (provider === 'codebuddy') {
    if (record.type !== 'message' || !['user','assistant'].includes(record.role) || record.providerData?.skipRun || record.isMeta || record.isSynthetic) return null;
    return { type: 'response_item', timestamp: record.timestamp, payload: { type: 'message', role: record.role, id: record.id, content: Array.isArray(record.content) ? record.content.filter((p: any) => ['input_text','output_text','text'].includes(p.type) && typeof p.text === 'string') : [] } };
  }
  if (provider === 'codex' || provider === 'opencode' || provider === 'opencode2' || provider === 'kilo' || provider === 'kilocode') return record;
  if (provider === 'claude' && !['user', 'assistant'].includes(record.type)) return null;
  if (['pi', 'omp'].includes(provider) && record.type !== 'message') return null;
  const message = record.message;
  if (record.isApiErrorMessage || message?.model === '<synthetic>') return null;
  if (!message || !['user', 'assistant'].includes(message.role)) return null;
  if (message.role === 'user' && (record.isMeta || record.isSynthetic || record.isCompactSummary)) return null;
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
  if (provider === 'claude' && message.role === 'user') {
    const text = Array.isArray(content) ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim() : '';
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
