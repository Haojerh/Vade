import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  DEFAULT_VISIBLE_SECTIONS,
  type NodeDetailsVisibleSections,
} from '../features/workflow/NodeDetails';

export function useDashboardLayoutPrefs() {
  // 1. Persistent Theme state
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      const saved = localStorage.getItem('orca-theme');
      if (saved === 'dark' || saved === 'light') return saved;
    } catch {
      // Storage unavailable
    }
    if (
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: light)').matches
    ) {
      return 'light';
    }
    return 'dark';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem('orca-theme', theme);
    } catch {
      // Storage unavailable
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  // 2. Persistent Optional Card State Coloring
  const [cardStateColors, setCardStateColors] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('orca-card-state-colors');
      if (saved !== null) return saved === 'true';
    } catch {
      // Storage unavailable
    }
    return true;
  });

  useEffect(() => {
    try {
      localStorage.setItem('orca-card-state-colors', String(cardStateColors));
    } catch {
      // Storage unavailable
    }
  }, [cardStateColors]);

  // 2b. Persistent Orchestration Separated setting
  const [orchestrationSeparated, setOrchestrationSeparated] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('orca-orchestration-separated');
      if (saved !== null) return saved === 'true';
    } catch {
      // Storage unavailable
    }
    return true;
  });

  useEffect(() => {
    try {
      localStorage.setItem('orca-orchestration-separated', String(orchestrationSeparated));
    } catch {
      // Storage unavailable
    }
  }, [orchestrationSeparated]);

  // 3. Persistent Commit Graph & Node Details visible sections
  const [commitGraphEnabled, setCommitGraphEnabled] = useState(() => {
    try {
      return localStorage.getItem('orca-commit-graph') !== 'false';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('orca-commit-graph', String(commitGraphEnabled));
    } catch {
      // Storage unavailable
    }
  }, [commitGraphEnabled]);

  const [visibleSections, setVisibleSections] = useState<NodeDetailsVisibleSections>(() => {
    try {
      const saved = localStorage.getItem('orca-node-details-visible-sections');
      if (saved) {
        const parsed = JSON.parse(saved);
        return { ...DEFAULT_VISIBLE_SECTIONS, ...parsed };
      }
    } catch {
      // Storage unavailable
    }
    return DEFAULT_VISIBLE_SECTIONS;
  });

  const handleToggleVisibleSection = useCallback((key: keyof NodeDetailsVisibleSections) => {
    setVisibleSections((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem('orca-node-details-visible-sections', JSON.stringify(next));
      } catch {
        // Storage unavailable
      }
      return next;
    });
  }, []);

  const handleResetVisibleSections = useCallback(() => {
    setVisibleSections(DEFAULT_VISIBLE_SECTIONS);
    try {
      localStorage.removeItem('orca-node-details-visible-sections');
    } catch {
      // Storage unavailable
    }
  }, []);

  // 4. Persistent Sidebar visibility & widths
  const [leftSidebarOpen, setLeftSidebarOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('orca-sidebar-left-open');
      if (saved !== null) return saved === 'true';
    } catch {
      // Storage unavailable
    }
    return true;
  });

  const [rightSidebarOpen, setRightSidebarOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('orca-sidebar-right-open');
      if (saved !== null) return saved === 'true';
    } catch {
      // Storage unavailable
    }
    return true;
  });

  const [leftWidth, setLeftWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('orca-sidebar-left-width');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed)) return Math.max(200, Math.min(360, parsed));
      }
    } catch {
      // Storage unavailable
    }
    return 248;
  });

  const [rightWidth, setRightWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('orca-sidebar-right-width');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed)) return Math.max(280, Math.min(520, parsed));
      }
    } catch {
      // Storage unavailable
    }
    return 340;
  });

  // 5. Persistent Bottom Panel (Progress & Activity) State & Resizing
  const [bottomPanelOpen, setBottomPanelOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('orca-bottom-panel-open');
      if (saved !== null) return saved === 'true';
    } catch {
      // Storage unavailable
    }
    return true;
  });

  const [bottomPanelHeight, setBottomPanelHeight] = useState<number>(() => {
    const initialWindowHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
    const initialMax = Math.max(120, Math.min(500, initialWindowHeight - 50 - 8 - 160));
    try {
      const saved = localStorage.getItem('orca-bottom-panel-height');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed)) return Math.max(120, Math.min(initialMax, parsed));
      }
    } catch {
      // Storage unavailable
    }
    return Math.max(120, Math.min(260, initialMax));
  });

  const [isBottomDragging, setIsBottomDragging] = useState<boolean>(false);
  const bottomDragStartRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const persistBottomOpen = useCallback((open: boolean) => {
    setBottomPanelOpen(open);
    try {
      localStorage.setItem('orca-bottom-panel-open', String(open));
    } catch {
      // Storage unavailable
    }
  }, []);

  const persistBottomHeight = useCallback((height: number) => {
    setBottomPanelHeight(height);
    try {
      localStorage.setItem('orca-bottom-panel-height', String(height));
    } catch {
      // Storage unavailable
    }
  }, []);

  const [windowWidth, setWindowWidth] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1200
  );
  const [windowHeight, setWindowHeight] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerHeight : 800
  );

  const topbarRef = useRef<HTMLElement>(null);
  const [topbarHeight, setTopbarHeight] = useState<number>(50);

  useEffect(() => {
    const el = topbarRef.current;
    if (!el) return;
    const updateHeight = () => {
      const rect = el.getBoundingClientRect();
      const height = Math.round(rect.height);
      if (height > 0) {
        setTopbarHeight(height);
      }
    };
    updateHeight();
    const ro = new ResizeObserver(() => {
      updateHeight();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);
      setWindowHeight(window.innerHeight);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const isNarrow = windowWidth <= 900;

  // On narrow screens, enforce one sidebar at a time
  useEffect(() => {
    if (isNarrow && leftSidebarOpen && rightSidebarOpen) {
      setRightSidebarOpen(false);
      try {
        localStorage.setItem('orca-sidebar-right-open', 'false');
      } catch {
        // Storage unavailable
      }
    }
  }, [isNarrow, leftSidebarOpen, rightSidebarOpen]);

  const handleToggleLeft = useCallback((open: boolean) => {
    if (open && window.innerWidth <= 900) {
      setRightSidebarOpen(false);
      try {
        localStorage.setItem('orca-sidebar-right-open', 'false');
      } catch {
        // Storage unavailable
      }
    }
    setLeftSidebarOpen(open);
    try {
      localStorage.setItem('orca-sidebar-left-open', String(open));
    } catch {
      // Storage unavailable
    }
  }, []);

  const handleToggleRight = useCallback((open: boolean) => {
    if (open && window.innerWidth <= 900) {
      setLeftSidebarOpen(false);
      try {
        localStorage.setItem('orca-sidebar-left-open', 'false');
      } catch {
        // Storage unavailable
      }
    }
    setRightSidebarOpen(open);
    try {
      localStorage.setItem('orca-sidebar-right-open', String(open));
    } catch {
      // Storage unavailable
    }
  }, []);

  // Bottom panel vertical dragging & viewport constraint calculation
  const minBottomHeight = 120;
  const minGraphHeight = 160;
  const availableStageHeight = Math.max(minBottomHeight, windowHeight - topbarHeight - 8);
  const maxBottomHeight = Math.max(
    minBottomHeight,
    Math.min(500, availableStageHeight - minGraphHeight)
  );

  // Clamp bottomPanelHeight whenever viewport shrinks or topbar height grows
  useEffect(() => {
    setBottomPanelHeight((curr) => {
      const clamped = Math.max(minBottomHeight, Math.min(maxBottomHeight, curr));
      if (clamped !== curr) {
        persistBottomHeight(clamped);
        return clamped;
      }
      return curr;
    });
  }, [maxBottomHeight, minBottomHeight, persistBottomHeight]);

  const handleBottomPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    bottomDragStartRef.current = { startY: e.clientY, startHeight: bottomPanelHeight };
    setIsBottomDragging(true);
  };

  const handleBottomPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isBottomDragging || !bottomDragStartRef.current) return;
    const deltaY = bottomDragStartRef.current.startY - e.clientY;
    const rawHeight = bottomDragStartRef.current.startHeight + deltaY;
    const nextHeight = Math.max(minBottomHeight, Math.min(maxBottomHeight, rawHeight));
    setBottomPanelHeight(nextHeight);
  };

  const handleBottomPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isBottomDragging) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    setIsBottomDragging(false);
    bottomDragStartRef.current = null;
    persistBottomHeight(bottomPanelHeight);
  };

  const handleBottomKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let delta = 0;
    if (e.key === 'ArrowUp') {
      delta = 20;
    } else if (e.key === 'ArrowDown') {
      delta = -20;
    } else if (e.key === 'Home') {
      e.preventDefault();
      persistBottomHeight(minBottomHeight);
      return;
    } else if (e.key === 'End') {
      e.preventDefault();
      persistBottomHeight(maxBottomHeight);
      return;
    }

    if (delta !== 0) {
      e.preventDefault();
      const nextHeight = Math.max(
        minBottomHeight,
        Math.min(maxBottomHeight, bottomPanelHeight + delta)
      );
      persistBottomHeight(nextHeight);
    }
  };

  const handleToggleBottomExpand = () => {
    if (bottomPanelHeight > 300) {
      persistBottomHeight(Math.max(minBottomHeight, Math.min(220, maxBottomHeight)));
    } else {
      persistBottomHeight(Math.max(minBottomHeight, Math.min(420, maxBottomHeight)));
    }
  };

  const minCenterWidth = 320;
  const maxAvailableForLeft = isNarrow
    ? windowWidth
    : Math.max(200, windowWidth - minCenterWidth - (rightSidebarOpen ? rightWidth : 0));
  const maxAvailableForRight = isNarrow
    ? windowWidth
    : Math.max(280, windowWidth - minCenterWidth - (leftSidebarOpen ? leftWidth : 0));

  return {
    theme,
    toggleTheme,
    cardStateColors,
    setCardStateColors,
    orchestrationSeparated,
    setOrchestrationSeparated,
    commitGraphEnabled,
    setCommitGraphEnabled,
    visibleSections,
    handleToggleVisibleSection,
    handleResetVisibleSections,
    leftSidebarOpen,
    rightSidebarOpen,
    setLeftWidth,
    setRightWidth,
    handleToggleLeft,
    handleToggleRight,
    maxAvailableForLeft,
    maxAvailableForRight,
    topbarRef,
    topbarHeight,
    bottomPanelOpen,
    persistBottomOpen,
    bottomPanelHeight,
    minBottomHeight,
    maxBottomHeight,
    isBottomDragging,
    handleBottomPointerDown,
    handleBottomPointerMove,
    handleBottomPointerUp,
    handleBottomKeyDown,
    handleToggleBottomExpand,
  };
}
