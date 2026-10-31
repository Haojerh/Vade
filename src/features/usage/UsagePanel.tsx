import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { Popover } from '../../components/ui/Popover';
import type { ProviderUsage, Section, UsageData, UsageWindow } from '../../../shared/contracts';
import { fetchUsage } from '../../api/client';
import { ProviderIcon } from '../../components/providers/ProviderIcon';
import { RefreshIcon } from '../../components/ui/RefreshIcon';
import { Icon } from '../../components/ui/Icon';
import { usePopoverState } from '../../hooks/ui/usePopoverState';
import { useConfirmationState } from '../../hooks/ui/useConfirmationState';
import { OverlayCloseButton } from '../../components/ui/OverlayCloseButton';
import { detailedWindow, primaryWindow, remainingTime, resetDescription, shortWindow, updatedDescription, usageGroups, usageWindows } from './usagePresentation';

function inlineWindowLabel(provider: ProviderUsage, window: UsageWindow): string {
  const label = shortWindow(window.label);
  return provider.provider === 'codebuddy' ? label.replace(/^Plan Base Credits$/i, 'Plan').replace(/^Platform Reward Credits$/i, 'Rewards').replace(/ Credits$/i, '')
    : provider.provider === 'freebuff' ? 'credits'
    : label;
}

function InlineSummary({ provider, compact = false, remaining = false }: { provider: ProviderUsage; compact?: boolean; remaining?: boolean }) {
  return <span className={`usage-inline-summary ${compact ? 'usage-inline-compact' : ''}`}>{usageGroups(provider).map((group, i) => <span className="usage-inline-group" key={group.label ?? i}>
    {i > 0 && <span className="usage-pool-separator" aria-hidden="true">|</span>}
    {group.label && <span className="usage-pool-label">{group.label}</span>}
    <span className="usage-inline-values">{group.windows.map((w, j) => <span className="usage-inline-window" key={j}>
      {j > 0 && <span className="usage-window-separator" aria-hidden="true">·</span>}
      <strong>{Math.round(remaining ? 100 - w.usedPercent : w.usedPercent)}%</strong><span className="usage-inline-meta" title={w.label}>{provider.provider === 'antigravity' ? w.label.endsWith('weekly') ? 'wk' : w.label.endsWith('5h') ? '5h' : '' : compact ? inlineWindowLabel(provider, w) : remainingTime(w.resetsAt) ?? inlineWindowLabel(provider, w)}</span>
    </span>)}</span>
  </span>)}</span>;
}

