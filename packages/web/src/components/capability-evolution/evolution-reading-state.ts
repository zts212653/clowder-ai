'use client';

import {
  type ExactAssetVersionRefV1,
  evolutionPreparationSectionSchema,
  exactAssetVersionRefV1Schema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  clearExplorationSelection,
  DEFAULT_EXPLORATION,
  explorationReadingSchema,
} from './exploration/exploration-reading';

const readingSchema = z.object({
  selectedVersionRef: exactAssetVersionRefV1Schema.optional(),
  exploration: explorationReadingSchema.optional(),
  preparationSection: evolutionPreparationSectionSchema.optional(),
  preparationOpenDetails: z.array(z.string().min(1).max(512)).max(128).optional(),
  preparationReturn: z
    .object({
      criterionId: z.string().min(1).max(120),
      revision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    })
    .optional(),
  preparationGtSourceKey: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._-]*$/)
    .optional(),
  journeyMoment: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  view: z.enum(['judgment', 'history']),
  scroll: z.object({
    detail: z.number().nonnegative(),
    judgment: z.number().nonnegative(),
    history: z.number().nonnegative(),
  }),
});
export type EvolutionReading = z.infer<typeof readingSchema>;
export type EvolutionReadingView = EvolutionReading['view'];
export const DEFAULT_READING: EvolutionReading = { view: 'judgment', scroll: { detail: 0, judgment: 0, history: 0 } };

const persistedObject = z.record(z.string(), z.unknown());
/** Reading fields are independent; a damaged viewport must not invalidate a valid draft and its binding. */
function recoverFields(
  shape: Record<string, z.ZodType<unknown>>,
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(shape).flatMap(([key, schema]) => {
      const result = schema.safeParse(value[key]);
      return result.success && result.data !== undefined ? [[key, result.data]] : [];
    }),
  );
}
function recoverProgramReading(value: unknown): EvolutionReading | undefined {
  const object = persistedObject.safeParse(value);
  if (!object.success) return undefined;
  const fields = recoverFields(readingSchema.shape, object.data);
  const exploration = persistedObject.safeParse(object.data.exploration);
  // Draft text and its binding form one intent; an invalid binding must never be replaced by the current selection.
  if (exploration.success)
    fields.exploration = explorationReadingSchema.parse({
      ...DEFAULT_EXPLORATION,
      ...recoverFields(explorationReadingSchema.shape, exploration.data),
    });
  return readingSchema.parse({ ...DEFAULT_READING, ...fields });
}
interface ReadingStore {
  programs: Record<string, EvolutionReading>;
  workspaceProgramIds: Record<string, string | null>;
  selectWorkspaceProgram: (workspaceKey: string, programId: string | null) => void;
  update: (programId: string, change: Partial<EvolutionReading>) => void;
  clearOwnerSelections: () => void;
}

/** Only user reading preferences. Current adoption and all evidence stay in the owner read model. */
export const useEvolutionReading = create<ReadingStore>()(
  persist(
    (set) => ({
      programs: {},
      workspaceProgramIds: {},
      selectWorkspaceProgram: (workspaceKey, programId) =>
        set((state) => ({ workspaceProgramIds: { ...state.workspaceProgramIds, [workspaceKey]: programId } })),
      clearOwnerSelections: () =>
        set((state) => ({
          workspaceProgramIds: {},
          programs: Object.fromEntries(
            Object.entries(state.programs).map(
              ([id, { view, scroll, journeyMoment, preparationSection, preparationGtSourceKey, exploration }]) => [
                id,
                {
                  view,
                  scroll,
                  ...(journeyMoment === undefined ? {} : { journeyMoment }),
                  ...(preparationSection === undefined ? {} : { preparationSection }),
                  ...(preparationGtSourceKey === undefined ? {} : { preparationGtSourceKey }),
                  ...(exploration === undefined ? {} : { exploration: clearExplorationSelection(exploration) }),
                },
              ],
            ),
          ),
        })),
      update: (programId, change) =>
        set((state) => ({
          programs: {
            ...state.programs,
            [programId]: {
              ...(state.programs[programId] ?? DEFAULT_READING),
              ...change,
            },
          },
        })),
    }),
    {
      name: 'f311-program-reading-v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ programs: state.programs }),
      merge: (persisted, current) => {
        const parsed = z.object({ programs: persistedObject }).safeParse(persisted);
        if (!parsed.success) return current;
        const programs = Object.fromEntries(
          Object.entries(parsed.data.programs).flatMap(([id, value]) => {
            const recovered = recoverProgramReading(value);
            return recovered ? [[id, recovered]] : [];
          }),
        );
        return { ...current, programs };
      },
    },
  ),
);

/** An explicit owner-version navigation retargets exploration; inspecting an adjacent owner read does not. */
export function navigateEvolutionVersion(programId: string, exactVersionRef: ExactAssetVersionRefV1) {
  const state = useEvolutionReading.getState();
  const exploration = state.programs[programId]?.exploration;
  state.update(programId, {
    selectedVersionRef: exactVersionRef,
    ...(exploration ? { exploration: clearExplorationSelection(exploration) } : {}),
  });
}

export function openEvolutionReading(
  programId: string,
  view: EvolutionReadingView,
  exactVersionRef?: ExactAssetVersionRefV1,
) {
  const state = useEvolutionReading.getState();
  const previous = state.programs[programId] ?? DEFAULT_READING;
  state.update(programId, {
    view,
    ...(exactVersionRef === undefined
      ? {}
      : {
          selectedVersionRef: exactVersionRef,
          ...(previous.exploration ? { exploration: clearExplorationSelection(previous.exploration) } : {}),
          journeyMoment: 2,
          scroll: { ...previous.scroll, [view]: 0 },
        }),
  });
}
