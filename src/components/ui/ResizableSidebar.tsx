import React, { useState, useEffect, useRef, useCallback } from 'react';

interface ResizableSidebarProps {
  side: 'left' | 'right';
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  maxAvailableWidth?: number;
  onWidthChange?: (width: number) => void;
  storageKey: string;
  isOpen: boolean;
  onToggle: (open: boolean) => void;
  ariaLabel: string;
  children: React.ReactNode;
}

export const ResizableSidebar: React.FC<ResizableSidebarProps> = ({
  side,
  defaultWidth,
  minWidth,
  maxWidth,
  maxAvailableWidth,
  onWidthChange,
  storageKey,
  isOpen,
  onToggle: _onToggle,
  ariaLabel,
  children,
}) => {
  // Load initial width from localStorage safely
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(`${storageKey}-width`);
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed)) {
          return Math.max(minWidth, Math.min(maxWidth, parsed));
        }
      }
    } catch {
      // Storage unavailable fallback
    }
    return defaultWidth;
  });

  const [isDragging, setIsDragging] = useState<boolean>(false);
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Helper to persist width
  const persistWidth = useCallback((newWidth: number) => {
    try {
      localStorage.setItem(`${storageKey}-width`, String(newWidth));
    } catch {
      // Storage unavailable
    }
  }, [storageKey]);

  const getMaxAllowed = useCallback(() => {
    const budget = typeof maxAvailableWidth === 'number' ? maxAvailableWidth : window.innerWidth - 320;
    return Math.max(minWidth, Math.min(maxWidth, budget));
  }, [maxAvailableWidth, minWidth, maxWidth]);

  // Clamp against current window size and combined budget whenever window resizes or budget changes
  useEffect(() => {
    const handleWindowResize = () => {
      const maxAllowed = getMaxAllowed();
      setWidth((curr) => {
        const clamped = Math.max(minWidth, Math.min(maxAllowed, curr));
        if (clamped !== curr) {
          persistWidth(clamped);
          onWidthChange?.(clamped);
        }
        return clamped;
      });
    };

    handleWindowResize();
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [getMaxAllowed, minWidth, persistWidth, onWidthChange]);

  // Pointer drag handling
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // Primary button only
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStartRef.current = { startX: e.clientX, startWidth: width };
    setIsDragging(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !dragStartRef.current) return;
    const deltaX = e.clientX - dragStartRef.current.startX;
    const rawWidth = side === 'left'
      ? dragStartRef.current.startWidth + deltaX
      : dragStartRef.current.startWidth - deltaX;

    const maxAllowed = getMaxAllowed();
    const clamped = Math.max(minWidth, Math.min(maxAllowed, rawWidth));
    setWidth(clamped);
    onWidthChange?.(clamped);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
    setIsDragging(false);
    dragStartRef.current = null;
    persistWidth(width);
    onWidthChange?.(width);
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
    setIsDragging(false);
    dragStartRef.current = null;
  };

  // Keyboard accessibility on separator
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let delta = 0;
    if (e.key === 'ArrowLeft') {
      delta = side === 'left' ? -16 : 16;
    } else if (e.key === 'ArrowRight') {
      delta = side === 'left' ? 16 : -16;
    } else if (e.key === 'Home') {
      e.preventDefault();
      setWidth(minWidth);
      persistWidth(minWidth);
      onWidthChange?.(minWidth);
      return;
    } else if (e.key === 'End') {
      e.preventDefault();
      const maxAllowed = getMaxAllowed();
      setWidth(maxAllowed);
      persistWidth(maxAllowed);
      onWidthChange?.(maxAllowed);
      return;
    }

    if (delta !== 0) {
      e.preventDefault();
      const maxAllowed = getMaxAllowed();
      const nextWidth = Math.max(minWidth, Math.min(maxAllowed, width + delta));
      setWidth(nextWidth);
      persistWidth(nextWidth);
      onWidthChange?.(nextWidth);
    }
  };

  const effectiveWidth = isOpen ? width : 0;

  return (
    <div
      className={`resizable-sidebar sidebar-${side} ${isDragging ? 'is-dragging' : ''} ${
        !isOpen ? 'is-collapsed' : 'is-open'
      }`}
      style={{
        width: `${effectiveWidth}px`,
      }}
      aria-label={ariaLabel}
      aria-hidden={!isOpen}
      inert={!isOpen ? true : undefined}
    >
      <div
        className="sidebar-inner"
        style={{ width: `${width}px`, minWidth: `${width}px` }}
      >
        <div className="sidebar-scrollable-content">
          {children}
        </div>
      </div>

      {/* Resize handle separator (only shown when open) */}
      {isOpen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={Math.round(width)}
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          aria-label={`Resize ${side} sidebar`}
          tabIndex={0}
          className={`sidebar-resizer-handle resizer-${side}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onKeyDown={handleKeyDown}
        >
          <div className="resizer-line" />
        </div>
      )}
    </div>
  );
};
