import { Icon } from '../components/ui/Icon';
import { RefreshIcon } from '../components/ui/RefreshIcon';

export function DashboardActions({ kanbanOpen, onToggleKanban, onOpenInbox, unread, refreshing, onRefresh }: {
  kanbanOpen: boolean; onToggleKanban: () => void; onOpenInbox: () => void;
  unread: number; refreshing: boolean; onRefresh: () => void;
}) {
  return <>
    <button type="button" className="btn-icon" onClick={onRefresh} disabled={refreshing} aria-label="Refresh all data" title="Refresh all data"><RefreshIcon busy={refreshing} size={15} /></button>
    <span className="rail-footer-spacer" />
    <button type="button" className="btn-icon" onClick={onToggleKanban} aria-expanded={kanbanOpen} aria-haspopup="dialog" aria-label="Toggle Kanban board" title="Kanban board"><Icon name="layers" size={15} /></button>
    <button type="button" className="btn-icon inbox-trigger" onClick={onOpenInbox} aria-label={`Open inbox, ${unread} unread results`} title="Inbox"><Icon name="bell" size={15} />{unread > 0 && <span className="inbox-count">{unread}</span>}</button>
  </>;
}
