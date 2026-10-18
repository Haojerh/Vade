import { useId, useRef, useState } from 'react';
import type { AgentCatalogEntry } from '../../../shared/contracts';
import { ProviderIcon } from '../providers/ProviderIcon';
import { usePopoverState } from '../../hooks/usePopoverState';
import { Icon } from './Icon';
import { Popover } from './Popover';

export function AgentPicker({ agents, value, onChange, disabled = false, loading = false, error, onRetry, optional = false }: {
  agents: AgentCatalogEntry[]; value: string; onChange: (id: string) => void; disabled?: boolean; loading?: boolean;
  error?: string | null; onRetry: () => void; optional?: boolean;
}) {
  const { present, closing, close, toggle } = usePopoverState();
  const trigger = useRef<HTMLButtonElement>(null);
  const [search, setSearch] = useState('');
  const id = useId();
  const selected = agents.find(agent => agent.id === value);
  const filtered = agents.filter(agent => `${agent.name} ${agent.id}`.toLowerCase().includes(search.toLowerCase()));
  const choose = (id: string) => { onChange(id); close(); trigger.current?.focus(); };
  return <div className="agent-picker">
    <button ref={trigger} type="button" className="agent-picker-trigger" aria-label="Choose agent" aria-haspopup="dialog" aria-controls={present ? id : undefined} aria-expanded={present && !closing} disabled={disabled} onClick={() => { setSearch(''); toggle(); }}>
      {selected ? <ProviderIcon provider={selected.provider} size={18} /> : <Icon name="terminal" size={18} />}
      <span className="agent-picker-label">{selected?.name ?? (loading ? 'Detecting agents…' : optional ? 'Blank Terminal' : 'Select agent')}</span><Icon name="chevron-down" size={14} />
    </button>
    <Popover id={id} isOpen={present} isClosing={closing} onClose={close} triggerRef={trigger} floating className="agent-picker-popover" aria-label="Choose detected agent">
      <div className="agent-picker-search"><Icon name="search" size={16} /><input autoFocus aria-label="Search agents" placeholder="Search agents…" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); if (filtered[0]) choose(filtered[0].id); }
        if (e.key === 'ArrowDown') { e.preventDefault(); e.currentTarget.closest('.agent-picker-popover')?.querySelector<HTMLButtonElement>('.agent-picker-option')?.focus(); }
      }} /></div>
      <div className="agent-picker-options" role="group" aria-label="Detected agents" onKeyDown={e => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        e.preventDefault(); items[next]?.focus();
      }}>
        {optional && (!search || 'blank terminal'.includes(search.toLowerCase())) && <button type="button" className="agent-picker-option" aria-pressed={!value} onClick={() => choose('')}><span className="agent-picker-check">{!value && <Icon name="check" size={14} />}</span><Icon name="terminal" size={18} /><span>Blank Terminal</span></button>}
        {filtered.map(agent => <button key={agent.id} type="button" className="agent-picker-option" aria-pressed={value === agent.id} onClick={() => choose(agent.id)}><span className="agent-picker-check">{value === agent.id && <Icon name="check" size={14} />}</span><ProviderIcon provider={agent.provider} size={18} /><span>{agent.name}</span></button>)}
        {loading && <p className="empty-hint" role="status">Detecting installed agents…</p>}
        {!loading && !error && filtered.length === 0 && <p className="empty-hint">{agents.length ? 'No matching agents.' : 'No installed agents detected.'}</p>}
      </div>
      {error && <div className="panel-alert alert-error" role="alert">{error}<button type="button" className="btn btn-xs btn-secondary" onClick={onRetry} disabled={loading}>Retry</button></div>}
    </Popover>
    {error && !present && <div className="text-xs" role="alert">Agent detection unavailable. <button type="button" className="btn btn-xs btn-secondary" onClick={onRetry} disabled={loading}>Retry</button></div>}
  </div>;
}
