import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Traverse the dated rollout layout lazily, preserving newest-directory-first lookup.
function* codexRolloutFiles(directory: string, depth = 0): Generator<string> {
  const names = fs.readdirSync(directory);
  const ordered = depth === 0 ? names.filter((name) => /^\d{4}$/.test(name)).sort().reverse()
    : depth < 3 ? names.sort().reverse() : names;
  for (const name of ordered) {
    const file = path.join(directory, name);
    if (depth === 3) yield file;
    else yield* codexRolloutFiles(file, depth + 1);
  }
}

// Helper to locate Codex session rollout transcript by thread ID or thread name
export function findCodexTranscript(threadIdOrName: string): string | null {
  if (!threadIdOrName || typeof threadIdOrName !== 'string' || !threadIdOrName.trim()) return null;
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sessionsDir = path.join(codexHome, 'sessions');
  const sessionIndex = path.join(codexHome, 'session_index.jsonl');

  const cleanName = threadIdOrName
    .replace(/^✳\s*/, '')
    .replace(/^(?:codex)\s*\|\s*/i, '')
    .split(/\s*\|\s*/)[0]
    .trim();

  let targetId: string | null = null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanName)) {
    targetId = cleanName;
  }

  // 1. Check Orca AI Vault session cache for Codex rollout files
  if (!process.env.CODEX_HOME) {
    const appData = process.env.ORCA_APPDATA_DIR || process.env.APPDATA || '';
    const vaultCachePath = path.join(appData, 'orca', 'ai-vault', 'session-parse-cache.json');
    if (fs.existsSync(vaultCachePath)) {
      try {
        const cache = JSON.parse(fs.readFileSync(vaultCachePath, 'utf-8'));
        if (Array.isArray(cache.entries)) {
          for (const [filePath, data] of cache.entries) {
            const s = data.session;
            if (s && s.agent === 'codex') {
              const sTitle = s.title ? s.title.toLowerCase().trim() : '';
              const cLower = cleanName.toLowerCase();
              if (s.sessionId === cleanName || sTitle === cLower || (sTitle && cLower.includes(sTitle)) || (sTitle && sTitle.includes(cLower))) {
                if (fs.existsSync(filePath)) return filePath;
              }
            }
          }
        }
      } catch {}
    }
  }

  // 2. Check session_index.jsonl
  if (!targetId && fs.existsSync(sessionIndex)) {
    try {
      const lines = fs.readFileSync(sessionIndex, 'utf-8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        const entry = JSON.parse(line);
        if (entry.thread_name) {
          const eName = entry.thread_name.trim().toLowerCase();
          const cName = cleanName.toLowerCase();
          if (eName === cName || cName.includes(eName) || eName.includes(cName)) {
            targetId = entry.id;
            break;
          }
        }
      }
    } catch {}
  }

  if (!targetId || !fs.existsSync(sessionsDir)) return null;

  try {
    for (const file of codexRolloutFiles(sessionsDir)) {
      if (path.basename(file).includes(targetId) && file.endsWith('.jsonl')) return file;
    }
  } catch {}
  return null;
}

// A planner step is only a chat turn when the provider recorded public reply text.
// Thinking-only steps and tool calls are not assistant replies.
export function isCodexChatRecord(line: string): boolean {
  try {
    const record = JSON.parse(line);
    const payload = record.payload;
    if (payload?.role === 'assistant' && payload?.channel === 'analysis') return false;
    if (record.type !== 'response_item' || !['user', 'assistant'].includes(payload?.role)) return false;
    return Array.isArray(payload.content) && payload.content.some((block: any) => {
      if (!['input_text', 'output_text', 'text'].includes(block?.type) || typeof block.text !== 'string') return false;
      const text = block.text.trim();
      return Boolean(text) && !(payload.role === 'user' && /^(<(environment_context|skills_instructions|permissions instructions|collaboration_mode|multi_agent_role|multi_agent_mode|skill)>|# AGENTS\.md instructions)/.test(text));
    });
  } catch {
    return false;
  }
}
