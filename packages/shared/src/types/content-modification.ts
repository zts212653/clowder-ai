import { z } from 'zod';
import { artifactReviewAnchorSchema } from './artifact-review.js';
import { type ArtifactReviewImageEdit, artifactReviewImageEditSchema } from './artifact-review-drawing.js';
import { mediaModificationSelectionItemSchema } from './artifact-review-media.js';
import {
  projectModificationSelectionItemSchema,
  projectModificationSourceSchema,
  validateProjectModification,
} from './content-modification-project.js';
import { evolutionMediaLocatorSchema } from './evolution-media-source.js';
import { videoProjectReviewAnchorSchema } from './video-project-review.js';
import { workspaceContentLocatorSchema, workspaceTextAnchorSchema } from './workspace-content-review.js';

const id = z.string().trim().min(1).max(256);
const revision = z.number().int().positive().safe();
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const businessTime = z.number().int().positive().safe();

export const contentModificationSourceSchema = z.discriminatedUnion('kind', [
  projectModificationSourceSchema,
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

const contentModificationSelectionSchema = z.union([
  artifactReviewAnchorSchema,
  workspaceTextAnchorSchema,
  videoProjectReviewAnchorSchema,
]);
export type ContentModificationSelection = z.infer<typeof contentModificationSelectionSchema>;
const textModificationSelectionItemSchema = z
  .object({
    id,
    selection: workspaceTextAnchorSchema,
    instruction: z.string().trim().min(1).max(4000).optional(),
  })
  .strict();
export const contentModificationSelectionItemSchema = z.union([
  textModificationSelectionItemSchema,
  mediaModificationSelectionItemSchema,
  projectModificationSelectionItemSchema,
]);

export const contentModificationTakeoverSchema = z
  .object({
    sourceMessageId: id,
    operationId: z.string().uuid(),
    attachmentId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
export type ContentModificationTakeover = z.infer<typeof contentModificationTakeoverSchema>;

/**
 * Stable structural shape for field-level consumers such as retained drafts.
 * Whole-request boundaries must use contentModificationRequestContractSchema.
 */
export const contentModificationRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    source: contentModificationSourceSchema,
    targetCatId: id,
    threadId: id,
    intent: z
      .object({
        body: z.string().max(8000),
        imageEdit: artifactReviewImageEditSchema.optional(),
        selection: contentModificationSelectionSchema.optional(),
        selections: z.array(contentModificationSelectionItemSchema).min(1).max(12).optional(),
      })
      .strict()
      .superRefine((intent, ctx) => {
        if (intent.imageEdit && intent.selections)
          ctx.addIssue({
            code: 'custom',
            path: ['imageEdit'],
            message: 'Choose a whole-image edit or named selections',
          });
        if (
          intent.selection &&
          intent.selections &&
          JSON.stringify(intent.selection) !== JSON.stringify(intent.selections[0]?.selection)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['selections'],
            message: 'The legacy selection alias must equal the first named selection',
          });
        }
        const ids = new Set<string>();
        for (const [index, item] of (intent.selections ?? []).entries()) {
          if (ids.has(item.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['selections', index, 'id'],
              message: 'Selection ids must be unique',
            });
          }
          ids.add(item.id);
        }
        if (
          !intent.body.trim() &&
          intent.imageEdit === undefined &&
          !intent.selections?.some((item) => item.instruction)
        ) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A modification instruction is required' });
        }
      }),
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

/** One explicit human submit; operational refs never supply the human principal or default target. */
export const contentModificationRequestContractSchema = contentModificationRequestSchema.superRefine((request, ctx) => {
  const selections = request.intent.selections;
  if (request.source.kind === 'video-project') {
    validateProjectModification(
      { source: request.source, intent: request.intent, taskContext: request.taskContext },
      ctx,
    );
    return;
  }
  if (request.intent.body.length > 4000)
    ctx.addIssue({
      code: 'custom',
      path: ['intent', 'body'],
      message: 'Legacy text/media instructions remain at most 4000 characters',
    });
  if (selections?.some((item) => item.selection.kind === 'video-project')) {
    ctx.addIssue({
      code: 'custom',
      path: ['intent', 'selections'],
      message: 'Project selections require a project source',
    });
    return;
  }
  if (!selections) return;
  const text = selections.filter((item) => item.selection.kind === 'text_quote');
  if (text.length === 0) {
    if (request.taskContext?.kind === 'text')
      ctx.addIssue({ code: 'custom', path: ['taskContext'], message: 'Media selections require media context' });
    return;
  }
  if (text.length !== selections.length) {
    ctx.addIssue({ code: 'custom', path: ['intent', 'selections'], message: 'Do not mix text and media selections' });
    return;
  }
  if (request.source.kind !== 'workspace') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['intent', 'selections'],
      message: 'Multiple selections require one workspace source',
    });
    return;
  }
  for (const [index, item] of selections.entries()) {
    if (item.selection.kind === 'text_quote' && item.selection.baseRevision !== request.source.expectedSourceRevision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['intent', 'selections', index, 'selection', 'baseRevision'],
        message: 'Every selection must use the workspace source revision',
      });
    }
  }
});

export interface NormalizedModificationSelection {
  readonly id: string;
  readonly selection: ContentModificationSelection;
  readonly instruction?: string;
}

/** One read shape for legacy single-selection requests and named multi-selection requests. */
export function normalizeModificationSelections(
  intent: Pick<ContentModificationRequest['intent'], 'selection' | 'selections'>,
): NormalizedModificationSelection[] {
  if (intent.selections) return intent.selections.map((item) => ({ ...item }));
  return intent.selection ? [{ id: 'legacy-1', selection: intent.selection }] : [];
}

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

export {
  type ContentModificationReceiptV1,
  contentModificationReceiptFollowUpV1Schema,
  contentModificationReceiptV1Schema,
} from './content-modification-receipt.js';

export function imageModificationInstruction(edit: ArtifactReviewImageEdit): string {
  return edit.kind === 'erase-region'
    ? '请移除选中区域内的内容，并自然补全背景，保留区域外的画面。'
    : `请以当前图片为参考，生成 ${edit.ratio} 比例的新版本，保持主体与风格，并核对成品宽高比。`;
}

/** Shared by the visible confirmation and the server; never model-generated or silently truncated. */
export function contentModificationOutcome(intent: ContentModificationRequest['intent']): string {
  const projectSelections = normalizeModificationSelections(intent);
  if (projectSelections.length && projectSelections.every((item) => item.selection.kind === 'video-project'))
    return `处理原消息中具名审片意见：${projectSelections.map((item) => item.id).join('、')}。完整说明与冻结输入保留在原消息和同一审片账本；返回相关新版本与每条意见的具名处理回执。`;

  const edit = intent.imageEdit;
  const instruction = edit ? imageModificationInstruction(edit) : '';
  const selectionInstructions = normalizeModificationSelections(intent).flatMap((item) =>
    item.instruction ? [`[${item.id}] ${item.instruction}`] : [],
  );
  const outcome = [instruction, intent.body.trim(), ...selectionInstructions].filter(Boolean).join('\n');
  if (!outcome || outcome.length > 4000) throw new Error('modification_intent_length');
  return outcome;
}

export const contentTextEditSchema = z
  .object({
    /** Explicit request-selection relation; absence means an additional unscoped change. */
    selectionId: id.optional(),
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
