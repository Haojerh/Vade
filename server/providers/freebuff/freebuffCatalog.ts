import type { AgentChatModel, WorkflowModel } from '../../../shared/contracts.js';

/** Freebuff's own model catalog, read from the installed CLI's bundled model list.
 *  Every entry carries the efforts the native picker offers for that model and the
 *  context window the CLI declares for it. IDs and display names are the CLI's own,
 *  so a native picker row and this catalog can be matched without guessing. */
interface FreebuffModelEntry {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort?: string;
  contextWindow?: number;
  description?: string;
}

const EFFORT_LABEL: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

const ENTRIES: FreebuffModelEntry[] = [
  // Optimized
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4.1 Flash 10/17', efforts: ['low', 'high', 'max'], defaultEffort: 'high', contextWindow: 1_048_576, description: 'Smart & Fast' },
  { id: 'mimo/mimo-v2.5', label: 'MiMo v2.6 Flash Fast', efforts: [], contextWindow: 1_000_000, description: 'Balanced' },
  { id: 'meta/muse-spark-1.3-contributor', label: 'Muse Spark 1.3', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', contextWindow: 1_000_000, description: 'Falls back when busy' },
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', efforts: ['low', 'high'], defaultEffort: 'high', contextWindow: 1_000_000, description: 'Deep reasoning' },
  { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', contextWindow: 1_000_000, description: 'Strong all-around' },
  // Powerful
  { id: 'mimo/mimo-v2.6-pro', label: 'MiMo 2.6 Pro', efforts: [], contextWindow: 1_000_000, description: 'Strong reasoning' },
  { id: 'deepseek/deepseek-v4-flash-fast', label: 'DeepSeek V4.1 Flash Fast 10/17', efforts: ['low', 'high', 'max'], defaultEffort: 'high', contextWindow: 1_048_576, description: 'Parallel agents' },
  { id: 'upstage/solar-pro4', label: 'Solar Pro 4', efforts: [], contextWindow: 500_000, description: 'Upstage flagship' },
  { id: 'upstage/solar-mini4', label: 'Solar Mini 4', efforts: [], contextWindow: 500_000, description: 'Fast and light' },
  { id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['high'], defaultEffort: 'high', contextWindow: 1_000_000, description: '1M context' },
  { id: 'google/gemini-4-argon', label: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', contextWindow: 1_000_000, description: 'Google flagship' },
  { id: 'openai/gpt-6.1-terra', label: 'GPT-6.1 Terra', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', contextWindow: 1_000_000, description: 'OpenAI' },
  { id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', contextWindow: 1_000_000, description: 'OpenAI flagship' },
  // Powerful / experimental
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', efforts: ['low', 'high', 'max'], defaultEffort: 'high', contextWindow: 1_000_000, description: 'Deep reasoning' },
  { id: 'minimax/minimax-m3', label: 'MiniMax M3', efforts: [], contextWindow: 524_288, description: 'Fastest' },
  { id: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', contextWindow: 1_000_000, description: 'Strong all-around' },
  { id: 'stealth/ox-alpha', label: 'Ox Alpha', efforts: ['low', 'high', 'max'], defaultEffort: 'high', contextWindow: 1_000_000, description: '1M context' },
  { id: 'stealth/space-bunny-alpha', label: 'Space Bunny Alpha', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', contextWindow: 1_000_000, description: '1M context' },
  { id: 'anthropic/claude-fable-5.1', label: 'Claude Fable 5.1', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', contextWindow: 1_000_000, description: 'Anthropic' },
  { id: 'z-ai/glm-5.2', label: 'GLM 5.2', efforts: [], description: 'Unlock by referring friends' },
];

export const FREEBUFF_MODELS: AgentChatModel[] = ENTRIES.map(entry => ({
  id: entry.id,
  label: entry.label,
  ...(entry.description ? { description: entry.description } : {}),
  ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
  efforts: entry.efforts.map(value => ({ value, label: EFFORT_LABEL[value] ?? value })),
}));

const normalized = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Resolve a native footer or picker label to the catalog row. The CLI's own display
 *  name is authoritative; a version-dated suffix ("10/17") must not break the match. */
export function freebuffModelByLabel(label: string): AgentChatModel | undefined {
  const target = normalized(label);
  if (!target) return undefined;
  return FREEBUFF_MODELS.find(model => normalized(model.label) === target)
    ?? FREEBUFF_MODELS.find(model => normalized(model.label).startsWith(target) || target.startsWith(normalized(model.label)));
}

export function freebuffDefaultEffort(modelId: string): string | undefined {
  return ENTRIES.find(entry => entry.id === modelId)?.defaultEffort;
}

export function freebuffContextWindow(modelId: string): number | undefined {
  return ENTRIES.find(entry => entry.id === modelId)?.contextWindow;
}

/** True when this catalog model exposes the native `/reasoning` picker. */
export function freebuffHasReasoning(modelId: string): boolean {
  return (ENTRIES.find(entry => entry.id === modelId)?.efforts.length ?? 0) > 0;
}

export function freebuffWorkflowModels(): WorkflowModel[] {
  return FREEBUFF_MODELS.map(m => ({
    id: m.id,
    label: m.label,
    efforts: m.efforts.map(e => e.value),
    contextWindow: m.contextWindow ?? 1_000_000,
  }));
}
