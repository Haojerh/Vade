import React, { useRef, useState } from 'react';
import { Icon } from '../../components/ui/Icon';
import { Modal } from '../../components/ui/Modal';
import { DialogActions, DialogError } from '../../components/ui/DialogActions';
import { ConfirmationDialog } from '../../components/ui/ConfirmationDialog';
import { useConfirmationState } from '../../hooks/useConfirmationState';
import { MessageAttachments } from '../workflow/MessageAttachments';
import { KANBAN_DRAG_TYPE, type CardStatus, type KanbanCard } from './kanban';
import type { useKanban } from './useKanban';
import { OverlayCloseButton } from '../../components/ui/OverlayCloseButton';
import { KanbanTaskDetails } from './KanbanTaskDetails';

export function KanbanBoard({ board, projectId, onClose, onDragStateChange, onOpenAgent }: {
  board: ReturnType<typeof useKanban>; projectId: string | null; onClose: () => void;
  onDragStateChange?: (dragging: boolean) => void;
  onOpenAgent: (card: KanbanCard) => void;
}) {
  const create = useConfirmationState();
  const clear = useConfirmationState();
  const remove = useConfirmationState<KanbanCard>();
  const taskDetails = useConfirmationState<string>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draggingCard = useRef(false);
  const cards = board.cards.filter(card => card.projectId === projectId);
  const columns: { status: CardStatus; label: string }[] = [
    { status: 'todo', label: 'To-do' }, { status: 'pending', label: 'Pending' },
    { status: 'completed', label: 'Completed' }, { status: 'failed', label: 'Failed' },
  ];
  const add = async () => {
    if (!projectId || !title.trim() || !prompt.trim()) return;
    setBusy(true); setError(null);
    try { await board.add(projectId, title.trim(), prompt.trim(), files); create.close(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save task.'); }
    finally { setBusy(false); }
  };
  const openCreate = () => { setTitle(''); setPrompt(''); setFiles([]); setError(null); create.open(); };
  return <section className="kanban-board" aria-label="Project Kanban board">
    <header className="kanban-toolbar">
      <div className="kanban-heading">
        <strong>Kanban <span className="kanban-total-count" aria-label={`${cards.length} tasks`}>{cards.length}</span></strong>
        <span className="kanban-hint text-xs text-muted">Drag To-do or Failed cards onto an agent</span>
      </div>
      <div className="kanban-actions">
        <button className="btn btn-secondary btn-xs" disabled={!projectId || !board.ready} onClick={openCreate}><Icon name="plus" size={12} />Add task</button>
        <button className="btn btn-danger btn-xs" disabled={!cards.length} onClick={() => { setDeleteError(null); clear.open(); }}><Icon name="trash" size={12} />Delete all</button>
        <OverlayCloseButton onClick={onClose} aria-label="Close Kanban board" />
      </div>
    </header>
    {board.error && <div className="kanban-error" role="alert">{board.error}<button className="btn-close" onClick={board.dismissError} aria-label="Dismiss board error"><Icon name="close" size={14} /></button></div>}
    {!board.ready ? <p className="text-muted">Loading board…</p> : !projectId ? <p className="text-muted">Select a project to add tasks.</p> : <div className="kanban-columns">
      {columns.map(column => <section className={`kanban-column kanban-${column.status}`} key={column.status} aria-label={column.label}>
        <header className="kanban-column-header">
          <h3><span className="kanban-status-icon" aria-hidden="true">{column.status === 'completed' ? <Icon name="check" size={11} /> : column.status === 'failed' || column.status === 'pending' ? <Icon name="alert-circle" size={15} /> : null}</span>{column.label}<span className="kanban-column-count">{cards.filter(card => card.status === column.status).length}</span></h3>
          {column.status === 'todo' && <button type="button" className="btn-close kanban-column-add" aria-label="Add To-do task" title="Add To-do task" onClick={openCreate}><Icon name="plus" size={14} /></button>}
        </header>
        <div className="kanban-card-list">
          {cards.filter(card => card.status === column.status).map(card => <article key={card.id} className="kanban-card"
            role="button"
            tabIndex={0}
            aria-label={`View task ${card.title}`}
            onPointerDown={() => { draggingCard.current = false; }}
            onClick={event => {
              if ((event.target as HTMLElement).closest('button') || draggingCard.current) return;
              taskDetails.open(card.id);
            }}
            onKeyDown={event => {
              if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
              event.preventDefault(); taskDetails.open(card.id);
            }}
            draggable={card.status === 'todo' || card.status === 'failed'}
            onDragStart={event => { draggingCard.current = true; event.dataTransfer.setData(KANBAN_DRAG_TYPE, card.id); event.dataTransfer.effectAllowed = 'copy'; requestAnimationFrame(() => onDragStateChange?.(true)); }}
            onDragEnd={() => onDragStateChange?.(false)}>
            <div className="kanban-card-heading"><strong>{card.title}</strong><button type="button" className="btn-close kanban-card-remove" title="Remove task" aria-label={`Remove task ${card.title}`} onClick={() => { setDeleteError(null); remove.open(card); }}><Icon name="close" size={13} /></button></div>
            <p className="kanban-card-prompt" title={card.prompt}>{card.prompt}</p>
            {(card.assignment || card.files.length>0) && <div className="kanban-card-footer">
            {card.files.length>0&&<span className="kanban-card-attachments" title={`${card.files.length} attached ${card.files.length===1?'file':'files'}`}><Icon name="paperclip" size={12}/><span>{card.files.length}</span></span>}
            {card.assignment && <div className="kanban-assignment">
              <span className="kanban-assignment-agent" title={card.assignment.label}><Icon name="terminal" size={13} /><span>{card.assignment.label}</span></span>
              {card.status === 'pending' && <span className="kanban-execution-label">{card.assignment.sawWorking ? 'Executing' : 'Awaiting execution'}</span>}
            </div>}
            </div>}
            {card.error && <p className="kanban-card-error"><Icon name="alert-circle" size={12}/><span>{card.error}</span></p>}
          </article>)}
          {!cards.some(card => card.status === column.status) && <p className="kanban-empty text-xs text-muted">{column.status === 'todo' ? 'Add your next task' : 'No tasks yet'}</p>}
        </div>
      </section>)}
    </div>}
    <KanbanTaskDetails card={cards.find(card => card.id === taskDetails.data) ?? null} isOpen={taskDetails.present} isClosing={taskDetails.closing} onClose={taskDetails.close}
      onOpenAgent={card => { taskDetails.close(); onOpenAgent(card); }} />
    <Modal isOpen={create.present} isClosing={create.closing} busy={busy} onClose={create.close} className="kanban-create-dialog" aria-labelledby="kanban-create-title">
      <header className="modal-dialog-header"><h2 id="kanban-create-title">New task</h2><OverlayCloseButton onClick={create.close} disabled={busy} aria-label="Close new task" /></header>
      <div className="modal-dialog-body">
        <label className="worktree-field">Title<input value={title} onChange={event => setTitle(event.target.value)} placeholder="e.g. Fix mobile navigation layout" maxLength={240} autoFocus disabled={busy} /></label>
        <MessageAttachments files={files} onChange={setFiles} disabled={busy}><label className="worktree-field">Prompt<textarea value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={20000} rows={5} disabled={busy} placeholder="Describe what the agent should implement…" /></label></MessageAttachments>
        <DialogError error={error} />
        <DialogActions onCancel={create.close} onConfirm={add} busy={busy} disabled={!title.trim() || !prompt.trim()} confirmLabel="Add to To-do" busyLabel="Saving…" />
      </div>
    </Modal>
    <ConfirmationDialog isOpen={remove.present} isClosing={remove.closing} title="Remove this task?"
      description={<>Remove <strong>{remove.data?.title}</strong> and its attachments from the board? This does not stop an agent already executing the task.</>}
      confirmLabel="Remove task" confirmVariant="danger" isConfirming={deleting} error={deleteError} onClose={remove.close}
      onConfirm={async () => {
        if (!remove.data || deleting) return;
        setDeleting(true); setDeleteError(null);
        try { await board.remove(remove.data.id); remove.close(); }
        catch { setDeleteError('Could not remove this task. Please retry.'); }
        finally { setDeleting(false); }
      }} />
    <ConfirmationDialog isOpen={clear.present} isClosing={clear.closing} title="Clear this board?" description="Remove every card and its attachments from this project's board. This does not stop agents already executing tasks."
      confirmLabel="Delete all" confirmVariant="danger" isConfirming={deleting} error={deleteError} onClose={clear.close}
      onConfirm={async () => {
        if (!projectId || deleting) return;
        setDeleting(true); setDeleteError(null);
        try { await board.clear(projectId); clear.close(); }
        catch { setDeleteError('Could not clear this board. Please retry.'); }
        finally { setDeleting(false); }
      }} />
  </section>;
}
