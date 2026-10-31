import { z } from 'zod';
import {
  videoProjectExtensionSchema,
  videoProjectIdSchema,
  videoProjectJsonSchema,
  videoProjectPositiveSchema,
  videoProjectTextSchema,
  videoProjectTickSchema,
} from './video-project-primitives.js';
import { assetSwitchSequenceIssues } from './video-project-switching.js';

function greatestCommonDivisor(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

export const videoProjectTimebaseSchema = z
  .object({
    numerator: videoProjectPositiveSchema,
    denominator: videoProjectPositiveSchema,
  })
  .strict()
  .refine((value) => {
    // Zod also runs this refinement after int/safe checks marked a numeric field invalid.
    if (
      !Number.isSafeInteger(value.numerator) ||
      value.numerator <= 0 ||
      !Number.isSafeInteger(value.denominator) ||
      value.denominator <= 0
    )
      return true;
    return greatestCommonDivisor(value.numerator, value.denominator) === 1;
  }, 'Timebase must be reduced');

export const videoProjectVisualSchema = z
  .object({
    id: videoProjectIdSchema,
    assetVersionRef: videoProjectIdSchema.optional(),
    generated: videoProjectJsonSchema.optional(),
    startTick: videoProjectTickSchema,
    endTick: videoProjectPositiveSchema,
  })
  .strict()
  .superRefine((visual, ctx) => {
    if (visual.endTick <= visual.startTick)
      ctx.addIssue({ code: 'custom', path: ['endTick'], message: 'Visual range must be nonempty' });
    if ((visual.assetVersionRef === undefined) === (visual.generated === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Visual requires exactly one frozen asset reference or generated value',
      });
    }
  });

export const videoProjectSegmentSchema = z
  .object({
    id: videoProjectIdSchema,
    kind: z.enum(['shot', 'beat']),
    sceneId: videoProjectIdSchema.optional(),
    label: videoProjectTextSchema(1000),
    startTick: videoProjectTickSchema,
    durationTicks: videoProjectPositiveSchema,
    visuals: z.array(videoProjectVisualSchema).max(10000),
    switchMode: z.enum(['even', 'explicit']).optional(),
    extensions: z.array(videoProjectExtensionSchema).max(1000).optional(),
  })
  .strict()
  .superRefine((segment, ctx) => {
    segment.visuals.forEach((visual, index) => {
      if (visual.endTick > segment.durationTicks) {
        ctx.addIssue({
          code: 'custom',
          path: ['visuals', index, 'endTick'],
          message: 'Visual exceeds segment duration',
        });
      }
    });
    for (const issue of assetSwitchSequenceIssues(segment)) {
      ctx.addIssue({ code: 'custom', path: ['visuals', issue.visualIndex, issue.field], message: issue.message });
    }
  });

export const videoProjectEventSchema = z
  .object({
    id: videoProjectIdSchema,
    kind: z.enum(['dialogue', 'subtitle', 'audio', 'marker']),
    startTick: videoProjectTickSchema,
    durationTicks: videoProjectPositiveSchema.optional(),
    text: videoProjectTextSchema(16000).optional(),
    speaker: videoProjectTextSchema(256).optional(),
    assetVersionRef: videoProjectIdSchema.optional(),
    segmentId: videoProjectIdSchema.optional(),
    extensions: z.array(videoProjectExtensionSchema).max(1000).optional(),
  })
  .strict()
  .refine(
    (event) => Number.isSafeInteger(event.startTick + (event.durationTicks ?? 0)),
    'Event end must be a safe tick',
  );

export const videoProjectTimelineSchema = z
  .object({
    timebase: videoProjectTimebaseSchema,
    durationTicks: videoProjectPositiveSchema,
    width: videoProjectPositiveSchema,
    height: videoProjectPositiveSchema,
    scenes: z.array(z.object({ id: videoProjectIdSchema, label: videoProjectTextSchema(1000) }).strict()).max(10000),
    segments: z.array(videoProjectSegmentSchema).max(10000),
    events: z.array(videoProjectEventSchema).max(10000),
    extensions: z.array(videoProjectExtensionSchema).max(1000).optional(),
  })
  .strict()
  .superRefine((timeline, ctx) => {
    let previousEnd = 0;
    timeline.segments.forEach((segment, index) => {
      const endTick = segment.startTick + segment.durationTicks;
      if (!Number.isSafeInteger(endTick) || endTick > timeline.durationTicks || segment.startTick < previousEnd) {
        ctx.addIssue({
          code: 'custom',
          path: ['segments', index],
          message: 'Narrative segments must be ordered, nonoverlapping and inside the timeline',
        });
      }
      previousEnd = endTick;
    });
  });
export type VideoProjectTimeline = z.infer<typeof videoProjectTimelineSchema>;
export type VideoProjectSegment = z.infer<typeof videoProjectSegmentSchema>;
