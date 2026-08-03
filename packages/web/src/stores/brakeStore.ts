'use client';

import type { BrakeEvent, BrakeMode } from '@cat-cafe/shared';
import { create } from 'zustand';
import { apiFetch } from '@/utils/api-client';

interface BrakeStoreState {
  visible: boolean;
  level: 1 | 2 | 3;
  activeMinutes: number;
  nightMode: boolean;
  /** Submitting check-in */
  submitting: boolean;
  /** True when bypass exhausted (3+ in 4h) — hide continue button */
  bypassDisabled: boolean;

  /** Settings (AC28 + Phase 6) */
  settingsEnabled: boolean;
  settingsThreshold: number;
  settingsMode: BrakeMode;
  settingsLoading: boolean;

  show: (event: Omit<BrakeEvent, 'mode'> & { mode?: BrakeMode }) => void;
  hide: () => void;
  checkin: (choice: 'rest' | 'wrap_up' | 'continue', reason?: string) => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (patch: { enabled?: boolean; thresholdMinutes?: number; mode?: BrakeMode }) => Promise<void>;
}

export const useBrakeStore = create<BrakeStoreState>((set, get) => ({
  visible: false,
  level: 1,
  activeMinutes: 0,
  nightMode: false,
  submitting: false,
  bypassDisabled: false,
  settingsEnabled: false, // Phase 6: default OFF (AC2)
  settingsThreshold: 90,
  settingsMode: 'gentle', // Phase 6: default gentle
  settingsLoading: false,

  show: (event) =>
    set({
      visible: true,
      level: event.level,
      activeMinutes: event.activeMinutes,
      nightMode: event.nightMode,
      // Phase 6: mode travels with the trigger — modal renders correctly even if
      // the settings panel was never opened in this page session.
      // Missing mode (older API without Phase 6) must preserve the legacy
      // hardcore contract — never silently downgrade to one-click dismiss.
      settingsMode: event.mode ?? 'hardcore',
      submitting: false,
      bypassDisabled: false, // Reset on each new trigger
    }),

  hide: () => set({ visible: false, submitting: false, bypassDisabled: false }),

  checkin: async (choice, reason) => {
    set({ submitting: true });
    try {
      const res = await apiFetch('/api/brake/checkin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice, reason }),
      });
      const data = await res.json();
      if (data.bypassDisabled) {
        set({ submitting: false, bypassDisabled: true });
      } else {
        set({ visible: false, submitting: false, bypassDisabled: false });
      }
    } catch {
      set({ submitting: false });
    }
  },

  loadSettings: async () => {
    set({ settingsLoading: true });
    try {
      const res = await apiFetch('/api/brake/settings');
      const data = await res.json();
      set({
        settingsEnabled: data.enabled,
        settingsThreshold: data.thresholdMinutes,
        settingsMode: data.mode ?? 'gentle',
        settingsLoading: false,
      });
    } catch {
      set({ settingsLoading: false });
    }
  },

  saveSettings: async (patch) => {
    const prev = {
      enabled: get().settingsEnabled,
      thresholdMinutes: get().settingsThreshold,
      mode: get().settingsMode,
    };
    // Optimistic update
    if (patch.enabled !== undefined) set({ settingsEnabled: patch.enabled });
    if (patch.thresholdMinutes !== undefined) set({ settingsThreshold: patch.thresholdMinutes });
    if (patch.mode !== undefined) set({ settingsMode: patch.mode });
    try {
      const res = await apiFetch('/api/brake/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json();
      if (data.error) {
        // Revert on validation error
        set({ settingsEnabled: prev.enabled, settingsThreshold: prev.thresholdMinutes, settingsMode: prev.mode });
      }
    } catch {
      set({ settingsEnabled: prev.enabled, settingsThreshold: prev.thresholdMinutes, settingsMode: prev.mode });
    }
  },
}));
