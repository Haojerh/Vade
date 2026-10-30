import { useLayoutEffect, type RefObject } from 'react';

/** Browser-managed rendering virtualization keeps selection, Find, disclosure
 * state and accessibility intact. Measure real heights before skipping a row;
 * guessed placeholders would move variable-height transcript scroll anchors. */
export function useHistoryRendering(root: RefObject<HTMLElement | null>, enabled: boolean) {
  useLayoutEffect(() => enabled && root.current ? deferHistoryRendering(root.current) : undefined, [root, enabled]);
}

export function deferHistoryRendering(element: HTMLElement): (() => void) | undefined {
    if (typeof ResizeObserver === 'undefined' || typeof CSS === 'undefined' || !CSS.supports('content-visibility', 'auto') || !CSS.supports('contain-intrinsic-block-size', 'auto 1px')) return;
    const rows = new Set<HTMLElement>();
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const row = entry.target as HTMLElement;
        const height = entry.contentRect.height;
        if (height <= 0) continue;
        const size = `auto ${height}px`;
        if (row.style.containIntrinsicBlockSize !== size) row.style.containIntrinsicBlockSize = size;
        if (row.style.contentVisibility !== 'auto') row.style.contentVisibility = 'auto';
      }
    });
    const reconcile = () => {
      const current = new Set(element.querySelectorAll<HTMLElement>('[data-history-row]'));
      for (const row of rows) if (!current.has(row)) { observer.unobserve(row); rows.delete(row); }
      for (const row of current) if (!rows.has(row)) { rows.add(row); observer.observe(row); }
    };
    const mutation = new MutationObserver(reconcile);
    mutation.observe(element, { childList: true, subtree: true }); reconcile();
    return () => { mutation.disconnect(); observer.disconnect(); rows.forEach(row => { row.style.contentVisibility = ''; row.style.containIntrinsicBlockSize = ''; }); };
}
