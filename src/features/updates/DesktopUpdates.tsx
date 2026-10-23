import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../components/ui/Icon';
import { RefreshIcon } from '../../components/ui/RefreshIcon';
import { desktopUpdateAction, updateDescription, useDesktopUpdates } from './desktopUpdateState';

export function DesktopUpdateSettings() {
  const status = useDesktopUpdates();
  const busy = ['checking','downloading','installing'].includes(status.state);
  const canUpdate = Boolean(status.latestVersion) && ['available','ready','error'].includes(status.state);
  return <section className="organization-component desktop-update-settings" aria-label="Desktop app updates">
    <div className="organization-component-heading"><span className="organization-component-icon"><Icon name="download" size={24} /></span><h2>Desktop app</h2>{status.currentVersion && <span className="organization-install-badge">v{status.currentVersion}</span>}</div>
    <p role="status">{updateDescription(status)}</p>
    {status.state === 'downloading' && <progress max={100} value={status.percent ?? 0} aria-label="Update download progress" />}
    <div className="desktop-update-actions"><button type="button" className="btn btn-secondary" disabled={busy || status.state === 'unsupported' || status.state === 'ready'} onClick={() => void desktopUpdateAction('check')}><RefreshIcon busy={status.state === 'checking'} size={14} />Check for updates</button>{canUpdate && <button type="button" className="btn btn-primary" onClick={() => void desktopUpdateAction('update')}><Icon name="download" size={14} />{status.state === 'ready' ? 'Restart & install' : 'Update & restart'}</button>}</div>
    {status.checkedAt && <p className="desktop-update-checked text-xs">Last checked {new Date(status.checkedAt).toLocaleString()}</p>}
  </section>;
}

function readDismissed() { try { return localStorage.getItem('vade:dismissed-desktop-update') ?? ''; } catch { return ''; } }
export function DesktopUpdateNotice() {
  const status = useDesktopUpdates(), [dismissed, setDismissed] = useState(readDismissed);
  const key = `${status.currentVersion}:${status.latestVersion}`;
  const host = useRef<HTMLElement>(null), visible = Boolean(status.latestVersion && status.state !== 'current' && dismissed !== key);
  useLayoutEffect(() => {
    if (!visible || !host.current) return;
    const node = host.current;
    const resize = () => document.documentElement.style.setProperty('--desktop-update-offset', `${Math.ceil(node.getBoundingClientRect().height) + 12}px`);
    const observer = new ResizeObserver(resize); observer.observe(node); resize();
    return () => { observer.disconnect(); document.documentElement.style.removeProperty('--desktop-update-offset'); };
  }, [visible]);
  if (!visible) return null;
  const busy = ['checking','downloading','installing'].includes(status.state);
  const dismiss = () => { setDismissed(key); try { localStorage.setItem('vade:dismissed-desktop-update', key); } catch { /* Dismiss for this app lifetime. */ } };
  return createPortal(<aside ref={host} className="desktop-update-notice" aria-label="Desktop update available" aria-live="polite"><Icon name="download" size={19} /><div><strong>Vade {status.latestVersion} is available</strong><p>{updateDescription(status)}</p>{status.state === 'downloading' && <progress max={100} value={status.percent ?? 0} aria-label="Update download progress" />}<div className="desktop-update-actions"><button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => void desktopUpdateAction('update')}>{busy ? <RefreshIcon busy size={13} /> : <Icon name="download" size={13} />}{status.state === 'installing' ? 'Restarting…' : status.state === 'downloading' ? 'Updating…' : status.state === 'ready' ? 'Restart & install' : 'Update & restart'}</button><button className="btn btn-secondary btn-sm" type="button" onClick={() => { window.location.hash = '#/settings/setup'; }}>Details</button></div></div><button type="button" className="btn-icon" aria-label="Dismiss desktop update notification" onClick={dismiss}><Icon name="close" size={14} /></button></aside>, document.body);
}
