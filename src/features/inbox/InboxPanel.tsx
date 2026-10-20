import React, { useState } from 'react';
import type { InboxItem } from '../../../shared/contracts';
import { Modal } from '../../components/ui/Modal';
import { Icon } from '../../components/ui/Icon';
import { RefreshIcon } from '../../components/ui/RefreshIcon';
import { OverlayCloseButton } from '../../components/ui/OverlayCloseButton';

interface InboxPanelProps {
  isOpen: boolean;
  isClosing: boolean;
  onClose: () => void;
  items: InboxItem[];
  handled: ReadonlySet<string>;
  onHandle: (ids: string[]) => void;
  loading: boolean;
  issue: string | null;
  partial: boolean;
  onRefresh: () => void;
  onOpenAgent: (item: InboxItem) => void;
}

export function InboxPanel(props: InboxPanelProps) {
  const [showHandled, setShowHandled] = useState(false);
  const unread = props.items.filter(item => !props.handled.has(item.id));
  const items = showHandled ? props.items.filter(item => props.handled.has(item.id)) : unread;
  return <Modal isOpen={props.isOpen} isClosing={props.isClosing} onClose={props.onClose} className="inbox-dialog" aria-labelledby="inbox-title">
    <header className="inbox-header">
      <div><h2 id="inbox-title">Inbox</h2><p>Results across your projects</p></div>
      <div className="inbox-actions">
        <button className="btn btn-secondary btn-sm" onClick={props.onRefresh} disabled={props.loading} aria-label="Refresh inbox"><RefreshIcon busy={props.loading} size={15} /></button>
        <OverlayCloseButton onClick={props.onClose} aria-label="Close inbox" />
      </div>
    </header>
    <div className="inbox-toolbar">
      <div className={`inbox-filters ${showHandled ? 'show-handled' : ''}`} role="group" aria-label="Inbox results">
        <span className="inbox-tab-indicator" aria-hidden="true" />
        <button aria-pressed={!showHandled} onClick={() => setShowHandled(false)}>Unread <span className={unread.length ? 'inbox-count' : undefined}>{unread.length}</span></button>
        <button aria-pressed={showHandled} onClick={() => setShowHandled(true)}>Handled</button>
      </div>
      <button className="inbox-handle-all" disabled={!unread.length} onClick={() => props.onHandle(unread.map(item => item.id))}>Mark all handled</button>
    </div>
    {props.issue && <p className="inbox-notice" role="status">{props.issue}</p>}
    <div className="inbox-results" aria-busy={props.loading}>
      {!items.length && <div className="inbox-empty"><Icon name="check" size={24} /><h3>{props.loading ? 'Checking results…' : props.issue ? 'Results unavailable' : showHandled ? 'No handled results' : 'You’re all caught up'}</h3><p>{props.issue ? 'Try refreshing the inbox.' : 'New agent and task results appear here.'}</p></div>}
      <ul>{items.map(item => <li key={item.id} className={`inbox-row result-${item.outcome}`}>
        <button className={`inbox-result ${props.handled.has(item.id) ? 'is-handled' : ''}`} onClick={() => props.onHandle([item.id])} aria-label={`${item.title}, ${item.outcome}, mark handled`}>
          <span className="inbox-unread-dot" aria-hidden="true" />
          <span className="inbox-result-content"><strong title={item.title}>{item.title}</strong><span className="inbox-project"><Icon name="folder" size={12} /><span>{item.projectName}</span><span className="inbox-source">{item.source === 'agent' ? 'Agent result' : 'Task result'}</span></span>
            <span className="inbox-result-footer"><span className={`inbox-outcome outcome-${item.outcome}`}>{item.outcome === 'failed' ? 'Failed' : 'Succeeded'}</span><time dateTime={item.at} title={new Date(item.at).toLocaleString()}>{new Date(item.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></span>
          </span>
        </button>
        <button className="inbox-open-project" disabled={!item.nodeId || props.isClosing} onClick={() => props.onOpenAgent(item)} aria-label={`Open agent details for ${item.title}`} title={item.nodeId ? 'Open agent details' : 'Agent is no longer available'}><Icon name="chevron-right" size={16} /></button>
      </li>)}</ul>
    </div>
  </Modal>;
}
