'use client';

import { z } from 'zod';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * F293 AC-UX6 — reading posture for the Team surface: what you searched for, which
 * lens you picked, whether the preference editor was open, and where you had scrolled
 * to in the roster. A fold, a host switch or a remount must not throw that away.
 *
 * This is deliberately browser-local rather than an owner store. It carries no routing
 * truth, no capability claim and nothing auditable — losing it costs a scroll, not a
 * fact. Iron rule 5 governs user data that must be recoverable and traceable; a reading
 * posture is neither. Every fact on this surface still comes from the routing read model
 * and the F208 applied revision on each load.
 */

const teamReadingSchema = z.object({
  query: z.string(),
  filter: z.enum(['all', 'attention', 'absent']),
  preferencesOpen: z.boolean(),
  scroll: z.number().nonnegative(),
});

export type TeamReading = z.infer<typeof teamReadingSchema>;

export const DEFAULT_TEAM_READING: TeamReading = {
  query: '',
  filter: 'all',
  preferencesOpen: false,
  scroll: 0,
};

interface TeamReadingStore {
  readings: Record<string, TeamReading>;
  update: (ownerKey: string, change: Partial<TeamReading>) => void;
  reset: () => void;
}

export const useTeamReading = create<TeamReadingStore>()(
  persist(
    (set) => ({
      readings: {},
      update: (ownerKey, change) =>
        set((state) => ({
          readings: {
            ...state.readings,
            [ownerKey]: { ...(state.readings[ownerKey] ?? DEFAULT_TEAM_READING), ...change },
          },
        })),
      reset: () => set({ readings: {} }),
    }),
    {
      name: 'f293-team-reading-v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ readings: state.readings }),
      merge: (persisted, current) => {
        const parsed = z.object({ readings: z.record(z.string(), teamReadingSchema) }).safeParse(persisted);
        return parsed.success ? { ...current, readings: parsed.data.readings } : current;
      },
    },
  ),
);

export function readTeamReading(ownerKey: string): TeamReading {
  return useTeamReading.getState().readings[ownerKey] ?? DEFAULT_TEAM_READING;
}

/** Test seam: drop every stored posture so a case starts from the documented default. */
export function resetTeamReading(): void {
  useTeamReading.getState().reset();
}
