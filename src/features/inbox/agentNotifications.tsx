import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { InboxItem, InboxData, Section } from '../../../shared/contracts';
import { Icon } from '../../components/ui/Icon';

const key = 'vade:agent-notifications:v1';
function readSettings(): { enabled: boolean; sound: boolean; system: boolean } {
  try { const value = JSON.parse(localStorage.getItem(key) ?? '{}'); return { enabled: value.enabled !== false, sound: value.sound !== false, system: value.system !== false }; }
  catch { return { enabled: true, sound: true, system: true }; }
}
function useNotificationSettings() {
  const [settings, setSettings] = useState(readSettings);
  useEffect(() => {
    const sync = () => setSettings(readSettings());
    window.addEventListener('vade:notification-settings', sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener('vade:notification-settings', sync); window.removeEventListener('storage', sync); };
  }, []);
  return settings;
}
export function AgentNotificationSettings() {
  const settings = useNotificationSettings();
  const [permission, setPermission] = useState(() => typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const desktop = typeof window !== 'undefined' && Boolean(window.adeDesktop);
  useEffect(() => {
    const refresh = () => setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  function change(patch: Partial<typeof settings>) {
    const next = { ...settings, ...patch };
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Browser storage may be unavailable. */ }
    window.dispatchEvent(new Event('vade:notification-settings'));
  }
  async function toggleSystem(enabled: boolean) {
    if (!enabled || desktop || permission === 'granted') { change({ system: enabled }); return; }
    if (permission !== 'default') return;
    try { const result = await Notification.requestPermission(); setPermission(result); change({ system: result === 'granted' }); }
    catch { setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission); }
  }
  return <>
    <label className="settings-page-row"><div><span className="settings-page-label">Agent finished notifications</span><p>Show a popup when an agent finishes a turn. System notifications appear while Vade is in the background.</p></div><input type="checkbox" role="switch" checked={settings.enabled} onChange={event => change({ enabled: event.target.checked })} /></label>
    <label className="settings-page-row"><div><span className="settings-page-label">Notification sound</span><p>Play a sound with agent completion notifications.</p></div><input type="checkbox" role="switch" checked={settings.sound} disabled={!settings.enabled} onChange={event => change({ sound: event.target.checked })} /></label>
    <label className="settings-page-row"><div><span className="settings-page-label">System notifications</span><p>{desktop ? 'Show system alerts while Vade is in the background.' : permission === 'denied' ? 'Notifications are blocked. Allow them in your browser site settings.' : permission === 'granted' ? settings.system ? 'Browser notifications are enabled.' : 'Browser notifications are disabled for Vade.' : permission === 'unsupported' ? 'System notifications are unavailable in this browser.' : 'Allow browser notifications to receive alerts while Vade is in the background.'}</p></div><input type="checkbox" role="switch" aria-label="System notifications" checked={settings.system && (desktop || permission === 'granted')} disabled={!settings.enabled || (!desktop && (permission === 'denied' || permission === 'unsupported'))} onChange={event => { void toggleSystem(event.target.checked); }} /></label>
  </>;
}

function chime() {
  try {
    const context = new AudioContext();
    if (context.state !== 'running') { void context.close(); return; }
    const tone = context.createOscillator(), gain = context.createGain();
    tone.frequency.value = 880; gain.gain.setValueAtTime(0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.2);
    tone.connect(gain); gain.connect(context.destination); tone.start(); tone.stop(context.currentTime + 0.2);
    tone.onended = () => { void context.close(); };
  } catch { /* Audio can be blocked by browser policy. */ }
}

export function useAgentNotifications(section: Section<InboxData> | null, onOpen: (item: InboxItem) => void) {
  const settings = useNotificationSettings();
  const [popups, setPopups] = useState<InboxItem[]>([]);
  const current = useRef({ settings, onOpen }); current.current = { settings, onOpen };
  const seen = useRef(new Set<string>()), mountedAt = useRef(Date.now());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const browserNotifications = useRef(new Set<Notification>());
  const deliver = useRef((item: InboxItem) => {});
  deliver.current = item => {
    if (seen.current.has(item.id)) return;
    seen.current.add(item.id);
    if (seen.current.size > 2000) seen.current.delete(seen.current.values().next().value!);
    if (!current.current.settings.enabled || item.outcome !== 'completed') return;
    if (document.hidden || !document.hasFocus()) {
      if (current.current.settings.system && !window.adeDesktop && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          const notification = new Notification('Agent finished', { body: `${item.projectName} — ${item.title}`, tag: item.id, silent: !current.current.settings.sound });
          browserNotifications.current.add(notification);
          notification.onclick = () => { window.focus(); current.current.onOpen(item); notification.close(); };
          notification.onclose = () => browserNotifications.current.delete(notification);
        } catch { /* Keep the result available in Inbox if OS delivery fails. */ }
      }
      return;
    }
    setPopups(previous => [...previous, item].slice(-3));
    if (current.current.settings.sound) chime();
    const timer = setTimeout(() => { timers.current.delete(timer); setPopups(previous => previous.filter(value => value.id !== item.id)); }, 10000);
    timers.current.add(timer);
  };
  useEffect(() => {
    void window.adeDesktop?.setNotifications({ enabled: settings.enabled && settings.system, sound: settings.sound }).catch(() => {});
    if (!settings.enabled) setPopups([]);
    if (!settings.enabled || !settings.system) { for (const notification of browserNotifications.current) notification.close(); browserNotifications.current.clear(); }
  }, [settings]);
  useEffect(() => window.adeDesktop?.onAgentNotification(event => {
    if (event.open) current.current.onOpen(event.item);
    else deliver.current(event.item);
  }), []);
  useEffect(() => {
    if (window.adeDesktop || !section?.data || section.meta.stale || !['ready', 'empty'].includes(section.meta.availability)) return;
    for (const item of section.data.items) {
      if (Date.parse(item.at) <= mountedAt.current) { seen.current.add(item.id); continue; }
      if (item.nodeId && item.source === 'turn') deliver.current(item);
    }
  }, [section]);
  useEffect(() => () => { for (const timer of timers.current) clearTimeout(timer); for (const notification of browserNotifications.current) notification.close(); }, []);
  return createPortal(<div className="agent-notifications" aria-live="polite" aria-label="Agent notifications">{popups.map(item => <div className="agent-notification" key={item.id}>
    <Icon name="bell" size={18} /><button className="agent-notification-open" onClick={() => { current.current.onOpen(item); setPopups(previous => previous.filter(value => value.id !== item.id)); }}><strong>Agent finished</strong><span>{item.projectName} · {item.title}</span></button><button className="btn-icon" aria-label={`Dismiss notification for ${item.title}`} onClick={() => setPopups(previous => previous.filter(value => value.id !== item.id))}><Icon name="close" size={14} /></button>
  </div>)}</div>, document.body);
}
