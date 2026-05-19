import { create } from 'zustand';

const SIDEBAR_DEFAULT_WIDTH = 240;
const LS_KEY = 'cat-cafe:sidebarWidth';

function readPersistedWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw == null) return SIDEBAR_DEFAULT_WIDTH;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

interface SidebarState {
  isOpen: boolean;
  width: number;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setWidth: (w: number | ((prev: number) => number)) => void;
  resetWidth: () => void;
  handleResize: (delta: number) => void;
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  isOpen: false,
  width: SIDEBAR_DEFAULT_WIDTH,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
  setWidth: (w) => {
    const next = typeof w === 'function' ? w(get().width) : w;
    const clamped = Math.min(400, Math.max(160, next));
    set({ width: clamped });
    try {
      localStorage.setItem(LS_KEY, String(clamped));
    } catch {}
  },
  resetWidth: () => {
    set({ width: SIDEBAR_DEFAULT_WIDTH });
    try {
      localStorage.setItem(LS_KEY, String(SIDEBAR_DEFAULT_WIDTH));
    } catch {}
  },
  handleResize: (delta) => {
    const next = Math.min(400, Math.max(160, get().width + delta));
    set({ width: next });
    try {
      localStorage.setItem(LS_KEY, String(next));
    } catch {}
  },
}));

export function initSidebarWidth() {
  useSidebarStore.setState({ width: readPersistedWidth() });
}
