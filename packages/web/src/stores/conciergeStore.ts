'use client';

import type { ConciergeConfig } from '@cat-cafe/shared';
import { CONCIERGE_CONFIG_DEFAULTS, clampBallSize } from '@cat-cafe/shared';
import { create } from 'zustand';
import { apiFetch } from '@/utils/api-client';

/** Legacy capability-tip intents are forwarded to canonical Chat, never rendered as web chrome. */
export type SurfaceState = 'collapsed' | 'toolbar' | 'bubble';
interface ConciergeStoreState extends ConciergeConfig {
  configLoaded: boolean;
  configLoading: boolean;
  configFailed: boolean;
  threadId: string | null;
  threadIdLoaded: boolean;
  threadIdLoading: boolean;
  invocationStatus: 'idle' | 'error';
  surfaceState: SurfaceState;
  inputFocused: boolean;
  pendingPrompt: string | null;
  pendingRelayCount: number;
  fetchConfig: () => Promise<void>;
  readExistingThreadId: () => Promise<void>;
  fetchThreadId: (options?: { refresh?: boolean }) => Promise<string | null>;
  setSurfaceState: (state: SurfaceState, prompt?: string) => void;
  clearPendingPrompt: () => void;
  onNavigationAction: () => void;
  onRelayDispatching: () => void;
  onRelayDispatched: () => void;
  onRelayFailed: () => void;
}

/** Owner configuration and existing rich-card entry intents; no floating-body projection or animation state. */
export const useConciergeStore = create<ConciergeStoreState>((set, get) => ({
  ...CONCIERGE_CONFIG_DEFAULTS,
  dutyCatProfileId: '',
  ballPosition: null,
  configLoaded: false,
  configLoading: false,
  configFailed: false,
  threadId: null,
  threadIdLoaded: false,
  threadIdLoading: false,
  invocationStatus: 'idle',
  surfaceState: 'collapsed',
  inputFocused: false,
  pendingPrompt: null,
  pendingRelayCount: 0,

  fetchConfig: async () => {
    if (get().configLoaded || get().configLoading) return;
    set({ configLoading: true });
    try {
      const response = await apiFetch('/api/concierge/config');
      if (!response.ok) throw new Error(`Config read failed: ${response.status}`);
      const { config }: { config: ConciergeConfig } = await response.json();
      set({
        ...config,
        ballPosition: config.ballPosition ?? null,
        ballSize: clampBallSize(config.ballSize),
        behaviorEnabled: config.behaviorEnabled ?? true,
        configLoaded: true,
        configLoading: false,
      });
    } catch {
      set({ configLoading: false, configFailed: true });
    }
  },

  readExistingThreadId: async () => {
    try {
      const response = await apiFetch('/api/concierge/thread');
      if (!response.ok) return;
      const data: { threadId: string | null } = await response.json();
      // A passive older read cannot erase a carrier resolved by a later explicit open.
      if (typeof data.threadId === 'string' && !get().threadId) set({ threadId: data.threadId, threadIdLoaded: true });
    } catch {
      // The explicit entry can retry through the existing owner-authorized POST.
    }
  },

  fetchThreadId: async (options) => {
    if (get().threadIdLoading) return null;
    if (get().threadIdLoaded && !options?.refresh) return get().threadId;
    set({ threadIdLoading: true });
    try {
      const response = await apiFetch('/api/concierge/thread', { method: 'POST' });
      if (!response.ok) throw new Error(`Carrier resolution failed: ${response.status}`);
      const data: { threadId: string } = await response.json();
      if (typeof data.threadId !== 'string' || !data.threadId) throw new Error('Missing companion carrier');
      set({ threadId: data.threadId, threadIdLoaded: true, threadIdLoading: false, invocationStatus: 'idle' });
      return data.threadId;
    } catch {
      set({ invocationStatus: 'error', threadIdLoading: false });
      return null;
    }
  },

  setSurfaceState: (surfaceState, prompt) => {
    set({ surfaceState });
    if (surfaceState === 'bubble') {
      if (prompt !== undefined) set({ pendingPrompt: prompt });
    } else set({ inputFocused: false, pendingPrompt: null });
  },
  clearPendingPrompt: () => set({ pendingPrompt: null }),
  onNavigationAction: () => set({ surfaceState: 'collapsed', inputFocused: false }),
  onRelayDispatching: () => set((state) => ({ pendingRelayCount: state.pendingRelayCount + 1 })),
  onRelayDispatched: () => set((state) => ({ pendingRelayCount: Math.max(0, state.pendingRelayCount - 1) })),
  onRelayFailed: () => set((state) => ({ pendingRelayCount: Math.max(0, state.pendingRelayCount - 1) })),
}));
