import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryRequestReviewOwnerLedger } from '../dist/infrastructure/capability-evolution/adapters/request-review/request-review-owner-ledger.js';
import { RequestReviewUseReceiptService } from '../dist/infrastructure/capability-evolution/adapters/request-review/request-review-use-receipt.js';

const assetVersionRef = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
  version: 'a'.repeat(64),
  assetKind: 'skill',
  assetId: 'cat-cafe-skills/request-review/SKILL.md',
};
const authorScope = {
  userId: 'owner-1',
  threadId: 'thread-review',
  invocationId: 'inv-author',
  catId: 'codex-sol',
  ownerAuthProvenance: 'strict',
  originMessageId: 'message-author-origin',
};
const reviewSubjectRef = 'pr:owner/cat-cafe#4512';
const reviewedHeadSha = 'c'.repeat(40);
const acceptedSourceRef = 'docs/features/F314-development-episode-alignment-experiment.md';
const acceptedRevision = 'd'.repeat(40);
const reviewerInvocationId = 'inv-reviewer';
const requestMessageId = 'message-request';
const reviewMessageId = 'message-review';
const reviewerScope = {
  userId: authorScope.userId,
  threadId: authorScope.threadId,
  invocationId: reviewerInvocationId,
  catId: 'codex-terra',
};

function localReviewMessage(overrides = {}) {
  return {
    id: reviewMessageId,
    threadId: authorScope.threadId,
    catId: 'codex-terra',
    extra: {
      stream: { invocationId: reviewerInvocationId, turnInvocationId: reviewerInvocationId },
      localReviewVerdict: {
        verdict: 'changes_requested',
        clientMessageId: 'review-result-1',
        reviewedHeadSha,
        reviewSubjectRef,
        acceptedSourceRef,
        acceptedRevision,
      },
    },
    ...overrides,
  };
}

function fixture(options = {}) {
  let tick = 0;
  const ledger = options.ledger ?? new MemoryRequestReviewOwnerLedger();
  const messages = new Map([
    [
      requestMessageId,
      {
        id: requestMessageId,
        threadId: authorScope.threadId,
        catId: authorScope.catId,
        content: [
          'Please review this change.',
          `Review-Subject-Ref: ${reviewSubjectRef}`,
          `Reviewed-Head-Sha: ${reviewedHeadSha}`,
          'Request-Review-Consumption-Handle: opaque-token-1',
          `Accepted-Source-Ref: ${acceptedSourceRef}`,
          `Accepted-Revision: ${acceptedRevision}`,
        ].join('\n'),
        mentions: ['codex-terra'],
        extra: {
          targetCats: ['codex-terra'],
          stream: { invocationId: authorScope.invocationId, turnInvocationId: authorScope.invocationId },
        },
      },
    ],
    [reviewMessageId, localReviewMessage()],
  ]);
  const invocations = new Map([
    [
      reviewerInvocationId,
      {
        invocationId: reviewerInvocationId,
        userId: authorScope.userId,
        catId: 'codex-terra',
        threadId: authorScope.threadId,
        ownerAuthProvenance: 'strict',
        originTriggerMessageId: requestMessageId,
      },
    ],
  ]);
  const attested = options.attested ?? (() => true);
  const service = new RequestReviewUseReceiptService({
    ledger,
    messageStore: { getById: async (messageId) => messages.get(messageId) ?? null },
    invocationRegistry: { peekRecord: async (invocationId) => invocations.get(invocationId) ?? null },
    versionAttestor: {
      async deliver(ref) {
        return attested(ref)
          ? {
              status: 'attested',
              deliveredAssetVersionRef: ref,
              deliveredPackageRevision: `sha256:${'e'.repeat(64)}`,
            }
          : { status: 'unconfirmed' };
      },
    },
    now: () => new Date(Date.parse('2026-09-12T10:00:00.000Z') + tick++ * 1_000).toISOString(),
    randomToken: () => 'opaque-token-1',
  });
  return { service, ledger, messages, invocations };
}

