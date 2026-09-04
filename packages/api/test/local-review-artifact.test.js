import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { classifyLocalReviewLoopBrake, readDurableLocalReviewFact } = await import(
  '../dist/domains/cats/services/local-review-artifact.js'
);

const SOURCE_REF = 'docs/features/F314-development-episode-alignment-experiment.md';
const SOURCE_REVISION = 'a'.repeat(40);
const REVIEW_SUBJECT_REF = 'pr:zts212653/cat-cafe#4255';

function reviewMessage({
  id,
  reviewerCatId = 'opus5',
  verdict = 'changes_requested',
  reviewedHeadSha = 'b'.repeat(40),
  acceptedRevision = SOURCE_REVISION,
  reviewSubjectRef = REVIEW_SUBJECT_REF,
} = {}) {
  return {
    id,
    threadId: 'thread-f314-review',
    userId: 'user-1',
    catId: reviewerCatId,
    content: 'P1 — AC-B2: the accepted source moved.',
    mentions: ['codex-sol'],
    timestamp: Number(id?.replace(/\D/g, '') || 1),
    extra: {
      localReviewVerdict: {
        verdict,
        clientMessageId: `review-${id}`,
        reviewedHeadSha,
        reviewSubjectRef,
        acceptedSourceRef: SOURCE_REF,
        acceptedRevision,
      },
    },
  };
}

describe('F314 durable local-review artifact', () => {
  it('reads one accepted-source-anchored fact without lease or coordination state', () => {
    const message = reviewMessage({ id: 'message-1' });
    assert.deepEqual(readDurableLocalReviewFact(message), {
      messageId: 'message-1',
      threadId: 'thread-f314-review',
      reviewerCatId: 'opus5',
      reviewSubjectRef: REVIEW_SUBJECT_REF,
      acceptedSourceRef: SOURCE_REF,
      acceptedRevision: SOURCE_REVISION,
      reviewedHeadSha: 'b'.repeat(40),
      verdict: 'changes_requested',
      clientMessageId: 'review-message-1',
      evidenceRef: 'local-review:message-1:changes_requested',
    });
    assert.equal('leaseId' in message.extra.localReviewVerdict, false);
    assert.equal('generation' in message.extra.localReviewVerdict, false);
    assert.equal('reviewReentry' in message.extra.localReviewVerdict, false);
  });

  it('pauses only on the arrival that crosses four formal non-author changes-requested facts', () => {
    const history = [1, 2, 3, 4].map((n) => readDurableLocalReviewFact(reviewMessage({ id: `message-${n}` })));
    assert.equal(history.every(Boolean), true);

    assert.deepEqual(classifyLocalReviewLoopBrake(history, ['message-4'], REVIEW_SUBJECT_REF, 'codex-sol'), {
      kind: 'pause_once',
      formalChangesRequested: 4,
    });
    assert.deepEqual(classifyLocalReviewLoopBrake(history, [], REVIEW_SUBJECT_REF, 'codex-sol'), {
      kind: 'continue',
      formalChangesRequested: 4,
    });

    const fifth = readDurableLocalReviewFact(reviewMessage({ id: 'message-5' }));
    assert.ok(fifth);
    assert.deepEqual(
      classifyLocalReviewLoopBrake([...history, fifth], ['message-5'], REVIEW_SUBJECT_REF, 'codex-sol'),
      { kind: 'continue', formalChangesRequested: 5 },
    );
  });

  it('ignores author verdicts and warns open when durable history is unavailable', () => {
    const authorFact = readDurableLocalReviewFact(reviewMessage({ id: 'message-author', reviewerCatId: 'codex-sol' }));
    assert.ok(authorFact);
    assert.deepEqual(classifyLocalReviewLoopBrake([authorFact], ['message-author'], REVIEW_SUBJECT_REF, 'codex-sol'), {
      kind: 'continue',
      formalChangesRequested: 0,
    });
    assert.deepEqual(classifyLocalReviewLoopBrake(null, [], REVIEW_SUBJECT_REF, 'codex-sol'), {
      kind: 'warn_open',
      reason: 'durable local-review history unavailable',
    });
  });
});
