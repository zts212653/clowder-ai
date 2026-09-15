import { z } from 'zod';
import { evolutionOwnerHrefSchema } from './capability-evolution-asset-review.js';
import {
  bounded,
  exactAssetVersionRefV1Schema,
  ownerTruthRefV1Schema,
  refIdentity,
} from './capability-evolution-refs.js';

/** Exact read coordinates, never an execution capability or a copy of an owner's evidence store. */
export const evolutionExplorationRefSchema = ownerTruthRefV1Schema.refine((ref) => Boolean(ref.version), {
  message: 'exploration sources require an exact revision',
});
const exact = evolutionExplorationRefSchema;
export const evolutionExplorationNodeRefSchema = z.union([exact, exactAssetVersionRefV1Schema]);
const fact = z.object({ label: bounded(240), value: bounded(4_000) }).strict();
const source = z.object({ label: bounded(240), ref: exact, href: evolutionOwnerHrefSchema.optional() }).strict();
export const evolutionExplorationReadFailureSchema = z
  .object({ status: z.enum(['unavailable', 'invalid']), reason: bounded(2_000) })
  .strict();
const mediaRef = exact.refine((ref) => /^[a-f0-9]{64}$/.test(ref.version ?? ''), 'media needs a SHA-256 revision');
const mediaType = {
  kind: z.enum(['image', 'video']),
  contentType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']),
};

/** In-process owner byte reads have one runtime-validated response, separate from publication metadata. */
export const evolutionExplorationMediaReadV1Schema = z
  .discriminatedUnion('status', [
    z
      .object({
        status: z.literal('resolved'),
        mediaRef,
        ...mediaType,
        bytes: z.custom<Uint8Array>(
          (bytes) => bytes instanceof Uint8Array && bytes.byteLength > 0,
          'media needs nonempty bytes',
        ),
      })
      .strict(),
    evolutionExplorationReadFailureSchema,
    z.object({ status: z.literal('not_found'), reason: bounded(2_000) }).strict(),
  ])
  .superRefine((read, ctx) => {
    if (read.status === 'resolved' && !read.contentType.startsWith(`${read.kind}/`))
      ctx.addIssue({ code: 'custom', message: 'media type and kind disagree' });
  });

export const evolutionExplorationMetricSchema = z
  .object({ key: bounded(120), label: bounded(240), unit: bounded(80), definition: bounded(2_000), sourceRef: exact })
  .strict();

export const evolutionExplorationMediaSchema = z
  .object({
    mediaRef,
    ...mediaType,
    label: bounded(240),
    provenance: z.enum(['original', 'identical_capture_replay']),
    sourceRecordRef: exact,
    durationSeconds: z.number().finite().positive().max(86_400).optional(),
    timeRange: z
      .object({ startSeconds: z.number().finite().nonnegative(), endSeconds: z.number().finite().nonnegative() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((media, ctx) => {
    if (!media.contentType.startsWith(`${media.kind}/`))
      ctx.addIssue({ code: 'custom', message: 'media type and kind disagree' });
    if (media.timeRange && media.timeRange.endSeconds < media.timeRange.startSeconds)
      ctx.addIssue({ code: 'custom', message: 'media time range is reversed' });
  });

export const evolutionExplorationRecordSchema = z
  .object({
    recordRef: exact,
    experimentRef: exact,
    nodeRef: evolutionExplorationNodeRefSchema,
    /** Row identity within this experiment; repeated captures keep distinct row ids. */
    caseId: bounded(240),
    label: bounded(240),
    /** Same actual input, independently of the display name or the row's place in a list. */
    inputRef: exact,
    /** Shared hashes expose repeated records; a row is not automatically an independent sample. */
    evidenceRef: exact,
    windowRef: exact,
    measurementRef: exact,
    input: z.array(fact).max(32),
    output: z.array(fact).max(32),
    result: z
      .object({ status: z.enum(['satisfied', 'violated', 'observed', 'unknown']), label: bounded(400) })
      .strict(),
    values: z.record(z.string().max(120), z.number().finite().nullable()),
    trace: z
      .object({
        sourceRef: exact,
        label: bounded(240),
        definition: bounded(2_000),
        xLabel: bounded(120),
        yLabel: bounded(120),
        unit: bounded(80),
        points: z
          .array(
            z
              .object({ x: z.number().finite(), y: z.number().finite(), seconds: z.number().finite().nonnegative() })
              .strict(),
          )
          .min(2)
          .max(512),
        target: z
          .object({ x: z.number().finite(), y: z.number().finite(), label: bounded(120) })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    media: z.array(evolutionExplorationMediaSchema).max(8),
    mediaStatus: evolutionExplorationReadFailureSchema.optional(),
    sources: z.array(source).min(1).max(16),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.mediaStatus && record.media.length)
      ctx.addIssue({ code: 'custom', message: 'failed media inventory cannot publish verified media' });
    if (
      record.trace &&
      (refIdentity(record.trace.sourceRef) !== refIdentity(record.evidenceRef) ||
        record.trace.points.some(
          (point, index) => index > 0 && point.seconds <= (record.trace?.points[index - 1]?.seconds ?? -1),
        ))
    )
      ctx.addIssue({ code: 'custom', message: 'derived trace must retain exact evidence identity and chronology' });
    if (record.media.some((media) => refIdentity(media.sourceRecordRef) !== refIdentity(record.evidenceRef)))
      ctx.addIssue({
        code: 'custom',
        message: 'media must bind this record evidence, including identical-capture replays',
      });
  });

const condition = z.object({ label: bounded(240), detail: bounded(2_000), sourceRef: exact }).strict();
export const evolutionExplorationConditionsSchema = z
  .object({
    environment: condition,
    sampleSet: condition,
    measurement: condition,
    groundTruth: condition.extend({ status: z.enum(['bounded', 'unverified', 'missing']) }).strict(),
    window: condition,
    exposure: z.enum(['public_development', 'isolated_test', 'independent_validation', 'production_observation']),
    limitation: bounded(4_000),
    threshold: z.discriminatedUnion('status', [
      z.object({ status: z.literal('unknown'), detail: bounded(2_000) }).strict(),
      z.object({ status: z.literal('frozen'), detail: bounded(2_000), sourceRef: exact }).strict(),
    ]),
    comparison: z
      .object({
        design: z.enum(['paired', 'unpaired', 'undeclared']),
        method: bounded(2_000),
        planRef: exact.optional(),
      })
      .strict(),
    preparationRefs: z.array(source).max(16),
  })
  .strict()
  .superRefine((conditions, ctx) => {
    if (conditions.comparison.design !== 'undeclared' && !conditions.comparison.planRef)
      ctx.addIssue({ code: 'custom', message: 'declared comparison requires an exact owner method' });
  });

export type EvolutionExplorationRecordV1 = z.infer<typeof evolutionExplorationRecordSchema>;
export type EvolutionExplorationMediaV1 = z.infer<typeof evolutionExplorationMediaSchema>;
export type EvolutionExplorationMediaReadV1 = z.infer<typeof evolutionExplorationMediaReadV1Schema>;
export type EvolutionExplorationReadFailureV1 = z.infer<typeof evolutionExplorationReadFailureSchema>;
export type EvolutionExplorationConditionsV1 = z.infer<typeof evolutionExplorationConditionsSchema>;
export type EvolutionExplorationMetricV1 = z.infer<typeof evolutionExplorationMetricSchema>;
