import assert from 'node:assert/strict';
import type { CatId } from '@cat-cafe/shared';
import type { InvocationRecord } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MemoryRequestReviewOwnerLedger } from '../../src/infrastructure/capability-evolution/adapters/request-review/request-review-owner-ledger.js';
import { readRecordedRequestReview } from '../../src/infrastructure/capability-evolution/adapters/request-review/request-review-provenance.js';
import { RequestReviewUseReceiptService } from '../../src/infrastructure/capability-evolution/adapters/request-review/request-review-use-receipt.js';
import type { createDevelopmentReturnFixture } from './development-return-fixture.js';

export async function reviewedExecution(
  f: Awaited<ReturnType<typeof createDevelopmentReturnFixture>>,
  unbound = false,
) {
  const humanMessageId = f.input.sourceActionRef.slice('message:'.length);
  const tuple = {
    reviewSubjectRef: `task:work:${f.input.taskId}`,
    reviewedHeadSha: 'b'.repeat(40),
    acceptedSourceRef: `${f.actor.threadId}#${humanMessageId}`,
    acceptedRevision: humanMessageId,
  };
  const ledger = new MemoryRequestReviewOwnerLedger();
  const invocations = new Map<string, InvocationRecord>();
  const receipts = new RequestReviewUseReceiptService({
    ledger,
    messageStore: f.messages,
    invocationRegistry: { peekRecord: async (id) => invocations.get(id) ?? null },
    versionAttestor: { deliver: async () => ({ status: 'unconfirmed' }) },
    now: () => new Date(f.service.now()).toISOString(),
  });
  f.service.deps.readReviewProvenance = (query) => readRecordedRequestReview(ledger, f.messages, query);
  const authorScope = {
    ...f.actor,
    invocationId: 'author-inv',
    ownerAuthProvenance: 'strict' as const,
    originMessageId: humanMessageId,
  };
  const prepared = await receipts.prepare({
    scope: authorScope,
    reviewerCatId: 'opus',
    ...tuple,
    assetVersionRef: {
      ownerFeatureId: 'F100',
      ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
      assetKind: 'skill',
      assetId: 'cat-cafe-skills/request-review/SKILL.md',
      version: 'a'.repeat(64),
    },
  });
  assert.ok(prepared.ok);
  const handle = prepared.preparation.handle;
  const request = f.messages.append({
    ...f.actor,
    catId: f.actor.catId as CatId,
    content: [
      `Review-Subject-Ref: ${tuple.reviewSubjectRef}`,
      `Reviewed-Head-Sha: ${tuple.reviewedHeadSha}`,
      `Request-Review-Consumption-Handle: ${handle}`,
      `Accepted-Source-Ref: ${tuple.acceptedSourceRef}`,
      `Accepted-Revision: ${tuple.acceptedRevision}`,
    ].join('\n'),
    mentions: ['opus'],
    timestamp: f.service.now(),
    extra: { stream: { invocationId: 'author-inv' } },
  });
  const reviewerScope = { ...f.actor, catId: 'opus', invocationId: 'reviewer-inv' };
  invocations.set('reviewer-inv', {
    ...reviewerScope,
    catId: 'opus' as CatId,
    callbackToken: 'test',
    ownerAuthProvenance: 'strict',
    originTriggerMessageId: request.id,
    clientMessageIds: new Set(),
    createdAt: f.service.now(),
    expiresAt: null,
    state: 'active',
  });
  if (!unbound) assert.ok((await receipts.bindCurrentReviewer({ handle, scope: reviewerScope })).ok);
  const review = f.messages.append({
    userId: f.actor.userId,
    threadId: f.actor.threadId,
    catId: 'opus',
    content: 'Plan approved; execution and product acceptance remain outstanding.',
    mentions: [],
    timestamp: f.service.now(),
    extra: {
      stream: { invocationId: 'reviewer-inv' },
      localReviewVerdict: {
        ...tuple,
        verdict: 'approved',
        clientMessageId: 'independent-plan-review',
      },
    },
  });
  if (!unbound)
    assert.ok((await receipts.recordLocalReview({ handle, scope: reviewerScope, reviewMessageId: review.id })).ok);
  const proposal = f.proposals.create({
    sourceThreadId: f.actor.threadId,
    sourceCatId: f.actor.catId,
    sourceInvocationId: 'after-review',
    sourceMessageId: review.id,
    title: 'Execute the reviewed work',
    reason: 'Original owner continues the authorized Task after plan review',
    parentThreadId: f.actor.threadId,
    preferredCats: [f.actor.catId],
    projectPath: process.cwd(),
    createdBy: f.actor.userId,
    reportingMode: 'final-only',
  });
  const child = f.threads.create(f.actor.userId, 'Execution', process.cwd(), f.actor.threadId, {
    createdFromProposalId: proposal.proposalId,
    sourceThreadId: f.actor.threadId,
    approvedBy: f.actor.userId,
    approvedAt: f.service.now(),
  });
  f.proposals.claimForApproval({ proposalId: proposal.proposalId, approvedBy: f.actor.userId });
  f.proposals.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: child.id });
  return {
    review,
    request,
    ledger,
    receipts,
    handle,
    reviewerScope,
    proposal,
    child,
    input: { ...f.input, executionThreadId: child.id, sourceActionRef: `message:${review.id}` },
  };
}
