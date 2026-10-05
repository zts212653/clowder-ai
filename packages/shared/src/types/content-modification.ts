import { z } from 'zod';
import { artifactReviewAnchorSchema } from './artifact-review.js';
import { type ArtifactReviewImageEdit, artifactReviewImageEditSchema } from './artifact-review-drawing.js';
import { evolutionMediaLocatorSchema } from './evolution-media-source.js';
import { workspaceContentLocatorSchema, workspaceTextAnchorSchema } from './workspace-content-review.js';

const id = z.string().trim().min(1).max(256);
const revision = z.number().int().positive().safe();
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const businessTime = z.number().int().positive().safe();

export const contentModificationSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('artifact-review'), reviewId: id, round: revision, expectedReviewRevision: revision })
    .strict(),
  z
    .object({
      kind: z.literal('evolution'),
      locator: evolutionMediaLocatorSchema,
      expectedSourceRevision: sha,
      reviewId: id,
      expectedReviewRevision: revision,
    })
    .strict(),
  z
    .object({
      kind: z.literal('publication'),
      contentRef: id,
      ownerRevision: revision,
      ledgerRef: id,
      expectedLedgerRevision: revision,
    })
    .strict(),
  z
    .object({
      kind: z.literal('workspace'),
      locator: workspaceContentLocatorSchema,
      expectedSourceRevision: sha,
      reviewId: id,
      expectedReviewRevision: revision,
    })
    .strict(),
]);

/** One explicit human submit; operational refs never supply the human principal or default target. */
export const contentModificationRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    source: contentModificationSourceSchema,
    targetCatId: id,
    threadId: id,
    intent: z
      .object({
        body: z.string().max(4000),
        imageEdit: artifactReviewImageEditSchema.optional(),
        selection: z.union([artifactReviewAnchorSchema, workspaceTextAnchorSchema]).optional(),
      })
      .strict()
      .refine(
        (intent) => Boolean(intent.body.trim()) || intent.imageEdit !== undefined,
        'A modification instruction is required',
      ),
    taskContext: z
      .union([
        z
          .object({
            kind: z.literal('media').optional(),
            taskId: id,
            expectedTaskRevision: revision,
            reviewId: id,
            expectedReviewRevision: revision,
            round: revision,
          })
          .strict(),
        z.object({ kind: z.literal('text'), taskId: id, expectedTaskRevision: revision }).strict(),
      ])
      .optional(),
    time: z
      .object({ businessDeadline: businessTime.optional(), reviewBy: businessTime.optional() })
      .strict()
      .optional(),
  })
  .strict();
export type ContentModificationRequest = z.infer<typeof contentModificationRequestSchema>;

export const CONTENT_MODIFICATION_CLOSURES = {
  'published-result-ready': '返回与本次修改请求关联的新版本和具名回应，可从原作品位置重新打开',
  'file-writeback-applied': '先返回可审阅的新版或diff，经你明确接受后写回原文件，并可重新打开',
} as const;
export type ContentModificationCompletionRule = keyof typeof CONTENT_MODIFICATION_CLOSURES;

/** Human source chrome is host metadata, never a connector source or an extra authority grant. */
export const contentModificationSourceMessageV1Schema = z
  .object({
    v: z.literal(1),
    requestId: z.string().regex(/^f309-modification-[a-f0-9]{64}$/),
    requestFingerprint: sha,
    contentTitle: z.string().min(1).max(300),
    targetCatId: id,
    targetName: z.string().min(1).max(200),
    executionThreadTitle: z.string().min(1).max(300),
    completionRule: z.enum(['published-result-ready', 'file-writeback-applied']),
  })
  .strict();
export type ContentModificationSourceMessageV1 = z.infer<typeof contentModificationSourceMessageV1Schema>;

export function imageModificationInstruction(edit: ArtifactReviewImageEdit): string {
  return edit.kind === 'erase-region'
    ? '请移除选中区域内的内容，并自然补全背景，保留区域外的画面。'
    : `请以当前图片为参考，生成 ${edit.ratio} 比例的新版本，保持主体与风格，并核对成品宽高比。`;
}

/** Shared by the visible confirmation and the server; never model-generated or silently truncated. */
export function contentModificationOutcome(intent: ContentModificationRequest['intent']): string {
  const edit = intent.imageEdit;
  const instruction = edit ? imageModificationInstruction(edit) : '';
  const outcome = [instruction, intent.body.trim()].filter(Boolean).join('\n');
  if (!outcome || outcome.length > 4000) throw new Error('modification_intent_length');
  return outcome;
}

export const contentTextEditSchema = z
  .object({
    start: z.number().int().nonnegative().safe(),
    end: z.number().int().nonnegative().safe(),
    expectedText: z.string().max(1024 * 1024),
    replacement: z.string().max(1024 * 1024),
  })
  .strict()
  .refine((edit) => edit.end >= edit.start, 'Invalid patch range');
export const respondContentTextSchema = z
  .object({
    requestId: id,
    operationId: z.string().uuid(),
    expectedTaskRevision: revision,
    expectedProposalRevision: z.number().int().nonnegative().safe(),
    baseRevision: sha,
    edits: z.array(contentTextEditSchema).min(1).max(500),
    response: z.string().trim().min(1).max(8000),
  })
  .strict();
export type ContentTextEdit = z.infer<typeof contentTextEditSchema>;
export type RespondContentText = z.infer<typeof respondContentTextSchema>;

export interface ContentTextProposal {
  proposalRef: string;
  requestId: string;
  revision: number;
  operationId: string;
  baseRevision: string;
  resultRevision: string;
  edits: ContentTextEdit[];
  response: string;
  authorCatId: string;
  createdAt: number;
  receiptRef: string;
}

export const inspectContentModificationSchema = z
  .object({
    requestId: id,
    view: z.enum(['overview', 'source', 'proposals', 'control']).default('overview'),
    reviewId: id.optional(),
    cursor: z.number().int().min(0).max(10_000_000).default(0),
    expectedSnapshot: sha.optional(),
  })
  .strict();