function Track({ window, wide = false }: { window: UsageWindow; wide?: boolean }) {
  return <span className={`usage-track ${wide ? 'usage-track-wide' : ''} ${window.usedPercent >= 90 ? 'usage-high' : ''}`} role="meter" aria-label={`${window.label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.usedPercent} aria-valuetext={`${window.usedPercent}% used`}><span style={{ width: `${window.usedPercent}%` }} /></span>;
}

export function ProviderUsageDetails({ provider }: { provider: ProviderUsage }) {
  return <><div className="usage-deep-heading"><ProviderIcon provider={provider.provider} size={19} /><strong>{provider.label}</strong></div>
    <p className="usage-note">{provider.meta.stale ? 'Stale · ' : ''}{updatedDescription(provider.meta.observedAt)}</p>
    {usageWindows(provider).map((w, i) => <div className="usage-deep-window" key={i}>
      <strong>{detailedWindow(w.label)}</strong><Track window={w} wide />
      <div className="usage-deep-values"><span>{w.usedPercent}% used</span><span title={w.resetsAt ?? undefined}>{resetDescription(w.resetsAt)}</span></div>
    </div>)}
    {provider.meta.issue && <p className="usage-note">{provider.meta.issue.message}</p>}
  </>;
}

export function UsagePanel() {
  const [section, setSection] = useState<Section<UsageData> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'detailed' | 'compact'>(() => { try { return localStorage.getItem('ade-usage-display') === 'compact' ? 'compact' : 'detailed'; } catch { return 'detailed'; } });
  const detail = useConfirmationState<string>();
  const hovered = detail.closing ? null : detail.data;
  const [detailMotion, setDetailMotion] = useState(true);
  const [detailPosition, setDetailPosition] = useState({ left: 440, top: 100, maxHeight: 600 });
  const detailRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const modeAnimation = useRef<Animation | null>(null);
  const animateMode = useRef(false);
  const [modeMotion, setModeMotion] = useState(true);
  const { present: open, closing, close, toggle } = usePopoverState();
  const [position, setPosition] = useState({ left: 12, bottom: 48, width: 420, maxHeight: 600 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();
  const request = useRef<AbortController | null>(null);
  const requestRefresh=useRef<(force?:boolean)=>void>(()=>{});
  const refresh = useCallback(async (force = false) => {
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    setLoading(true);
    try { const next = await fetchUsage(abort.signal, force); if (!abort.signal.aborted) { setSection(next); setError(null); window.dispatchEvent(new Event('ade:usage-updated')); return Boolean(next.data?.pendingProviders?.length); } }
    catch (err) { if (!abort.signal.aborted) setError(err instanceof Error && err.name==='TimeoutError'?'Usage request timed out. Retry to check again.':err instanceof Error ? err.message : 'Usage is unavailable'); }
    finally { if (!abort.signal.aborted) setLoading(false); }
    return false;
  }, []);
  useEffect(() => {
    let disposed=false,generation=0,timer:ReturnType<typeof setTimeout>|undefined;
    const read=async(force=false)=>{const current=++generation;clearTimeout(timer);if(disposed||document.hidden)return;const pending=await refresh(force);if(!disposed&&current===generation&&!document.hidden)timer=setTimeout(()=>void read(),pending?1000:60000);};
    requestRefresh.current=force=>void read(force);
    void read();
    const accountChanged = () => { setSection(null); detail.reset(); void read(); };
    const visibility=()=>{clearTimeout(timer);generation++;if(document.hidden){request.current?.abort();setLoading(false);}else void read();};
    document.addEventListener('visibilitychange',visibility);
    window.addEventListener('ade:usage-account-change', accountChanged);
    return () => { disposed=true;clearTimeout(timer);request.current?.abort();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('ade:usage-account-change', accountChanged); };
  }, [refresh]);
  useEffect(() => { if (!open) detail.reset(); }, [open, detail.reset]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(420, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      const bottom = Math.max(12, window.innerHeight - rect.top + 8);
      setPosition({ left, bottom, width, maxHeight: Math.max(120, window.innerHeight - bottom - 12) });
    };
    place(); window.addEventListener('resize', place); return () => window.removeEventListener('resize', place);
  }, [open]);
  const available = (section?.data?.providers ?? []).filter(p => usageWindows(p).length);
  const unavailable = (section?.data?.providers ?? []).filter(p => !usageWindows(p).length);
  const selected = available.find(p => detail.present && p.provider === detail.data);
  const showProvider = (id: string, motion: boolean) => { setDetailMotion(motion); detail.open(id); };
  useLayoutEffect(() => {
    if (!selected || detail.closing || !detailRef.current) return;
    const place = () => {
      const row = rowRefs.current.get(selected.provider)?.getBoundingClientRect();
      const menu = popoverRef.current?.getBoundingClientRect();
      const card = detailRef.current;
      if (!row || !menu || !card) return;
      const maxHeight = window.innerHeight - 24;
      const height = Math.min(card.scrollHeight, maxHeight);
      setDetailPosition({ left: menu.right + 360 <= window.innerWidth - 12 ? menu.right : Math.max(12, menu.left - 360), top: Math.max(12, Math.min(row.top - 6, window.innerHeight - height - 12)), maxHeight });
    };
    place();
    const observer = new ResizeObserver(place); observer.observe(detailRef.current);
    const list = listRef.current; list?.addEventListener('scroll', place);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); list?.removeEventListener('scroll', place); window.removeEventListener('resize', place); };
  }, [selected?.provider, detail.closing, mode]);
  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element || !animateMode.current) return;
    animateMode.current = false;
    const opacity = getComputedStyle(element).opacity;
    modeAnimation.current?.cancel();
    modeAnimation.current = element.animate([{ opacity: Math.min(Number(opacity), .55), transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 150, easing: getComputedStyle(element).getPropertyValue('--ease-out').trim() || 'ease-out' });
  }, [mode]);
  useEffect(() => () => modeAnimation.current?.cancel(), []);
  const issue = error || section?.meta.issue?.message;
  const pendingProviders=section?.data?.pendingProviders??[];
  const reading=loading||pendingProviders.length>0;
  const setDisplay = (next: 'detailed' | 'compact', event: MouseEvent) => {
    if (mode === next) return;
    const motion = event.detail !== 0 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    animateMode.current = motion; setModeMotion(motion); setMode(next); detail.close();
    try { localStorage.setItem('ade-usage-display', next); } catch { /* Display still works without storage. */ }
  };
  const refreshButton = <button type="button" className="btn-icon usage-refresh" onClick={() => requestRefresh.current(true)} disabled={loading} aria-busy={reading} aria-label="Refresh provider usage" title="Refresh provider usage"><RefreshIcon busy={reading} size={14} /></button>;
  return <section className="rail-usage" aria-label="Provider usage">
    <div className="usage-status-row">
      <button ref={triggerRef} type="button" className="usage-status-trigger" aria-haspopup="dialog" aria-label="Show usage details" aria-expanded={open && !closing} aria-controls={open ? popoverId : undefined} onClick={toggle}>
        {available.length ? [...available].sort((a, b) => Number(b.provider === 'codex') - Number(a.provider === 'codex')).map(provider => <span key={provider.provider} className="usage-status-provider" title={`${provider.label}${provider.meta.stale ? ' · stale' : ''}`}>
          <ProviderIcon provider={provider.provider} size={16} />{primaryWindow(provider) && <Track window={primaryWindow(provider)!} />}<InlineSummary provider={provider} />{(error || provider.meta.stale) && <span className="usage-stale">*</span>}
        </span>) : <span>{reading ? 'Reading usage…' : 'Usage unavailable'}</span>}
      </button>{refreshButton}
    </div>
    <Popover isOpen={open} isClosing={closing} onClose={close} triggerRef={triggerRef} contentRef={popoverRef} portal focusOnOpen id={popoverId} className="usage-popover usage-menu" aria-label="Usage details" onMouseLeave={detail.close} style={{ left: position.left, bottom: position.bottom, width: position.width, maxHeight: position.maxHeight }}>
      <div className="usage-header"><strong>Usage</strong><span className="usage-header-spacer" />{refreshButton}<OverlayCloseButton aria-label="Close usage details" onClick={close} /></div>
      <div className="usage-display-switch" role="group" aria-label="Usage display" data-mode={mode} data-motion={modeMotion}>
        <span className="usage-display-thumb" aria-hidden="true" />
        <button type="button" aria-pressed={mode === 'detailed'} onClick={event => setDisplay('detailed', event)}>Detailed</button>
        <button type="button" aria-pressed={mode === 'compact'} onClick={event => setDisplay('compact', event)}>Compact</button>
      </div>
      {issue && <p role="status" className="usage-note">{issue}{section?.data ? ' · Showing last known usage.' : ''}</p>}
      {reading && <p role="status" className="usage-note">{pendingProviders.length?`Checking ${pendingProviders.length} provider${pendingProviders.length===1?'':'s'}…`:'Reading provider usage…'}</p>}
      <div className="usage-provider-list" ref={listRef}>
        {available.map(provider => {
          const primary = primaryWindow(provider)!;
          return <button type="button" key={provider.provider} ref={element => { if (element) rowRefs.current.set(provider.provider, element); else rowRefs.current.delete(provider.provider); }} className={`usage-provider-row ${provider.provider !== 'antigravity' ? 'is-simple' : ''} ${hovered === provider.provider ? 'is-hovered' : ''}`} onPointerEnter={event => { if (event.pointerType !== 'touch' && window.matchMedia('(hover: hover) and (pointer: fine)').matches) showProvider(provider.provider, true); }} onFocus={event => { if (event.currentTarget.matches(':focus-visible')) showProvider(provider.provider, false); }} onClick={event => showProvider(provider.provider, event.detail !== 0)} aria-expanded={hovered === provider.provider} aria-label={`${provider.label} quota details`}>
            <div className="usage-provider-heading"><ProviderIcon provider={provider.provider} size={20} /><strong>{provider.label}</strong>{provider.meta.stale && <span className="usage-stale">Stale</span>}<span className="usage-note">{primary.resetsAt ? resetDescription(primary.resetsAt) : ''}</span><Icon name="chevron-right" size={14} /></div>
            <div className={`usage-provider-summary ${mode}`}>
              {mode === 'compact' ? <>{provider.provider !== 'antigravity' && <span className="usage-remaining-label">Remaining</span>}<InlineSummary provider={provider} compact remaining={provider.provider !== 'antigravity'} /></> : usageWindows(provider).map((w, i) => <div className="usage-summary-window" key={i}><span>{provider.provider === 'antigravity' ? detailedWindow(w.label) : shortWindow(w.label)}</span><Track window={w} /><strong>{Math.round(w.usedPercent)}%</strong></div>)}
            </div>
          </button>;
        })}
        {unavailable.map(p => <div className="usage-unavailable-row" key={p.provider}><ProviderIcon provider={p.provider} size={16} /><span>{p.label}</span><span className="usage-note">{pendingProviders.includes(p.provider)?'Checking…':'Unavailable'}</span></div>)}
        {!reading && !available.length && <p className="usage-note">Connect a native provider sign-in in account settings to read quotas.</p>}
      </div>
      <a className="usage-manage-accounts" href="#/settings/accounts" onClick={close}>Manage Accounts…<Icon name="chevron-right" size={14} /></a>
      {selected && <div ref={detailRef} className={`usage-deep-panel ${detail.closing ? 'is-closing' : ''}`} data-motion={detailMotion} role="region" aria-hidden={detail.closing || undefined} aria-label={`${selected.label} detailed usage`} style={{ left: detailPosition.left, top: detailPosition.top, maxHeight: detailPosition.maxHeight }}><div className="usage-deep-card"><ProviderUsageDetails provider={selected} /></div></div>}
    </Popover>
  </section>;
}
