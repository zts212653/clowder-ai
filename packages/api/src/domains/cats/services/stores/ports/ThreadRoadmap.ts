import { z } from 'zod';

const sourceRef = z.string().min(1).max(500);
const coordinate = {
  v: z.literal(1),
  revision: z.number().int().positive(),
  projectPath: z.string().min(1).max(1000),
  path: z.string().min(1).max(1000),
  boundBy: z.string().min(1).max(100),
  boundAt: z.number().int().nonnegative(),
  sourceRef,
};
export const threadRoadmapSchema = z.discriminatedUnion('state', [
  z.object({ ...coordinate, state: z.literal('active') }).strict(),
  z
    .object({
      ...coordinate,
      state: z.literal('revoked'),
      revokedBy: z.string().min(1),
      revokedAt: z.number().int().nonnegative(),
      revokeSourceRef: sourceRef,
    })
    .strict(),
]);
export type ThreadRoadmap = z.infer<typeof threadRoadmapSchema>;

export const roadmapInputSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('active'),
      projectPath: coordinate.projectPath,
      path: coordinate.path,
      sourceRef,
      expectedRevision: z.number().int().positive().nullable(),
    })
    .strict(),
  z.object({ state: z.literal('revoked'), sourceRef, expectedRevision: z.number().int().positive() }).strict(),
]);
export type RoadmapInput = z.infer<typeof roadmapInputSchema>;
export interface RoadmapMutation {
  expectedRevision: number | null;
  value: ThreadRoadmap;
}
export class ThreadRoadmapConflict extends Error {}

/** Called inside the original metadata CAS: unrelated metadata edits survive; stale binds/revokes do not. */
export function mergeThreadRoadmap(current: ThreadRoadmap | undefined, patch: RoadmapMutation): ThreadRoadmap {
  if ((current?.revision ?? null) !== patch.expectedRevision)
    throw new ThreadRoadmapConflict('Roadmap revision changed; reread current thread metadata');
  const value = threadRoadmapSchema.parse(patch.value);
  if (value.revision !== (current?.revision ?? 0) + 1) throw new ThreadRoadmapConflict('Invalid roadmap revision');
  return value;
}
