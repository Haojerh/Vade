import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { ConversationMessage } from '../../../../shared/contracts';
import { Popover } from '../../../components/ui/Popover';
import { Icon } from '../../../components/ui/Icon';
import { useConfirmationState } from '../../../hooks/ui/useConfirmationState';
import { conversationPositions, conversationPositionKey, conversationPositionTicks, conversationViewport, jumpToConversationPosition, type ConversationPosition } from './conversationNavigation';

export function ConversationPositionRail({ messages, historyRef, scrollRef, hasOlder, loadingOlder, onLoadOlder }: {
  messages: ConversationMessage[]; historyRef: RefObject<HTMLDivElement | null>; scrollRef?: RefObject<HTMLDivElement | null>;
  hasOlder: boolean; loadingOlder: boolean; onLoadOlder: () => void;
}) {
  const items = useMemo(() => conversationPositions(messages), [messages]);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [top, setTop] = useState(0);
  const [maxHeight, setMaxHeight] = useState(240);
  const [tickLimit, setTickLimit] = useState(32);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const preview = useConfirmationState<ConversationPosition>();
  const trigger = useRef<HTMLButtonElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const focusRequest = useRef<string | null>(null);
  const ticks = conversationPositionTicks(items, activeId, focusedId, tickLimit);
  const tabId = [focusedId, activeId].find(id => ticks.some(item => item.id === id)) ?? ticks[0]?.id;

  useLayoutEffect(() => {
    const container = scrollRef?.current, history = historyRef.current;
    if (!container || !history) return;
    setHost(container.parentElement);
    let frame = 0;
    const coarsePointer = window.matchMedia?.('(pointer: coarse)');
    const composer = container.querySelector<HTMLElement>('.agent-chatbox-section');
    const update = () => {
      frame = 0;
      const bounds = container.getBoundingClientRect(), parent = container.parentElement?.getBoundingClientRect();
      const viewport = conversationViewport(bounds.top, bounds.bottom, history.getBoundingClientRect().top, composer?.getBoundingClientRect().top);
      if (parent) setTop(viewport.center - parent.top);
      const touch = coarsePointer?.matches === true;
      const rowHeight = touch ? 24 : window.innerHeight <= 500 ? 5 : 9;
      const height = Math.max(24, Math.min(360, viewport.height - 24, window.innerHeight - 24, Math.max(touch ? 120 : 56, viewport.height * .42)));
      setMaxHeight(height);
      setTickLimit(Math.max(4, Math.min(48, Math.floor((height - (hasOlder ? touch ? 24 : 20 : 0)) / rowHeight))));
      const rows = history.querySelectorAll<HTMLElement>('[data-conversation-position]');
      // Find the last prompt at or above the reading line, using current DOM geometry.
      let low = 0, high = rows.length - 1, found = 0;
      const line = viewport.top + Math.min(80, viewport.height * .2);
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (rows[middle].getBoundingClientRect().top <= line) { found = middle; low = middle + 1; }
        else high = middle - 1;
      }
      setActiveId(rows[found]?.dataset.conversationPosition ?? null);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(container); observer?.observe(history);
    if (composer) observer?.observe(composer);
    container.addEventListener('scroll', schedule, { passive: true });
    coarsePointer?.addEventListener('change', schedule);
    window.addEventListener('resize', schedule); update();
    return () => { if (frame) cancelAnimationFrame(frame); observer?.disconnect(); container.removeEventListener('scroll', schedule); coarsePointer?.removeEventListener('change', schedule); window.removeEventListener('resize', schedule); };
  }, [historyRef, scrollRef, items, hasOlder]);

  useLayoutEffect(() => {
    if (!focusRequest.current) return;
    const button = [...(rail.current?.querySelectorAll<HTMLButtonElement>('[data-position-tick]') ?? [])].find(button => button.dataset.positionTick === focusRequest.current);
    if (button) { focusRequest.current = null; button.focus({ preventScroll: true }); }
  }, [ticks]);

  useEffect(() => {
    const container = scrollRef?.current;
    if (!preview.present || !container) return;
    const close = () => preview.close();
    container.addEventListener('scroll', close, { passive: true });
    return () => container.removeEventListener('scroll', close);
  }, [preview.present, preview.close, scrollRef]);

  useEffect(() => {
    const element = rail.current, container = scrollRef?.current;
    if (!element || !container) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      // This overlay is a sibling of the scroll pane. Own the wheel once so the
      // browser cannot also scroll a modal ancestor or the page behind it.
      event.preventDefault();
      container.scrollTop += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [host, scrollRef, items.length === 0]);

  function show(item: ConversationPosition, button: HTMLButtonElement) {
    trigger.current = button;
    preview.open(item);
  }
  function jump(item: ConversationPosition) {
    preview.close();
    const container = scrollRef?.current;
    const row = [...(historyRef.current?.querySelectorAll<HTMLElement>('[data-conversation-position]') ?? [])].find(row => row.dataset.conversationPosition === item.id);
    if (!container || !row) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    jumpToConversationPosition(container, row, Boolean(reduced));
    setActiveId(item.id);
  }

  if (!host || !items.length) return null;
  return createPortal(<>
    <div className="conversation-position-rail" style={{ top, maxHeight }} ref={rail} role="toolbar" aria-label="Your messages in loaded history" aria-orientation="vertical"
      onPointerLeave={() => preview.close()} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setFocusedId(null); preview.close(); } }}
      onKeyDown={event => {
        const index = conversationPositionKey(event.key, items.findIndex(item => item.id === tabId), items.length);
        if (index === null) return;
        event.preventDefault(); const item = items[index]; focusRequest.current = item.id; setFocusedId(item.id);
      }}>
      {hasOlder && <button className="conversation-position-older" type="button" tabIndex={-1} title="Load older messages into the navigator" aria-label="Load older messages into the navigator" disabled={loadingOlder} onClick={onLoadOlder}><Icon name="chevron-up" size={12} /></button>}
      {ticks.map(item => <button key={item.id} type="button" className="conversation-position-tick" data-position-tick={item.id} tabIndex={item.id === tabId ? 0 : -1}
        aria-label={`Jump to your message: ${item.text || 'Attachment'}`} aria-current={item.id === activeId ? 'true' : undefined}
        onPointerEnter={event => { if (event.pointerType !== 'touch') show(item, event.currentTarget); }}
        onFocus={event => { setFocusedId(item.id); if (event.currentTarget.matches(':focus-visible')) show(item, event.currentTarget); }} onClick={() => jump(item)}>
        <span aria-hidden="true" className={item.id === activeId || item.id === preview.data?.id && preview.present && !preview.closing ? 'is-active' : ''} />
      </button>)}
    </div>
    <Popover isOpen={preview.present} isClosing={preview.closing} onClose={preview.close} triggerRef={trigger} floating floatingWidth={280} placement="left" portal className="conversation-position-preview">
      <strong>{preview.data?.text || 'Attachment'}</strong>{preview.data?.reply && <p>{preview.data.reply}</p>}
    </Popover>
  </>, host);
}
