import { type VideoProjectSelfReview, videoProjectSelfReviewSchema } from '@cat-cafe/shared';
import { ContentOwnerIdempotencyError } from '../content-owner/service.js';
import type { ContentSettlementReceiptV1 } from '../content-owner/types.js';
import type { VideoProjectPrincipal } from './access.js';
import { projectValueDigest, sameProjectValue } from './document-mutations.js';
import type { VideoProjectReadPort } from './types.js';

export interface VideoProjectSelfReviewCommand {
  readonly principal: VideoProjectPrincipal;
  readonly contentRef: string;
  readonly expectedOwnerRevision: number;
  readonly operationId: string;
  readonly id: string;
  readonly input: VideoProjectSelfReview['input'];
  readonly segmentIds: readonly string[];
  readonly conclusion: VideoProjectSelfReview['conclusion'];
  readonly refs: readonly string[];
}

/** Re-read actual invocation/original-source evidence. Roles or source attachment presence are insufficient. */
export type AuthorizeVideoProjectSelfReviewSource = (
  input: VideoProjectSelfReviewCommand,
) => Promise<{ readonly refs: readonly string[] }>;
export type AppendVideoProjectSelfReview = (input: {
  principal: VideoProjectPrincipal;
  contentRef: string;
  expectedOwnerRevision: number;
  operationId: string;
  selfReview: VideoProjectSelfReview;
  requestDigest: `sha256:${string}`;
}) => Promise<ContentSettlementReceiptV1>;

export class VideoProjectSelfReviewService {
  constructor(
    private readonly deps: {
      projects: VideoProjectReadPort;
      appendSelfReview: AppendVideoProjectSelfReview;
      authorizeSource?: AuthorizeVideoProjectSelfReviewSource;
      now?: () => string;
    },
  ) {}

  async attest(input: VideoProjectSelfReviewCommand) {
    await this.deps.projects.authorize({ ...input, permission: 'write' });
    if (input.principal.actor.kind !== 'cat' || !input.principal.invocationId || !this.deps.authorizeSource)
      throw new Error('Self-review access denied: authenticated Cat/source authority required');
    const source = await this.deps.authorizeSource(input);
    if (!source.refs.length) throw new Error('Self-review access denied: source evidence required');
    const evidenceRefs = [...new Set([...input.refs, ...source.refs])];
    const refs = [...new Set([...evidenceRefs, `invocation:${input.principal.invocationId}`])];
    const requestDigest = projectValueDigest({
      contentRef: input.contentRef,
      expectedOwnerRevision: input.expectedOwnerRevision,
      operationId: input.operationId,
      id: input.id,
      input: input.input,
      segmentIds: input.segmentIds,
      conclusion: input.conclusion,
      actor: input.principal.actor,
      refs: evidenceRefs,
    });
    const replay = await this.deps.projects.operationReceipt(input);
    if (replay) {
      const saved = await this.deps.projects.load({ ...input, ownerRevision: replay.ownerRevision });
      const selfReview = saved.document.selfReviews?.find((fact) => fact.operationId === input.operationId);
      if (
        replay.operationContext?.kind !== 'video-project:self-review' ||
        replay.operationContext.requestDigest !== requestDigest ||
        replay.previousOwnerRevision !== input.expectedOwnerRevision ||
        !sameProjectValue(replay.actor, input.principal.actor) ||
        !selfReview
      )
        throw new ContentOwnerIdempotencyError(input.contentRef, input.operationId);
      return { receipt: replay, selfReview };
    }
    const frozen = await this.deps.projects.load({ ...input, ownerRevision: input.input.ownerRevision });
    if (
      input.input.contentRef !== input.contentRef ||
      input.input.ownerRevision > input.expectedOwnerRevision ||
      frozen.blobDigest !== input.input.blobDigest ||
      input.segmentIds.some((id) => !frozen.document.timeline.segments.some((segment) => segment.id === id))
    )
      throw new TypeError('Self-review must bind the exact existing input and real segments');
    const selfReview = videoProjectSelfReviewSchema.parse({
      id: input.id,
      input: input.input,
      actor: input.principal.actor,
      at: this.deps.now?.() ?? new Date().toISOString(),
      operationId: input.operationId,
      segmentIds: input.segmentIds,
      conclusion: input.conclusion,
      refs,
    });
    await this.deps.projects.authorize({ ...input, permission: 'write' });
    if (!sameProjectValue(await this.deps.authorizeSource(input), source))
      throw new Error('Self-review source changed');
    const receipt = await this.deps.appendSelfReview({ ...input, selfReview, requestDigest });
    return { receipt, selfReview };
  }
}
