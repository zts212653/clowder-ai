'use client';

import type { CapabilityTipContext, CapabilityTipSurface } from '@cat-cafe/shared';
import { create } from 'zustand';

export interface FeatureDemoSession {
  demoId: string;
  tipId: string;
  context: CapabilityTipContext;
  surface: CapabilityTipSurface;
}

/** AppShell owns the player so stream completion and tip rotation cannot unmount it. */
export const useFeatureDemoStore = create<{
  session: FeatureDemoSession | null;
  open: (session: FeatureDemoSession) => void;
  close: () => void;
}>((set) => ({
  session: null,
  open: (session) => set({ session }),
  close: () => set({ session: null }),
}));
