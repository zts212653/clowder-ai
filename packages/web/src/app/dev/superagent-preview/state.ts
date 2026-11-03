'use client';

import { create } from 'zustand';

export type PreviewScene = 'uninstalled' | 'setup' | 'active' | 'paused' | 'error';

/** Synthetic, process-local design state. No Host reads, grants or executions. */
export const useSuperagentPreview = create<{
  scene: PreviewScene;
  scope: string[];
  scopeOpen: boolean;
  decision: string;
  feedback: boolean;
  delivered: boolean;
  set: (
    patch: Partial<{
      scene: PreviewScene;
      scope: string[];
      scopeOpen: boolean;
      decision: string;
      feedback: boolean;
      delivered: boolean;
    }>,
  ) => void;
}>((set) => ({
  scene: 'active',
  scope: ['release', 'export'],
  scopeOpen: false,
  decision: '',
  feedback: false,
  delivered: false,
  set,
}));
