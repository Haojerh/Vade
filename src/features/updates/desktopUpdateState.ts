import { useSyncExternalStore } from 'react';
import type { DesktopUpdateStatus } from '../../../shared/contracts';

const browserStatus: DesktopUpdateStatus = { state: 'unsupported', currentVersion: '', latestVersion: null, percent: null, checkedAt: null, message: 'Open the desktop app to check for application updates.' };
let status = browserStatus, revision = 0, connected = false;
const listeners = new Set<() => void>();
function publish(next: DesktopUpdateStatus) { status = next; revision++; for (const listener of listeners) listener(); }
function connect() {
  if (connected || !window.adeDesktop?.updateStatus) return;
  connected = true;
  const desktop = window.adeDesktop;
  const before = revision;
  desktop.onUpdateStatus(publish);
  void desktop.updateStatus().then(next => { if (revision === before) publish(next); }).catch(() => publish({ ...status, state: 'error', message: 'Unable to read desktop update status. Restart Vade and try again.' }));
}
function subscribe(listener: () => void) { listeners.add(listener); connect(); return () => { listeners.delete(listener); }; }
export function useDesktopUpdates() { return useSyncExternalStore(subscribe, () => status, () => browserStatus); }
export async function desktopUpdateAction(action: 'check' | 'update') {
  const desktop = window.adeDesktop;
  if (!desktop?.updateStatus) return;
  const before = revision;
  try { const next = await (action === 'check' ? desktop.checkForUpdates() : desktop.updateAndRestart()); if (revision === before) publish(next); }
  catch { publish({ ...status, state: 'error', message: 'The desktop update action failed. Try again from Installation settings.' }); }
}
export function updateDescription(status: DesktopUpdateStatus) {
  if (status.message) return status.message;
  switch (status.state) {
    case 'checking': return 'Checking GitHub Releases…';
    case 'current': return 'You’re using the latest published version.';
    case 'available': return `Version ${status.latestVersion} is available. Updating restarts the desktop app.`;
    case 'downloading': return `Downloading version ${status.latestVersion}… ${status.percent ?? 0}%`;
    case 'ready': return 'Download verified. Ready to restart and install.';
    case 'installing': return 'Installing the update and restarting Vade…';
    default: return 'Check for desktop application updates.';
  }
}
