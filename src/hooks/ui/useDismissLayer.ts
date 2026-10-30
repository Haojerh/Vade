import { useEffect, useRef, type RefObject } from 'react';

const layers: symbol[] = [];

/** Only the topmost open overlay handles outside presses and Escape. */
export function useDismissLayer(open: boolean, ref: RefObject<HTMLElement | null>, onDismiss: () => void, triggerRef?: RefObject<HTMLElement | null>) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!open) return;
    const layer = Symbol();
    layers.push(layer);
    const isTop = () => layers.at(-1) === layer;
    const pointer = (event: PointerEvent) => {
      if (!isTop() || !(event.target instanceof Node)) return;
      if (!ref.current?.contains(event.target) && !triggerRef?.current?.contains(event.target)) dismiss.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !isTop()) return;
      event.preventDefault(); dismiss.current(); triggerRef?.current?.focus();
    };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
    };
  }, [open, ref, triggerRef]);
}
