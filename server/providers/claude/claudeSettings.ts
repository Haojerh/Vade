import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Bounded view of the Claude CLI's own configured auto-compact windows. The CLI compares
 *  a session against these thresholds, so they are the capacity its native `/context`
 *  report prints — never a guessed per-model context limit. */
export interface ClaudeAutoCompactWindows {
  byModel: Map<string, number>;
  defaultWindow: number | null;
}

const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_ENTRIES = 500;
const EMPTY: ClaudeAutoCompactWindows = { byModel: new Map(), defaultWindow: null };
let cache: { file: string; stamp: string; value: ClaudeAutoCompactWindows } | null = null;

const windowTokens = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1000 && value <= 10_000_000 ? value : null;

export function claudeSettingsFile(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
}

/** Read the CLI settings file once per observed version; malformed or oversized files
 *  simply leave the auto-compact window unknown. */
export function claudeAutoCompactWindows(file = claudeSettingsFile()): ClaudeAutoCompactWindows {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return EMPTY;
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (cache?.file === file && cache.stamp === stamp) return cache.value;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const settings = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    const byModel = new Map<string, number>();
    const models = settings.modelSettings;
    if (models && typeof models === 'object' && !Array.isArray(models)) {
      for (const [model, value] of Object.entries(models as Record<string, unknown>).slice(0, MAX_MODEL_ENTRIES)) {
        if (model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) continue;
        const tokens = windowTokens(value && typeof value === 'object' ? (value as Record<string, unknown>).autoCompactWindow : null);
        if (tokens) byModel.set(model, tokens);
      }
    }
    const value: ClaudeAutoCompactWindows = { byModel, defaultWindow: windowTokens(settings.autoCompactWindow) };
    cache = { file, stamp, value };
    return value;
  } catch {
    return EMPTY;
  }
}

/** The configured auto-compact window for one observed model, else the CLI default.
 *  Callers pass the windows they read for this observation, so a projection never
 *  implicitly reads the host's settings. */
export function claudeAutoCompactWindow(model: string | undefined, windows?: ClaudeAutoCompactWindows): number | null {
  if (!windows) return null;
  const name = model?.trim();
  if (name && name.length <= 200) {
    const exact = windows.byModel.get(name);
    if (exact) return exact;
  }
  return windows.defaultWindow;
}
