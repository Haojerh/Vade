import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Section, UsageData, UsageWindow } from '../../../shared/contracts';
import { fetchUsage } from '../../api/client';
import { ProviderIcon } from '../../components/providers/ProviderIcon';
import { RefreshIcon } from '../../components/ui/RefreshIcon';
import { usePopoverState } from '../../hooks/usePopoverState';

function resetLabel(at: string | null): string | null {
  if (!at) return null;
  const minutes = Math.ceil((Date.parse(at) - Date.now()) / 60000);
  if (minutes <= 0) return 'Reset due';
  if (minutes < 60) return `Resets in ${minutes}m`;
  if (minutes < 1440) return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `Resets in ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
}

function UsageMeter({ window, compact = false }: { window: UsageWindow; compact?: boolean }) {
  const reset = resetLabel(window.resetsAt);
  return (
    <div className={`usage-meter ${compact ? 'usage-meter-compact' : ''}`} title={`${window.label}: ${window.usedPercent}% used${reset ? ` · ${reset}` : ''}`}>
      <span className="usage-window-label">{window.label}</span>
      <span className={`usage-track ${window.usedPercent >= 90 ? 'usage-high' : ''}`}
        role="meter" aria-label={`${window.label} usage`} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={window.usedPercent} aria-valuetext={`${window.usedPercent}% used`}>
        <span style={{ width: `${window.usedPercent}%` }} />
      </span>
      <span className="usage-percent">{window.usedPercent}%</span>
    </div>
  );
}

export function UsagePanel() {
  const [section, setSection] = useState<Section<UsageData> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { present: open, closing, close, toggle } = usePopoverState();
  const [position, setPosition] = useState({ left: 12, bottom: 48, width: 420, maxHeight: 600 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setLoading(true);
    try {
      const next = await fetchUsage(abort.signal);
      if (!abort.signal.aborted) { setSection(next); setError(null); }
    } catch (err) {
      if (!abort.signal.aborted) setError(err instanceof Error ? err.message : 'Usage is unavailable');
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 60000);
    return () => { clearInterval(timer); request.current?.abort(); };
  }, [refresh]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(420, window.innerWidth - 24);
      const bottom = Math.max(12, window.innerHeight - rect.top + 8);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), bottom,
        width, maxHeight: Math.max(120, window.innerHeight - bottom - 12) });
    };
    place();
    popoverRef.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!popoverRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { close(); triggerRef.current?.focus(); }
    };
    window.addEventListener('resize', place);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const providers = section?.data?.providers ?? [];
  const available = providers.filter((p) => p.windows.length || p.buckets.length);
  const unavailable = providers.filter((p) => !p.windows.length && !p.buckets.length);
  const issue = error || section?.meta.issue?.message;
  const stale = Boolean(error || section?.meta.stale);
  const refreshButton = (
    <button type="button" className="btn-icon usage-refresh" onClick={() => { void refresh(); }}
      disabled={loading} aria-busy={loading} aria-label="Refresh usage from Orca" title="Read latest usage from Orca">
      <RefreshIcon busy={loading} />
    </button>
  );
  return (
    <section className="rail-usage" aria-label="Provider usage">
      <div className="usage-status-row">
        <button ref={triggerRef} type="button" className="usage-status-trigger" aria-haspopup="dialog"
          aria-label={`Show usage details${available.map((p) => `, ${p.label} ${Math.max(...[...p.windows, ...p.buckets].map((w) => w.usedPercent))}% used`).join('')}`}
          aria-expanded={open && !closing} aria-controls={open ? popoverId : undefined} onClick={toggle}>
          {available.length ? [...available].sort((a, b) => Number(b.provider === 'codex') - Number(a.provider === 'codex')).map((provider) => (
            <span key={provider.provider} className="usage-status-provider"
              title={`${provider.label}: most used quota${stale || provider.meta.stale ? ' · stale' : ''}`}>
              <ProviderIcon provider={provider.provider} size={15} />
              <span>{Math.max(...[...provider.windows, ...provider.buckets].map((w) => w.usedPercent))}% used</span>
              {(stale || provider.meta.stale) && <span className="usage-stale">*</span>}
            </span>
          )) : <span>{loading ? 'Reading usage…' : 'Usage unavailable'}</span>}
        </button>
        {refreshButton}
      </div>
      {open && createPortal(
      <div ref={popoverRef} id={popoverId} className={`usage-popover ${closing ? 'is-closing' : ''}`} role="dialog" tabIndex={-1}
        aria-label="Usage details" style={{ left: position.left, bottom: position.bottom, width: position.width, maxHeight: position.maxHeight }}>
      <div className="usage-header">
        <span className="font-semibold">Usage</span>
        <span className="usage-display-label">all agents · % used</span>
        {refreshButton}
        <button type="button" className="btn-icon usage-refresh" aria-label="Close usage details"
          onClick={() => { close(); triggerRef.current?.focus(); }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </div>
      {loading && !section && <p className="usage-note" role="status">Reading Orca usage…</p>}
      {issue && <p className="usage-note" role="status">{issue}{section?.data ? ' · Showing last known usage.' : ''}</p>}
      {!loading && !issue && available.length === 0 && <p className="usage-note">No usage reported by Orca.</p>}
      <div className="usage-provider-list">
        {available.map((provider) => {
          const providerStale = stale || provider.meta.stale;
          const reset = resetLabel(provider.windows[0]?.resetsAt ?? provider.buckets[0]?.resetsAt ?? null);
          return (
            <div key={provider.provider} className="usage-provider">
                <div className="usage-provider-heading">
                  <ProviderIcon provider={provider.provider} size={15} />
                  <span className="font-semibold">{provider.label}</span>
                  {providerStale && <span className="usage-stale">Stale</span>}
                  {reset && <span className="usage-note">{reset}</span>}
                </div>
              <div className="usage-provider-details">
                {provider.buckets.map((window, i) => <UsageMeter key={i} window={window} />)}
                <div className="usage-compact-windows">
                  {provider.windows.map((window, i) => <UsageMeter key={i} window={window} compact />)}
                </div>
                {provider.windows.map((window, i) => <p key={i} className="usage-note" title={window.resetsAt ?? undefined}>
                  {window.label}: {resetLabel(window.resetsAt) ?? 'Reset time unavailable'}
                </p>)}
                {provider.meta.observedAt && <p className="usage-note">Updated {new Date(provider.meta.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>}
              </div>
            </div>
          );
        })}
        {unavailable.length > 0 && <details className="usage-unavailable">
          <summary>{unavailable.length} providers unavailable</summary>
          <p className="usage-note">{unavailable.map((p) => p.label).join(', ')}. Check usage in Orca.</p>
        </details>}
      </div>
      <div className="usage-source">From Orca · all projects</div>
      </div>, document.body)}
    </section>
  );
}