async function prepareAndBind(ctx) {
  const prepared = await ctx.service.prepare({
    scope: authorScope,
    assetVersionRef,
    reviewerCatId: 'codex-terra',
    reviewSubjectRef,
    reviewedHeadSha,
    acceptedSourceRef,
    acceptedRevision,
  });
  assert.equal(prepared.ok, true);
  const bound = await ctx.service.bindCurrentReviewer({
    handle: prepared.preparation.handle,
    scope: reviewerScope,
  });
  assert.equal(bound.ok, true);
  return prepared.preparation.handle;
}

describe('request-review actual-use receipts', () => {
  it('requires a prior reservation and refuses self review', async () => {
    const ctx = fixture();
    const missing = await ctx.service.recordLocalReview({
      handle: 'unguessable-but-unknown',
      scope: authorScope,
      reviewMessageId,
    });
    assert.deepEqual(missing, { ok: false, reason: 'reservation_not_found' });

    for (const scope of [
      { ...authorScope, ownerAuthProvenance: 'unknown' },
      { ...authorScope, originMessageId: undefined },
    ]) {
      assert.deepEqual(
        await ctx.service.prepare({
          scope,
          assetVersionRef,
          reviewerCatId: 'codex-terra',
          reviewSubjectRef,
          reviewedHeadSha,
          acceptedSourceRef,
          acceptedRevision,
        }),
        { ok: false, reason: 'author_origin_unverified' },
      );
    }

    const self = await ctx.service.prepare({
      scope: authorScope,
      assetVersionRef,
      reviewerCatId: authorScope.catId,
      reviewSubjectRef,
      reviewedHeadSha,
      acceptedSourceRef,
      acceptedRevision,
    });
    assert.deepEqual(self, { ok: false, reason: 'self_review' });
    assert.equal((await ctx.ledger.read()).length, 0);
  });

  it('binds the routed reviewer invocation and accepts changes_requested as applied use', async () => {
    const ctx = fixture();
    const handle = await prepareAndBind(ctx);
    const result = await ctx.service.recordLocalReview({ handle, scope: reviewerScope, reviewMessageId });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'recorded');
    assert.equal(result.receipt.use, 'applied');
    assert.deepEqual(result.receipt.assetVersionRef, assetVersionRef);
    assert.deepEqual(result.receipt.invocationRef, {
      ownerFeatureId: 'F299',
      ownerStateRef: `inv:${reviewerInvocationId}`,
    });
    assert.equal(result.receipt.consumerRef.ownerStateRef, 'consumer:request-review-local-review-v1');
  });

  it('rejects a mismatched reviewer invocation, subject, or typed message provenance', async () => {
    const ctx = fixture();
    const prepared = await ctx.service.prepare({
      scope: authorScope,
      assetVersionRef,
      reviewerCatId: 'codex-terra',
      reviewSubjectRef,
      reviewedHeadSha,
      acceptedSourceRef,
      acceptedRevision,
    });
    assert.equal(prepared.ok, true);
    ctx.invocations.set(reviewerInvocationId, {
      ...ctx.invocations.get(reviewerInvocationId),
      catId: 'codex-sol',
    });
    assert.deepEqual(
      await ctx.service.bindCurrentReviewer({
        handle: prepared.preparation.handle,
        scope: reviewerScope,
      }),
      { ok: false, reason: 'reviewer_invocation_mismatch' },
    );

    ctx.invocations.get(reviewerInvocationId).catId = 'codex-terra';
    const bound = await ctx.service.bindCurrentReviewer({
      handle: prepared.preparation.handle,
      scope: reviewerScope,
    });
    assert.equal(bound.ok, true);
    ctx.messages.set(
      reviewMessageId,
      localReviewMessage({
        extra: {
          ...localReviewMessage().extra,
          localReviewVerdict: {
            ...localReviewMessage().extra.localReviewVerdict,
            reviewSubjectRef: 'pr:owner/cat-cafe#9999',
          },
        },
      }),
    );
    assert.deepEqual(
      await ctx.service.recordLocalReview({
        handle: prepared.preparation.handle,
        scope: reviewerScope,
        reviewMessageId,
      }),
      { ok: false, reason: 'local_review_mismatch' },
    );

    ctx.messages.set(
      reviewMessageId,
      localReviewMessage({
        extra: {
          ...localReviewMessage().extra,
          localReviewVerdict: {
            ...localReviewMessage().extra.localReviewVerdict,
            reviewedHeadSha: 'e'.repeat(40),
          },
        },
      }),
    );
    assert.deepEqual(
      await ctx.service.recordLocalReview({
        handle: prepared.preparation.handle,
        scope: reviewerScope,
        reviewMessageId,
      }),
      { ok: false, reason: 'local_review_mismatch' },
      'the same subject cannot settle a different review target/source tuple',
    );
  });

  it('rejects a review carrier whose visible HEAD/source tuple differs from the reservation', async () => {
    const ctx = fixture();
    const prepared = await ctx.service.prepare({
      scope: authorScope,
      assetVersionRef,
      reviewerCatId: 'codex-terra',
      reviewSubjectRef,
      reviewedHeadSha,
      acceptedSourceRef,
      acceptedRevision,
    });
    assert.equal(prepared.ok, true);
    const request = ctx.messages.get(requestMessageId);
    request.content = request.content.replace(
      `Accepted-Revision: ${acceptedRevision}`,
      `Accepted-Revision: ${'f'.repeat(40)}`,
    );

    assert.deepEqual(
      await ctx.service.bindCurrentReviewer({ handle: prepared.preparation.handle, scope: reviewerScope }),
      { ok: false, reason: 'request_message_mismatch' },
    );
    assert.equal((await ctx.ledger.read()).filter((event) => event.type === 'use_dispatch_bound').length, 0);
  });

  it('uses the server-delivered bind-time revision rather than re-reading Git at settlement', async () => {
    let deliveryAvailable = true;
    const ctx = fixture({ attested: () => deliveryAvailable });
    const handle = await prepareAndBind(ctx);
    const binding = (await ctx.ledger.read()).find((event) => event.type === 'use_dispatch_bound');
    assert.deepEqual(binding.deliveredAssetVersionRef, assetVersionRef);
    assert.equal(binding.deliveryProofRef.ownerFeatureId, 'F100');
    deliveryAvailable = false;
    const result = await ctx.service.recordLocalReview({ handle, scope: reviewerScope, reviewMessageId });
    assert.equal(result.ok, true);
    assert.equal(result.receipt.use, 'applied');
  });

  it('retains unconfirmed when bind cannot deliver the selected mounted skill revision', async () => {
    const ctx = fixture({ attested: () => false });
    const handle = await prepareAndBind(ctx);
    const result = await ctx.service.recordLocalReview({ handle, scope: reviewerScope, reviewMessageId });
    assert.equal(result.ok, true);
    assert.equal(result.receipt.use, 'unconfirmed');
  });

  it('records an explicit reviewer dismissal without inferring a typed review fact', async () => {
    const ctx = fixture();
    const handle = await prepareAndBind(ctx);
    const dismissed = await ctx.service.dismiss({
      handle,
      scope: reviewerScope,
      reason: 'outside_local_review_scope',
    });
    assert.equal(dismissed.ok, true);
    assert.equal(dismissed.receipt.use, 'dismissed');
    const conflicting = await ctx.service.recordLocalReview({ handle, scope: reviewerScope, reviewMessageId });
    assert.equal(conflicting.ok, false);
    assert.equal(conflicting.reason, 'idempotency_collision');
  });

  it('replays the same durable terminal receipt through a reconstructed service', async () => {
    const ctx = fixture();
    const handle = await prepareAndBind(ctx);
    const first = await ctx.service.recordLocalReview({ handle, scope: reviewerScope, reviewMessageId });
    assert.equal(first.ok, true);

    const restarted = fixture({ ledger: ctx.ledger }).service;
    const replay = await restarted.recordLocalReview({ handle, scope: reviewerScope, reviewMessageId });
    assert.equal(replay.ok, true);
    assert.equal(replay.outcome, 'duplicate');
    assert.deepEqual(replay.receipt, first.receipt);
  });
});
