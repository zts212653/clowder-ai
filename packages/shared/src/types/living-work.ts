import { z } from 'zod';
import { artifactReviewResponseRecordSchema } from './artifact-review.js';
import { workVideoContextSchema } from './work-video.js';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim() && !value.includes('\0'));
const ref = z.string().min(1).max(2048);
export const workReferenceSchema = z
  .object({ contentRef: ref, ownerRevision: z.number().int().positive().safe() })
  .strict();
export type WorkReference = z.infer<typeof workReferenceSchema>;

/** A chat reference names immutable owner content; its title and source block never grant access. */
export const workReferenceCardSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.literal('card'),
    v: z.literal(1),
    title: z.string().min(1).max(240),
    bodyMarkdown: z.string().max(4000),
    meta: z.object({ kind: z.literal('work_reference'), reference: workReferenceSchema }).strict(),
  })
  .strict();

/** A locator is input to F063, not permission to read an arbitrary host file. */
export const workWorkspaceSourceSchema = z
  .object({
    worktreeId: id,
    path: z.string().min(1).max(2048),
    expectedSourceRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type WorkWorkspaceSource = z.infer<typeof workWorkspaceSourceSchema>;

/** Bounded tool input. The original UTF-8 source is data; renderers must sanitize before sandboxing. */
export const MAX_HTML_WORK_BYTES = 1024 * 1024;
export const MAX_WORK_COMMAND_BYTES = 32 * 1024;
export const MAX_HTML_WORK_COMMAND_BYTES = 2 * MAX_HTML_WORK_BYTES + MAX_WORK_COMMAND_BYTES;
export const MAX_HTML_WORK_VERSIONS = 256;
export const workHtmlSourceSchema = z
  .object({
    kind: z.literal('html'),
    html: z
      .string()
      .min(1)
      .max(MAX_HTML_WORK_BYTES)
      .refine(
        (html) =>
          html.trim().length > 0 &&
          !html.includes('\0') &&
          new TextEncoder().encode(html).byteLength <= MAX_HTML_WORK_BYTES &&
          new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(html)) === html,
        'HTML must be well-formed UTF-8 within the byte limit',
      ),
  })
  .strict();
export type WorkHtmlSource = z.infer<typeof workHtmlSourceSchema>;
const workSourceSchema = z.union([workWorkspaceSourceSchema, workHtmlSourceSchema]);

const submission = {
  operationId: id,
  title: z.string().trim().min(1).max(240),
  changeSummary: z.string().trim().min(1).max(4000),
  versionLabel: z.string().trim().min(1).max(128).optional(),
  source: workSourceSchema,
};
/** Optional responses name their original round independently of the owner submit CAS. */
export const workReviewResponseSchema = z
  .object({
    reviewId: id,
    sourceRound: z.number().int().positive().safe(),
    expectedReviewRevision: z.number().int().positive().safe(),
    expectedTaskRevision: z.number().int().positive().safe(),
    expectedLedgerRevision: z.number().int().positive().safe().optional(),
    requestId: id.optional(),
    responses: z.array(artifactReviewResponseRecordSchema.omit({ judgment: true })).max(500),
  })
  .strict();
export const submitWorkSchema = z
  .object({
    action: z.literal('submit'),
    ...submission,
    contentRef: ref,
    expectedOwnerRevision: z.number().int().positive().safe(),
    reviewResponse: workReviewResponseSchema.optional(),
  })
  .strict();
export type SubmitWork = z.infer<typeof submitWorkSchema>;
/** The common owner submission surface; format adapters do not mint another work identity. */
export const commitWorkSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), ...submission }).strict(),
  submitWorkSchema,
]);
export type CommitWork = z.infer<typeof commitWorkSchema>;

export const setWorkContextSchema = z
  .object({
    action: z.literal('set-context'),
    reference: workReferenceSchema,
    operationId: id,
    expectedMetadataRevision: z.number().int().nonnegative().safe(),
    context: workVideoContextSchema,
  })
  .strict();
export type SetWorkContext = z.infer<typeof setWorkContextSchema>;

/** Large video indices stay out of the locator-sized command body. */
export const importWorkContextSchema = setWorkContextSchema
  .omit({ action: true, context: true })
  .extend({ action: z.literal('import-context'), source: workWorkspaceSourceSchema })
  .strict();
export type ImportWorkContext = z.infer<typeof importWorkContextSchema>;

export const workCommandSchema = z.union([
  commitWorkSchema,
  setWorkContextSchema,
  importWorkContextSchema,
  z
    .object({
      action: z.literal('resolve-review-submission'),
      reviewId: id,
      sourceRound: z.number().int().positive().safe(),
      expectedReviewRevision: z.number().int().positive().safe(),
      pendingOperationId: id,
      operationId: id,
    })
    .strict(),
  z
    .object({
      action: z.literal('read-context'),
      reference: workReferenceSchema,
      metadataRevision: z.number().int().positive().safe().optional(),
    })
    .strict(),
  z.object({ action: z.literal('read'), reference: workReferenceSchema }).strict(),
  z.object({ action: z.literal('read-body'), reference: workReferenceSchema }).strict(),
  z.object({ action: z.literal('publish-reference'), reference: workReferenceSchema }).strict(),
  z
    .object({
      action: z.literal('inspect-source'),
      locator: workWorkspaceSourceSchema.omit({ expectedSourceRevision: true }),
    })
    .strict(),
  z
    .object({
      action: z.literal('list'),
      after: ref.optional(),
      catalogueSnapshot: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
]);
export type WorkCommand = z.infer<typeof workCommandSchema>;

export const workVersionRecordSchema = workReferenceSchema
  .extend({
    ownerUserId: id,
    threadId: id,
    title: submission.title,
    changeSummary: submission.changeSummary,
    versionLabel: submission.versionLabel,
    source: z.union([workWorkspaceSourceSchema, workHtmlSourceSchema.omit({ html: true })]),
    operationId: id,
    requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    receiptRef: ref,
  })
  .strict();
export type WorkVersionRecord = z.infer<typeof workVersionRecordSchema>;
export const workContextRecordSchema = z
  .object({
    reference: workReferenceSchema,
    metadataRevision: z.number().int().positive().safe(),
    ownerUserId: id,
    operationId: id,
    requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    actor: z.object({ kind: z.enum(['human', 'cat']), actorId: id }).strict(),
    recordedAt: z.string().datetime(),
    context: workVideoContextSchema,
  })
  .strict();
export type WorkContextRecord = z.infer<typeof workContextRecordSchema>;
