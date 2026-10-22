import { useEffect, useState } from 'react';
import { UsagePanel } from '../features/usage/UsagePanel';
import { fetchResources } from '../api/client';
import type { AppResources } from '../../shared/contracts';
import { Icon } from '../components/ui/Icon';

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
  const bytes = resources?.memoryBytes;
  const memory = bytes === undefined ? 'RAM unavailable' : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
  return <footer className="app-statusbar" aria-label="App usage and resources">
    <UsagePanel />
    <span className="statusbar-memory" title={resources?.scope === 'desktop-tree' ? `Vade desktop, backend, terminals and agent descendants (${resources.processCount} processes).` : resources?.scope === 'backend-tree' ? `Vade backend, terminals and agent descendants (${resources.processCount} processes). Browser memory is excluded.` : resources?.scope === 'desktop-app' ? 'Process-tree memory is unavailable. Showing desktop processes only.' : 'Process-tree memory is unavailable. Showing backend memory only.'}>
      <Icon name="memory" size={14} /><span>{memory}</span>
    </span>
  </footer>;
}
