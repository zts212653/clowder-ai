import { createHash } from 'node:crypto';
import { inspectContentModificationSchema } from '@cat-cafe/shared';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { ContentModificationService } from './service.js';
import type { ModificationSourceDiscussions } from './source-discussions.js';
import type { ContentTextModificationService } from './text/text-service.js';
import { ModificationTextError } from './text/text-store.js';

/** Exact JSON text pages also handle large patch strings; concatenate pages then JSON.parse, never omit a field. */
export async function inspectContentModification(
  service: ContentTextModificationService,
  raw: unknown,
  principal: MediaReviewPrincipal,
  discussions?: Pick<ModificationSourceDiscussions, 'forRequest'>,
  requests?: Pick<ContentModificationService, 'controlForCat'>,
) {
  const input = inspectContentModificationSchema.parse(raw);
  if (input.reviewId && input.view !== 'control') throw new ModificationTextError('not_found');
  const control = await requests?.controlForCat(input.requestId, principal, input.reviewId);
  if (input.view === 'control' && !control) throw new ModificationTextError('not_found');
  if (control && (input.view === 'control' || control.stage !== 'active'))
    return contentModificationPage(
      input,
      `sha256:${createHash('sha256').update(JSON.stringify(control)).digest('hex')}`,
      control,
    );
  const view = await service.read(input.requestId, principal);
  const sourceDiscussions =
    input.view === 'proposals' ? undefined : await discussions?.forRequest(input.requestId, principal);
  const snapshot = `sha256:${createHash('sha256')
    .update(
      JSON.stringify([
        view.record.revision,
        view.taskRevision,
        view.currentRevision,
        view.proposals.map((p) => p.receiptRef),
        view.rejections.map((item) => item.receiptRef),
        sourceDiscussions?.map((item) => [item.review.reviewId, item.review.revision]),
      ]),
    )
    .digest('hex')}`;
  const value =
    input.view === 'source'
      ? { ...view.source, sourceDiscussions }
      : input.view === 'proposals'
        ? view.proposals.map((proposal) => {
            const humanRejection = view.rejections.find((item) => item.candidateRef === proposal.proposalRef);
            return { ...proposal, ...(humanRejection ? { humanRejection } : {}) };
          })
        : {
            request: view.record,
            taskRevision: view.taskRevision,
            source: {
              ...view.source.source,
              reviewId: view.source.reviewId,
              reviewRevision: view.source.reviewRevision,
            },
            proposalRevision: view.proposals.at(-1)?.revision ?? 0,
            execution: view.execution,
            rejections: view.rejections,
            sourceDiscussions,
            trust: 'untrusted_user_content',
            writeback: 'human_explicit_acceptance_only',
          };
  return contentModificationPage(input, snapshot, value);
}

function contentModificationPage(
  input: { requestId: string; view: string; cursor: number; expectedSnapshot?: string },
  snapshot: string,
  value: unknown,
) {
  if ((input.cursor > 0 && !input.expectedSnapshot) || (input.expectedSnapshot && input.expectedSnapshot !== snapshot))
    throw new ModificationTextError('proposal_changed');
  const serialized = JSON.stringify(value);
  if (input.cursor > serialized.length) throw new ModificationTextError('not_found');
  let end = Math.min(serialized.length, input.cursor + 6000);
  const page = () => ({
    requestId: input.requestId,
    section: input.view,
    snapshot,
    encoding: 'json-text-chunk',
    json: serialized.slice(input.cursor, end),
    nextCursor: end < serialized.length ? end : null,
  });
  while (JSON.stringify(page()).length > 12000 && end > input.cursor) end -= 256;
  return page();
}
