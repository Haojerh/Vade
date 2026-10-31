import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentChatOptions,
  AgentContextUsage,
  ConversationMessage,
  ConversationPage,
  ConversationRound,
  ProviderActivity,
  ToolActivity,
} from '../../../shared/contracts.js';
import type { SessionRecord } from '../../runtime/store.js';
import { isPathInsideRoots, toIsoOrNull } from '../common/transcriptUtils.js';
import { toolActivityFromCall } from '../common/toolActivity.js';
import { FREEBUFF_MODELS } from './freebuffCatalog.js';

export const validFreebuffId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:\-T+Z]{0,119}$/.test(id);

export function freebuffConfigDir(): string {
  const custom = process.env.FREEBUFF_CONFIG_DIR;
  if (custom && path.isAbsolute(custom)) return custom;
  return path.join(os.homedir(), '.config', 'manicode');
}

export function freebuffProjectsDir(): string {
  return path.join(freebuffConfigDir(), 'projects');
}

export function freebuffProjectChatsDir(cwd: string): string {
  return path.join(freebuffProjectsDir(), path.basename(cwd), 'chats');
}

export function freebuffChatDir(cwd: string, threadId: string): string {
  return path.join(freebuffProjectChatsDir(cwd), threadId);
}

export function freebuffTranscript(directory: string, record: SessionRecord): { file: string; root: string } {
  const root = freebuffProjectsDir();
  const threadId = record.providerThreadId;
  if (!threadId) throw new Error('Freebuff session has no bound chat ID');
  const chatFolder = freebuffChatDir(record.cwd, threadId);
  const file = path.join(chatFolder, 'chat-messages.json');
  return { file, root };
}

