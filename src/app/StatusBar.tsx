import { useEffect, useState } from 'react';
import { UsagePanel } from '../features/usage/UsagePanel';
import { fetchResources } from '../api/client';
import type { AppResources } from '../../shared/contracts';
import { SystemControls } from './SystemControls';

export function StatusBar() {
  const [resources, setResources] = useState<AppResources | null>(null);
  useEffect(() => {
    let closed = false, busy = false;
    const abort = new AbortController();
    const read = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try { const next = await fetchResources(abort.signal); if (!closed) setResources(next); }
      catch { if (!closed) setResources(null); } finally { busy = false; }
    };
    void read();
    const timer = setInterval(() => { void read(); }, 5000);
    document.addEventListener('visibilitychange', read);
    return () => { closed = true; abort.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', read); };
  }, []);
  return <footer className="app-statusbar" aria-label="App usage and resources">
    <UsagePanel />
    <SystemControls resources={resources} />

  </footer>;
}
