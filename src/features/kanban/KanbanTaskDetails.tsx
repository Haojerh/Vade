import { Modal } from '../../components/ui/Modal';
import { OverlayCloseButton } from '../../components/ui/OverlayCloseButton';
import { Icon } from '../../components/ui/Icon';
import { MessageMarkdown } from '../workflow/MessageMarkdown';
import { AttachmentPreview } from '../workflow/MessageAttachments';
import type { KanbanCard } from './kanban';

export function KanbanTaskDetails({ card, isOpen, isClosing, onClose, onOpenAgent }: {
  card: KanbanCard | null; isOpen: boolean; isClosing: boolean; onClose: () => void; onOpenAgent: (card: KanbanCard) => void;
}) {
  const labels = { todo: 'To-do', pending: 'Pending', completed: 'Completed', failed: 'Failed' };
  return <Modal isOpen={isOpen} isClosing={isClosing} onClose={onClose} className="kanban-task-dialog" aria-labelledby="kanban-task-title">
    <header className="modal-dialog-header"><h2 id="kanban-task-title">{card?.title ?? 'Task unavailable'}</h2><OverlayCloseButton onClick={onClose} aria-label="Close task details" /></header>
    <div className="modal-dialog-body">
      {card ? <>
        <dl className="kanban-task-facts">
          <div><dt>Status</dt><dd><span className={`kanban-task-status kanban-${card.status}`}>{labels[card.status]}</span></dd></div>
          <div><dt>Created</dt><dd><time dateTime={card.createdAt}>{new Date(card.createdAt).toLocaleString()}</time></dd></div>
          <div><dt>Assigned agent</dt><dd>{card.assignment?.label ?? 'Not assigned'}</dd></div>
          {card.assignment && <div><dt>Sent</dt><dd><time dateTime={card.assignment.sentAt}>{new Date(card.assignment.sentAt).toLocaleString()}</time></dd></div>}
        </dl>
        <section className="kanban-task-prompt"><h3>Prompt</h3><div className="message-markdown"><MessageMarkdown text={card.prompt} /></div></section>
        {card.files.length > 0 && <section className="kanban-task-attachments"><h3>Attachments <span className="text-muted">{card.files.length}</span></h3><ul>
          {card.files.map((file, index) => <li key={`${file.name}:${index}`}><AttachmentPreview file={file} /><span><Icon name="paperclip" size={13} />{file.name}</span></li>)}
        </ul></section>}
        {card.error && <p className="panel-alert alert-error" role="alert">{card.error}</p>}
        {card.assignment && <div className="kanban-task-actions"><button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpenAgent(card)}><Icon name="external-link" size={14} />Open agent</button></div>}
      </> : <p className="text-muted">This task has been removed from the board.</p>}
    </div>
  </Modal>;
}
