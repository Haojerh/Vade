import type { AgentChatModel, WorkflowModel } from '../../../shared/contracts.js';

/** Freebuff's model catalog.
 *
 *  The live catalog is served by the provider at `GET /api/v1/freebuff/models` and is
 *  per-account: it states which models this connection may actually use, their native
 *  keys, efforts, context windows and picker placement. That response is the source of
 *  truth; `FREEBUFF_BUNDLED_MODELS` is only the offline fallback (the catalog the CLI
 *  itself bundles), and every entry in it is a transcription of that bundled table.
 *
 *  A model ID is the catalog row's `key` (`m-…`), which is what the native picker
 *  stores. Older releases used provider-style IDs (`deepseek/deepseek-v4-flash`); those
 *  remain resolvable through the bundled table so a stored legacy value still maps to
 *  the current row with the same display name. */

interface BundledModel {
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

const BUNDLED: BundledModel[] = [
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4.1 Flash 10/17', efforts: ['low', 'high', 'max'], defaultEffort: 'high', contextWindow: 1_048_576, description: 'Smart & Fast' },
  { id: 'mimo/mimo-v2.5', label: 'MiMo v2.6 Flash Fast', efforts: [], contextWindow: 1_000_000, description: 'Balanced' },
  { id: 'meta/muse-spark-1.3-contributor', label: 'Muse Spark 1.3', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', contextWindow: 1_000_000, description: 'Falls back when busy' },
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', efforts: ['low', 'high'], defaultEffort: 'high', contextWindow: 1_000_000, description: 'Deep reasoning' },
  { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', contextWindow: 1_000_000, description: 'Strong all-around' },
  { id: 'mimo/mimo-v2.6-pro', label: 'MiMo 2.6 Pro', efforts: [], contextWindow: 1_000_000, description: 'Strong reasoning' },
  { id: 'deepseek/deepseek-v4-flash-fast', label: 'DeepSeek V4.1 Flash Fast 10/17', efforts: ['low', 'high', 'max'], defaultEffort: 'high', contextWindow: 1_048_576, description: 'Parallel agents' },
  { id: 'upstage/solar-pro4', label: 'Solar Pro 4', efforts: [], contextWindow: 500_000, description: 'Upstage flagship' },
  { id: 'upstage/solar-mini4', label: 'Solar Mini 4', efforts: [], contextWindow: 500_000, description: 'Fast and light' },
  { id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['high'], defaultEffort: 'high', contextWindow: 1_000_000, description: '1M context' },
  { id: 'google/gemini-4-argon', label: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', contextWindow: 1_000_000, description: 'Google flagship' },
  { id: 'openai/gpt-6.1-terra', label: 'GPT-6.1 Terra', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', contextWindow: 1_000_000, description: 'OpenAI' },
  { id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', contextWindow: 1_000_000, description: 'OpenAI flagship' },
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', efforts: ['low', 'high', 'max'], defaultEffort: 'high', contextWindow: 1_000_000, description: 'Deep reasoning' },
  { id: 'minimax/minimax-m3', label: 'MiniMax M3', efforts: [], contextWindow: 524_288, description: 'Fastest' },
  { id: 'stealth/ox-alpha', label: 'Ox Alpha', efforts: ['low', 'high', 'max'], defaultEffort: 'high', contextWindow: 1_000_000, description: '1M context' },
  { id: 'stealth/space-bunny-alpha', label: 'Space Bunny Alpha', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', contextWindow: 1_000_000, description: '1M context' },
  { id: 'anthropic/claude-fable-5.1', label: 'Claude Fable 5.1', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', contextWindow: 1_000_000, description: 'Anthropic' },
  { id: 'z-ai/glm-5.2', label: 'GLM 5.2', efforts: [], description: 'Unlock by referring friends' },
];

/** The catalog the installed CLI bundles. Used only when the live catalog cannot be
 *  read (offline, signed out, or a rejected request). */
export const FREEBUFF_BUNDLED_MODELS: AgentChatModel[] = BUNDLED.map(entry => ({
  id: entry.id,
  label: entry.label,
  ...(entry.description ? { description: entry.description } : {}),
  ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
  efforts: entry.efforts.map(value => ({ value, label: EFFORT_LABEL[value] ?? value })),
}));

const EFFORTS = new Set(Object.keys(EFFORT_LABEL));
const SECTION_ORDER = ['standard', 'premium', 'powerful'];

const short = (value: unknown, limit: number): string | undefined =>
  typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) || undefined : undefined;

/** Map one live catalog response to the shared model shape. Rows this connection cannot
 *  use (`access: "locked"`, i.e. subscription-only) are omitted: the native picker shows
 *  them as "Paid plan" and refuses them, so offering them in Chat would only fail later. */
export function freebuffModelsFromCatalog(payload: unknown): AgentChatModel[] {
  const rows = Array.isArray((payload as { rows?: unknown })?.rows) ? (payload as { rows: unknown[] }).rows : [];
  const sectionIndex = new Map(SECTION_ORDER.map((id, index) => [id, index]));
  const mapped: { model: AgentChatModel; section: number; order: number }[] = [];
  const seen = new Set<string>();
  for (const raw of rows.slice(0, 200)) {
    const row = raw as Record<string, unknown>;
    const id = short(row?.key, 120);
    const label = short(row?.displayName, 120);
    if (!id || !label || seen.has(id)) continue;
    if (row?.access === 'locked') continue;
    seen.add(id);
    const efforts = Array.isArray(row?.efforts)
      ? row.efforts.filter((value): value is string => typeof value === 'string' && EFFORTS.has(value)).slice(0, 8)
      : [];
    const placement = (row?.placement ?? {}) as Record<string, unknown>;
    const contextWindow = typeof row?.contextWindow === 'number' && Number.isFinite(row.contextWindow) && row.contextWindow > 0
      ? Math.round(row.contextWindow) : undefined;
    mapped.push({
      model: {
        id,
        label,
        ...(short(row?.tagline, 200) ? { description: short(row?.tagline, 200) } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        efforts: efforts.map(value => ({ value, label: EFFORT_LABEL[value] ?? value })),
      },
      section: sectionIndex.get(String(placement.section ?? '')) ?? SECTION_ORDER.length,
      order: typeof placement.order === 'number' && Number.isFinite(placement.order) ? placement.order : Number.MAX_SAFE_INTEGER,
    });
  }
  return mapped
    .sort((a, b) => a.section - b.section || a.order - b.order || a.model.label.localeCompare(b.model.label))
    .map(entry => entry.model);
}

const normalized = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Resolve a native display name to a catalog row. A version-dated suffix ("10/17") or
 *  a shorter label must still match, so equality wins over a prefix comparison. */
export function freebuffModelByLabel(label: string, models: AgentChatModel[] = FREEBUFF_BUNDLED_MODELS): AgentChatModel | undefined {
  const target = normalized(label);
  if (!target) return undefined;
  return models.find(model => normalized(model.label) === target)
    ?? models.find(model => normalized(model.label).startsWith(target) || target.startsWith(normalized(model.label)));
}

/** Match a rendered picker row body (`Display name • effort · tagline · Images`) to a
 *  catalog row. Display names may themselves contain " · ", so the longest match wins. */
export function freebuffModelInRow(body: string, models: AgentChatModel[]): AgentChatModel | undefined {
  const text = body.trim();
  let best: AgentChatModel | undefined;
  for (const model of models) {
    if (text !== model.label && !text.startsWith(`${model.label} ·`) && !text.startsWith(`${model.label} •`)) continue;
    if (!best || model.label.length > best.label.length) best = model;
  }
  return best;
}

/** A stored model may be a live key, a legacy bundled ID, or a display name. */
export function freebuffResolveStored(value: string, models: AgentChatModel[]): AgentChatModel | undefined {
  const direct = models.find(model => model.id === value);
  if (direct) return direct;
  const legacy = BUNDLED.find(entry => entry.id === value);
  return freebuffModelByLabel(legacy?.label ?? value, models);
}

export function freebuffDefaultEffort(modelId: string, models: AgentChatModel[] = FREEBUFF_BUNDLED_MODELS): string | undefined {
  const bundled = BUNDLED.find(entry => entry.id === modelId);
  if (bundled?.defaultEffort) return bundled.defaultEffort;
  const model = models.find(row => row.id === modelId);
  const bundledByLabel = model ? BUNDLED.find(entry => entry.label === model.label) : undefined;
  return bundledByLabel?.defaultEffort;
}

export function freebuffContextWindow(modelId: string, models: AgentChatModel[] = FREEBUFF_BUNDLED_MODELS): number | undefined {
  const model = models.find(row => row.id === modelId);
  if (model?.contextWindow) return model.contextWindow;
  const label = model?.label ?? BUNDLED.find(entry => entry.id === modelId)?.label;
  return label ? BUNDLED.find(entry => entry.label === label)?.contextWindow : undefined;
}

/** True when this catalog model exposes the native `/reasoning` picker. */
export function freebuffHasReasoning(modelId: string, models: AgentChatModel[] = FREEBUFF_BUNDLED_MODELS): boolean {
  return (models.find(row => row.id === modelId)?.efforts.length ?? 0) > 0;
}

export function freebuffWorkflowModels(models: AgentChatModel[] = FREEBUFF_BUNDLED_MODELS): WorkflowModel[] {
  return models.map(model => ({
    id: model.id,
    label: model.label,
    efforts: model.efforts.map(effort => effort.value),
    contextWindow: model.contextWindow ?? 1_000_000,
  }));
}
