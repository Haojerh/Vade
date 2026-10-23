import { useRef, useState } from 'react';
import type { WorkflowModel } from '../../../shared/contracts';
import { Icon } from '../../components/ui/Icon';
import { Popover } from '../../components/ui/Popover';
import { usePopoverState } from '../../hooks/usePopoverState';

export function WorkflowModelPicker({ models, value, disabled, onChange }: { models: WorkflowModel[]; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const overlay = usePopoverState(), trigger = useRef<HTMLButtonElement>(null);
  const [search, setSearch] = useState('');
  const choices = [{ id: '', label: 'Provider default' }, ...(!value || models.some(model => model.id === value) ? [] : [{ id: value, label: `${value} · unavailable` }]), ...models];
  const filtered = choices.filter(model => `${model.label} ${model.id}`.toLowerCase().includes(search.toLowerCase()));
  const choose = (id: string) => { if (id !== value) onChange(id); overlay.close(); trigger.current?.focus(); };
  return <div className="agent-picker">
    <button ref={trigger} type="button" className="agent-picker-trigger" disabled={disabled} aria-label="Choose model" aria-haspopup="dialog" aria-expanded={overlay.present && !overlay.closing} onClick={() => { setSearch(''); overlay.toggle(); }}>
      <span className="agent-picker-label">{choices.find(model => model.id === value)?.label ?? 'Provider default'}</span><Icon name="chevron-down" size={14} />
    </button>
    <Popover isOpen={overlay.present} isClosing={overlay.closing} onClose={overlay.close} triggerRef={trigger} floating portal className="agent-picker-popover workflow-model-picker" aria-label="Choose model">
      <div className="agent-picker-search"><Icon name="search" size={16} /><input autoFocus aria-label="Search models" placeholder="Search models…" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && filtered[0]) { event.preventDefault(); choose(filtered[0].id); }
        if (event.key === 'ArrowDown') { event.preventDefault(); event.currentTarget.closest('.workflow-model-picker')?.querySelector<HTMLButtonElement>('.workflow-model-option')?.focus(); }
      }} /></div>
      <div className="workflow-model-options" role="group" aria-label="Available models" tabIndex={0} onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        event.preventDefault(); items[next]?.focus();
      }}>
        {filtered.map(model => <button key={model.id} type="button" className="agent-picker-option workflow-model-option" aria-pressed={value === model.id} onClick={() => choose(model.id)}><span className="agent-picker-check">{value === model.id && <Icon name="check" size={14} />}</span><span>{model.label}</span></button>)}
        {!filtered.length && <p className="empty-hint">No matching models.</p>}
      </div>
    </Popover>
  </div>;
}
