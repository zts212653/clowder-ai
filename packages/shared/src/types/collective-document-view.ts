import { z } from 'zod';
import {
  type CollectiveModificationProjection,
  collectiveModificationProjectionSchema,
} from './collective-content-modification.js';
import { type WorkspaceContentReview, workspaceContentReviewSchema } from './workspace-content-review.js';

export interface CollectiveDocumentView {
  contentRef: string;
  ownerRevision: number;
  blobDigest: string;
  text: string;
  view: {
    review: Omit<WorkspaceContentReview, 'ownerUserId'>;
    historyReadOnly: boolean;
    canWrite: boolean;
    canReply?: boolean;
    replyPages?: { annotationId: string; offset: number; total: number; nextOffset?: number }[];
    annotationPage: { offset: number; total: number; nextOffset?: number };
    annotationResolutions?: { annotationId: string; status: 'attached' | 'moved' | 'ambiguous' | 'orphaned' }[];
  };
  modifications?: {
    requests: CollectiveModificationProjection[];
    total: number;
    offset: number;
    nextOffset?: number;
    snapshot?: string;
  };
}
export const collectiveDocumentViewSchema: z.ZodType<CollectiveDocumentView, z.ZodTypeDef, unknown> = z
  .object({
    contentRef: z.string(),
    ownerRevision: z.number().int().positive(),
    blobDigest: z.string(),
    text: z.string().max(65536),
    view: z
      .object({
        review: workspaceContentReviewSchema.innerType().omit({ ownerUserId: true }),
        historyReadOnly: z.boolean(),
        canWrite: z.boolean(),
        canReply: z.boolean().optional(),
        replyPages: z
          .object({
            annotationId: z.string(),
            offset: z.number(),
            total: z.number(),
            nextOffset: z.number().optional(),
          })
          .array()
          .optional(),
        annotationPage: z.object({ offset: z.number(), total: z.number(), nextOffset: z.number().optional() }),
        annotationResolutions: z
          .object({ annotationId: z.string(), status: z.enum(['attached', 'moved', 'ambiguous', 'orphaned']) })
          .array()
          .optional(),
      })
      .strip(),
    modifications: z
      .object({
        requests: collectiveModificationProjectionSchema.array(),
        total: z.number(),
        offset: z.number(),
        nextOffset: z.number().optional(),
        snapshot: z
          .string()
          .regex(/^sha256:[a-f0-9]{64}$/)
          .optional(),
      })
      .optional(),
  })
  .strip();
