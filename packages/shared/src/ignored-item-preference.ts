import { z } from 'zod';

/** Personal presentation only. A mailbox version never hides a newer request. */
export const ignoredItemCoordinateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('schedule'), subjectRef: z.string().trim().min(1) }).strict(),
  z
    .object({
      kind: z.literal('mailbox'),
      decisionRef: z.string().trim().min(1),
      version: z.string().trim().min(1),
    })
    .strict(),
]);
export type IgnoredItemCoordinate = z.infer<typeof ignoredItemCoordinateSchema>;

export function ignoredItemKey(coordinate: IgnoredItemCoordinate): string {
  return coordinate.kind === 'schedule'
    ? JSON.stringify(['schedule', coordinate.subjectRef])
    : JSON.stringify(['mailbox', coordinate.decisionRef, coordinate.version]);
}

export const ignoredItemEntrySchema = z
  .object({
    coordinate: ignoredItemCoordinateSchema,
    ignoredAt: z.number().int().nonnegative(),
  })
  .strict();
export const ignoredItemOwnerPreferenceSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    entries: z.array(ignoredItemEntrySchema),
  })
  .passthrough();
export type IgnoredItemOwnerPreference = z.infer<typeof ignoredItemOwnerPreferenceSchema>;
export const ignoredItemSnapshotSchema = ignoredItemOwnerPreferenceSchema.extend({
  ownerUserId: z.string().trim().min(1),
});
export type IgnoredItemSnapshot = z.infer<typeof ignoredItemSnapshotSchema>;

export const ignoredItemPatchSchema = z
  .object({
    expectedOwnerUserId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative().safe(),
    ignore: z.array(ignoredItemCoordinateSchema),
    restore: z.array(ignoredItemCoordinateSchema),
  })
  .strict()
  .superRefine((patch, context) => {
    const ignoring = new Set(patch.ignore.map(ignoredItemKey));
    if (patch.restore.some((coordinate) => ignoring.has(ignoredItemKey(coordinate)))) {
      context.addIssue({ code: 'custom', message: 'An item cannot be ignored and restored in the same change' });
    }
  });
export type IgnoredItemPatch = z.infer<typeof ignoredItemPatchSchema>;

export interface IgnoredItemPreferences {
  /** File contents are validated per authenticated owner; unknown sibling/future records are preserved. */
  owners?: Record<string, unknown>;
}
