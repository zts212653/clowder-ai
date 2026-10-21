import { z } from 'zod';
import {
  videoProjectAssetSchema,
  videoProjectDigestSchema,
  videoProjectTextSchema,
} from './video-project-primitives.js';

const text = videoProjectTextSchema;
const pts = z.number().int().safe();
const chapter = z
  .object({
    id: text(256),
    title: text(1000),
    label: text(256).optional(),
    streamId: text(128),
    startPts: pts,
    endPts: pts,
    sourceId: text(2048).optional(),
  })
  .strict()
  .refine((row) => row.startPts < row.endPts, 'Chapter range must be nonempty');
/** Derived notes about a fixed video version. These fields never own the work's identity or current version. */
export const workVideoContextSchema = z
  .object({
    format: z.literal('video'),
    extractorVersion: text(128),
    provenance: z
      .array(z.object({ ref: text(2048), digest: videoProjectDigestSchema }).strict())
      .min(1)
      .max(100),
    /** Original production/file time, distinct from the owner's import/commit time. */
    production: z
      .object({ createdAt: z.string().datetime(), sourceRef: text(2048) })
      .strict()
      .optional(),
    chapters: z.array(chapter).max(1000).optional(),
    story: z
      .array(
        z
          .object({
            id: text(256),
            chapterId: text(256).optional(),
            title: text(1000),
            text: z.string().max(12000).optional(),
            streamId: text(128),
            startPts: pts,
            endPts: pts,
            /** Only explicit source identity may relate this paragraph to another version. */
            sourceId: text(2048).optional(),
            derived: z.boolean().optional(),
          })
          .strict()
          .refine((item) => item.startPts < item.endPts, 'Story range must be nonempty'),
      )
      .max(10000),
    assets: z
      .array(
        z
          .object({
            asset: videoProjectAssetSchema,
            versionId: text(256),
            uses: z.array(text(2000)).min(1).max(1000),
          })
          .strict()
          .refine(
            (item) => item.asset.versions.some((version) => version.id === item.versionId),
            'Selected asset version must exist',
          ),
      )
      .max(10000),
    sourceBinding: z
      .object({
        sourceProjectContentRef: text(2048),
        sourceOwnerRevision: z.number().int().positive().safe(),
        sourceDigest: videoProjectDigestSchema,
        screeningId: text(256).optional(),
        reviewId: text(256).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [field, ids] of [
      ['story', value.story.map((row) => row.id)],
      ['assets', value.assets.map((row) => row.asset.id)],
      ['chapters', (value.chapters ?? []).map((row) => row.id)],
    ] as const) {
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: 'custom', path: [field], message: 'Duplicate stable identity' });
    }
    const chapterById = new Map(value.chapters?.map((row) => [row.id, row]));
    for (const [index, row] of value.story.entries()) {
      if (!row.chapterId) continue;
      const parent = chapterById.get(row.chapterId);
      if (!parent || parent.streamId !== row.streamId || row.startPts < parent.startPts || row.endPts > parent.endPts)
        ctx.addIssue({
          code: 'custom',
          path: ['story', index, 'chapterId'],
          message: 'Line must belong to its chapter and clock',
        });
    }
  });
export type WorkVideoContext = z.infer<typeof workVideoContextSchema>;