export function freebuffBinding(record: SessionRecord): string | undefined {
  if (record.provider !== 'freebuff') return record.providerThreadId;
  if (record.providerThreadId && validFreebuffId(record.providerThreadId)) {
    return record.providerThreadId;
  }
  const chatsDir = freebuffProjectChatsDir(record.cwd);
  try {
    if (!fs.existsSync(chatsDir)) return undefined;
    const entries = fs.readdirSync(chatsDir, { withFileTypes: true });
    const candidates = entries
      .filter(entry => entry.isDirectory() && validFreebuffId(entry.name))
      .map(entry => {
        const full = path.join(chatsDir, entry.name);
        try {
          return { id: entry.name, mtime: fs.statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((item): item is { id: string; mtime: number } => item !== null)
      .sort((a, b) => b.mtime - a.mtime);

    if (candidates.length > 0) {
      return candidates[0].id;
    }
  } catch {
    // Filesystem read error or unreadable directory
  }
  return undefined;
}

export function freebuffResumable(record: SessionRecord): boolean {
  if (record.provider !== 'freebuff' || !record.providerThreadId) return false;
  const chatFolder = freebuffChatDir(record.cwd, record.providerThreadId);
  return (
    fs.existsSync(path.join(chatFolder, 'chat-messages.json')) ||
    fs.existsSync(path.join(chatFolder, 'log.jsonl')) ||
    fs.existsSync(path.join(chatFolder, 'run-state.json'))
  );
}

export function readFreebuffMessages(file: string): any[] {
  try {
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function readFreebuffModel(file: string, threadId: string): { model?: string; effort?: string } {
  try {
    const chatFolder = path.dirname(file);
    const runStateFile = path.join(chatFolder, 'run-state.json');
    if (fs.existsSync(runStateFile)) {
      const state = JSON.parse(fs.readFileSync(runStateFile, 'utf8'));
      if (typeof state.selectedModel === 'string') {
        const effort = state.reasoningEffortByModel?.[state.selectedModel] ?? undefined;
        return { model: state.selectedModel, effort };
      }
    }
    const settingsFile = path.join(freebuffConfigDir(), 'settings.json');
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      const model = settings.freebuffModelKey ?? settings.freebuffModel ?? settings.freebuffModelDefaultMigration ?? undefined;
      const effort = (model && settings.freebuffCatalogReasoningEfforts?.[model]) ?? undefined;
      if (model) return { model, effort };
    }
  } catch {}
  return { model: 'deepseek/deepseek-v4-flash', effort: 'medium' };
}

export function writeFreebuffModel(cwd: string, threadId: string | undefined, option: { model?: string; effort?: string }): void {
  try {
    const configDir = freebuffConfigDir();
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    const settingsFile = path.join(configDir, 'settings.json');
    let settings: any = {};
    if (fs.existsSync(settingsFile)) {
      try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
    }
    const currentModel = option.model ?? settings.freebuffModelKey ?? settings.freebuffModel ?? 'deepseek/deepseek-v4-flash';
    if (option.model) {
      settings.freebuffModel = option.model;
      settings.freebuffModelKey = option.model;
    }
    if (option.effort) {
      settings.freebuffCatalogReasoningEfforts = {
        ...(settings.freebuffCatalogReasoningEfforts || {}),
        [currentModel]: option.effort,
      };
    }
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

    if (threadId) {
      const chatFolder = freebuffChatDir(cwd, threadId);
      if (fs.existsSync(chatFolder)) {
        const runStateFile = path.join(chatFolder, 'run-state.json');
        let state: any = {};
        if (fs.existsSync(runStateFile)) {
          try { state = JSON.parse(fs.readFileSync(runStateFile, 'utf8')); } catch {}
        }
        if (option.model) state.selectedModel = option.model;
        if (option.effort) {
          state.reasoningEffortByModel = {
            ...(state.reasoningEffortByModel || {}),
            [currentModel]: option.effort,
          };
        }
        fs.writeFileSync(runStateFile, JSON.stringify(state, null, 2));
      }
    }
  } catch {}
}

export function freebuffTools(file: string, threadId: string): ToolActivity[] {
  const messages = readFreebuffMessages(file);
  const activities: ToolActivity[] = [];
  for (const msg of messages) {
    if (msg.variant !== 'ai' || !Array.isArray(msg.blocks)) continue;
    const timestamp = toIsoOrNull(msg.timestamp) ?? new Date().toISOString();
    for (let idx = 0; idx < msg.blocks.length; idx++) {
      const block = msg.blocks[idx];
      if (block?.type !== 'tool' || !block.toolName) continue;
      const id = block.toolCallId ?? `call:${msg.id ?? 'ai'}:${idx}`;
      const item = toolActivityFromCall(threadId, id, block.toolName, block.input, timestamp);
      if (item) activities.push(item);
    }
  }
  return activities;
}

export function freebuffProviderActivities(file: string): ProviderActivity[] {
  const messages = readFreebuffMessages(file);
  const items: ProviderActivity[] = [];
  for (const msg of messages) {
    if (msg.variant !== 'ai' || !Array.isArray(msg.blocks)) continue;
    const timestamp = toIsoOrNull(msg.timestamp);
    for (const block of msg.blocks) {
      if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text.trim()) {
        items.push({
          id: `reasoning:${msg.id ?? 'ai'}`,
          at: timestamp,
          kind: 'reasoning',
          state: 'recorded',
        });
      }
    }
  }
  return items;
}

export function readFreebuffPage(
  file: string,
  threadId: string,
  query: { direction?: 'older' | 'newer'; limit?: number } = {},
): { messages: ConversationMessage[]; tools: ToolActivity[]; activities: ProviderActivity[] } {
  const raw = readFreebuffMessages(file);
  const messages: ConversationMessage[] = [];
  const tools: ToolActivity[] = [];
  const activities: ProviderActivity[] = [];

  for (let idx = 0; idx < raw.length; idx++) {
    const item = raw[idx];
    const timestamp = toIsoOrNull(item.timestamp);
    if (item.variant === 'user') {
      const text = typeof item.content === 'string' ? item.content : '';
      messages.push({
        id: item.id ?? `user-${idx}`,
        role: 'user',
        text,
        at: timestamp,
      });
    } else if (item.variant === 'ai') {
      let text = typeof item.content === 'string' ? item.content : '';
      if (Array.isArray(item.blocks)) {
        for (let bIdx = 0; bIdx < item.blocks.length; bIdx++) {
          const block = item.blocks[bIdx];
          if (block?.type === 'tool' && block.toolName) {
            const toolCallId = block.toolCallId ?? `call:${item.id ?? idx}:${bIdx}`;
            const activity = toolActivityFromCall(threadId, toolCallId, block.toolName, block.input, timestamp ?? new Date().toISOString());
            if (activity) tools.push(activity);
          } else if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text.trim()) {
            activities.push({
              id: `reasoning:${item.id ?? idx}:${bIdx}`,
              at: timestamp,
              kind: 'reasoning',
              state: 'recorded',
            });
          }
        }
      }
      messages.push({
        id: item.id ?? `agent-${idx}`,
        role: 'agent',
        text,
        at: timestamp,
      });
    }
  }

  return { messages, tools, activities };
}

export function freebuffNativeRounds(file: string, threadId: string, source: string): ConversationRound[] {
  const raw = readFreebuffMessages(file);
  const rounds: ConversationRound[] = [];
  let currentPrompt: { id: string; at: string | null } | null = null;
  let responseEnd: string | null = null;

  const flush = () => {
    if (currentPrompt) {
      const started = currentPrompt.at ?? new Date(0).toISOString();
      const ended = responseEnd ?? started;
      const startMs = Date.parse(started) || 0;
      const endMs = Date.parse(ended) || startMs;
      rounds.push({
        id: `round:${currentPrompt.id}`,
        messageIds: [currentPrompt.id],
        startedAt: started,
        endedAt: ended,
        outcome: 'completed',
        workedMs: Math.max(0, endMs - startMs),
        partial: false,
        measurement: 'native-duration',
      });
    }
    currentPrompt = null;
    responseEnd = null;
  };

  for (const item of raw) {
    const timestamp = toIsoOrNull(item.timestamp);
    if (item.variant === 'user') {
      flush();
      currentPrompt = {
        id: item.id ?? `user-${rounds.length}`,
        at: timestamp,
      };
    } else if (item.variant === 'ai' && currentPrompt) {
      responseEnd = timestamp ?? responseEnd;
    }
  }
  flush();
  return rounds;
}

export function freebuffContextUsage(record: SessionRecord): AgentContextUsage {
  const { model } = readFreebuffModel(
    path.join(freebuffChatDir(record.cwd, record.providerThreadId ?? 'default'), 'chat-messages.json'),
    record.providerThreadId ?? '',
  );
  return {
    model: model ?? 'deepseek/deepseek-v4-flash',
    usedTokens: null,
    windowTokens: 1_000_000,
    observedAt: new Date().toISOString(),
    source: 'freebuff',
    measurement: 'last-request',
  };
}
