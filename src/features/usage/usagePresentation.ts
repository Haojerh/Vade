import type { ProviderUsage, UsageWindow } from '../../../shared/contracts';

export function remainingTime(at: string | null, now = Date.now()): string | null {
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  const minutes = Math.ceil((Date.parse(at) - now) / 60000);
  if (minutes <= 0) return 'Reset due';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
}
export function usageWindows(provider: ProviderUsage): UsageWindow[] { return [...provider.windows, ...provider.buckets]; }
export function resetDescription(at: string | null): string {
  const time = remainingTime(at);
  return time === 'Reset due' ? time : time ? `Resets in ${time}` : 'Reset time unavailable';
}
export function updatedDescription(at: string | null, now = Date.now()): string {
  if (!at || !Number.isFinite(Date.parse(at))) return 'Update time unavailable';
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60000));
  return minutes === 0 ? 'Updated just now' : minutes < 60 ? `Updated ${minutes}m ago` : `Updated ${Math.floor(minutes / 60)}h ago`;
}
export function shortWindow(label: string): string { return ['7d', 'Weekly', 'weekly'].includes(label) ? 'wk' : label.replace(/ \(\d+(?:\.\d+)? \/ \d+(?:\.\d+)? credits\)$/, ''); }
export function primaryWindow(provider: ProviderUsage): UsageWindow | undefined {
  return usageWindows(provider).find(w => /(?:^| )5h$/.test(w.label)) ?? usageWindows(provider)[0];
}
export function detailedWindow(label: string): string { return label.replace(/ weekly$/, ' · Weekly Limit Remaining').replace(/ 5h$/, ' · Five Hour Limit Remaining'); }
export function usageGroups(provider: ProviderUsage): { label: string | null; windows: UsageWindow[] }[] {
  const windows = usageWindows(provider);
  if (provider.provider !== 'antigravity') return [{ label: null, windows }];
  const groups = new Map<string, UsageWindow[]>();
  for (const w of windows) {
    const name = w.label.replace(/ (weekly|5h)$/, '').replace(/^Gemini Models$/, 'Gemini').replace(/^Claude and GPT models$/, 'Claude/GPT');
    groups.set(name, [...(groups.get(name) ?? []), w]);
  }
  return [...groups].map(([label, values]) => ({ label, windows: [...values].sort((a, b) => Number(b.label.endsWith('5h')) - Number(a.label.endsWith('5h'))) }));
}
