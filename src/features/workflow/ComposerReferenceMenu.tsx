import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { Icon } from '../../components/ui/Icon';
import type { ComposerEntry } from './composerCommands';

interface Props {
  entries: ComposerEntry[];
  activeIndex: number;
  loading?: boolean;
  error?: string | null;
  /** Message for an empty list: `$` providers list skills only. */
  emptyMessage?: string;
  onSelect: (entry: ComposerEntry) => void;
  onHover: (index: number) => void;
}

function entryIcon(entry: ComposerEntry) {
  if (entry.kind === 'skill') return <Icon name="sparkles" size={14} className="composer-reference-icon" />;
  return <Icon name={entry.command === 'context' ? 'gauge' : 'sliders-horizontal'} size={14} className="composer-reference-icon" />;
}

/** Composer reference list. Commands and skills stay in their own labelled groups, and
 *  the active row scrolls into view without moving the page. */
export function ComposerReferenceMenu({ entries, activeIndex, loading, error, emptyMessage, onSelect, onHover }: Props) {
  const list = useRef<HTMLUListElement>(null);
  const container = useRef<HTMLDivElement>(null);
  // The menu floats above the composer, so its height must fit the space that is
  // actually visible above it inside the owning dialog — never the page.
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const clamp = () => {
      const rect = element.getBoundingClientRect();
      const host = element.closest('dialog[open]') ?? document.body;
      const top = Math.max(8, host.getBoundingClientRect().top + 8);
      element.style.maxHeight = `${Math.max(120, Math.min(320, rect.bottom - top - 6))}px`;
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [entries.length]);
  useEffect(() => {
    const active = list.current?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, entries.length]);
  const commands = entries.filter(entry => entry.kind === 'command');
  const skills = entries.filter(entry => entry.kind === 'skill');
  const renderGroup = (label: string, group: ComposerEntry[]) => group.length ? <>
    <li className="composer-reference-group" role="presentation">{label}</li>
    {group.map(entry => {
      const index = entries.indexOf(entry);
      return <li key={entry.key} role="none">
        <button type="button" role="option" id={`composer-reference-${index}`} aria-selected={index === activeIndex}
          data-active={index === activeIndex} className="composer-reference-item" tabIndex={-1}
          onPointerMove={() => onHover(index)} onMouseDown={event => { event.preventDefault(); onSelect(entry); }}>
          {entryIcon(entry)}
          <span className="composer-reference-text">
            <span className="composer-reference-label">{entry.label}</span>
            {entry.description && <span className="composer-reference-description">{entry.description}</span>}
          </span>
          {entry.kind === 'skill' && <span className="composer-reference-scope">Personal</span>}
        </button>
      </li>;
    })}
  </> : null;
  return <div ref={container} className="composer-reference-menu">
    {error ? <p className="composer-reference-message text-danger" role="alert">{error}</p>
      : !entries.length && !loading ? <p className="composer-reference-message">{emptyMessage ?? 'No matching references.'}</p>
        : <ul ref={list} id="composer-reference-list" className="composer-reference-list" role="listbox" aria-label="Composer references">
          {renderGroup('Commands', commands)}
          {renderGroup('Skills', skills)}
          {loading && !skills.length && <li className="composer-reference-message" role="presentation">Loading skills…</li>}
        </ul>}
  </div>;
}
