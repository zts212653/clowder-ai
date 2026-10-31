import { z } from 'zod';
import type { ArtifactReviewAnchor } from './artifact-review-media.js';
import { videoProjectReviewAnchorSchema } from './video-project-review.js';
import { videoProjectFrozenInputSchema } from './video-project-screening.js';

const id = z.string().trim().min(1).max(256);
const revision = z.number().int().positive().safe();
export const projectModificationSourceSchema = z
  .object({
    kind: z.literal('video-project'),
    contentRef: id,
    reviewId: id,
    expectedReviewRevision: revision,
    screeningId: id,
    input: videoProjectFrozenInputSchema,
    media: videoProjectFrozenInputSchema,
    annotationIds: z.array(id).min(1).max(12),
  })
  .strict();
export const projectModificationSelectionItemSchema = z
  .object({
    id,
    selection: videoProjectReviewAnchorSchema,
    instruction: z.string().trim().min(1).max(8000).optional(),
  })
  .strict();
type ProjectValidationAnchor = Pick<
  z.infer<typeof projectModificationSelectionItemSchema>['selection'],
  'kind' | 'baseOwnerRevision' | 'baseRevision'
>;
interface ProjectModificationValidationInput {
  readonly source: z.infer<typeof projectModificationSourceSchema>;
  readonly intent: {
    readonly selections?: readonly {
      readonly selection:
        | ProjectValidationAnchor
        | Pick<ArtifactReviewAnchor, 'kind'>
        | { readonly kind: 'text_quote' };
    }[];
  };
  readonly taskContext?: object;
}
export function validateProjectModification(request: ProjectModificationValidationInput, ctx: z.RefinementCtx) {
  const selections = request.intent.selections;
  if (request.source.kind !== 'video-project') return;
  {
    const source = request.source;
    if (source.input.contentRef !== source.contentRef || !selections?.length || request.taskContext)
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'Project takeover requires frozen project selections without a media/text task context',
      });
    for (const [index, item] of (selections ?? []).entries()) {
      if (
        item.selection.kind !== 'video-project' ||
        item.selection.baseOwnerRevision !== source.input.ownerRevision ||
        item.selection.baseRevision !== source.input.blobDigest
      )
        ctx.addIssue({
          code: 'custom',
          path: ['intent', 'selections', index],
          message: 'Project selection must bind the source input revision',
        });
    }
    if (
      new Set(source.annotationIds).size !== source.annotationIds.length ||
      source.annotationIds.length !== selections?.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['source', 'annotationIds'],
        message: 'Every selected opinion needs one unique canonical annotation',
      });
  }
}
