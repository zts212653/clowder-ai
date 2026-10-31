import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { validateCollectiveArtifactCustodyBundle } from '../src/domains/collaborative-content/collective-artifact/custody-bundle.js';
import { collectiveContentScopeRef } from '../src/domains/video-studio/content-owner/collective-scope.js';
import { baseConstraint, digest, fixture, scope, text } from './collective-markdown.fixture.js';

test('scoped modifications preserve Cat proposals and accepted receipts across real local owner rebinding', async (t) => {
  const f = await fixture(t);
  const annotated = await f.execute(
    { ...baseConstraint, action: 'annotate' },
    {
      kind: 'annotate',
      messageEventId: 'comment-for-custody',
      body: 'Please clarify.',
      quote: 'A unique shared quote.',
      location: { channelId: 'general', rootEventId: scope.sourceEventId },
      expectedReviewRevision: 1,
    },
    'custody-note',
  );
  if (annotated.status !== 'ok') throw new Error('Expected annotation');
  const review = annotated.value.view.review;
  const requested = await f.execute(
    { ...baseConstraint, action: 'propose' },
    {
      kind: 'request-modification',
      messageEventId: 'ask-for-custody',
      annotationIds: [review.annotations[0].id],
      expectedReviewRevision: review.revision,
      instruction: 'Clarify the phrase.',
      location: { channelId: 'general', rootEventId: scope.sourceEventId },
      target: { humanId: 'human-bob', catId: 'codex61-sol', connectionId: 'connection-bob', participationRevision: 1 },
    },
    'custody-ask',
  );
  if (requested.status !== 'ok') throw new Error(f.errors.map(String).join('\n'));
  const requestId = requested.value.request.requestId;
  const agent = {
    requestEventId: 'ask-for-custody',
    catId: 'codex61-sol',
    humanId: 'human-bob',
    connectionId: 'connection-bob',
    participationRevision: 1,
    membershipRevision: 1,
    revocationEpoch: 1,
  };
  const command = {
    kind: 'respond-modification',
    requestId,
    operationId: '00000000-0000-4000-8000-000000000019',
    expectedOwnerRevision: 1,
    expectedProposalRevision: 0,
    baseRevision: digest,
    edits: [
      { start: text.indexOf('unique'), end: text.indexOf('unique') + 6, expectedText: 'unique', replacement: 'clear' },
    ],
    response: 'Clarified.',
  };
  const proposed = await f.execute({ ...baseConstraint, action: 'propose', agent }, command, 'custody-cat');
  if (proposed.status !== 'ok') throw new Error(f.errors.map(String).join('\n'));
  const scopeRef = collectiveContentScopeRef(scope);
  const preparedBundle = {
    v: 1,
    content: await f.owner.collectiveCustody.exportSnapshot(scope.contentRef, scopeRef),
    review: f.reviews.collectiveCustody.exportSnapshot(scope.contentRef, scopeRef),
    modifications: f.modifications.collectiveCustody.exportSnapshot(scopeRef, scope.contentRef),
  };
  assert.equal(
    validateCollectiveArtifactCustodyBundle(preparedBundle, scopeRef, scope.contentRef).modifications.requests[0].state,
    'proposal_ready',
  );
  const wrongCandidate = structuredClone(preparedBundle);
  wrongCandidate.modifications.proposals[0].proposal.resultRevision = `sha256:${'f'.repeat(64)}`;
  assert.throws(
    () => validateCollectiveArtifactCustodyBundle(wrongCandidate, scopeRef, scope.contentRef),
    /proposal bytes mismatch/,
  );
  const active = structuredClone(preparedBundle);
  active.modifications.requests[0].state = 'running';
  assert.throws(
    () => validateCollectiveArtifactCustodyBundle(active, scopeRef, scope.contentRef),
    /execution is active/,
  );
  const selected = { requestId, proposalRef: proposed.value.proposal.proposalRef };
  const accepted = await f.execute({ ...baseConstraint, action: 'apply' }, selected, 'custody-adopt');
  assert.equal(accepted.status, 'ok');
  const snapshot = f.modifications.collectiveCustody.exportSnapshot(scopeRef, scope.contentRef);
  const bundle = {
    v: 1,
    content: await f.owner.collectiveCustody.exportSnapshot(scope.contentRef, scopeRef),
    review: f.reviews.collectiveCustody.exportSnapshot(scope.contentRef, scopeRef),
    modifications: snapshot,
  };
  assert.equal(
    validateCollectiveArtifactCustodyBundle(bundle, scopeRef, scope.contentRef).content.manifest.currentOwnerRevision,
    2,
  );
  const wrongHistory = structuredClone(bundle);
  assert.ok(wrongHistory.review);
  wrongHistory.review.review.source = { ...wrongHistory.review.review.source, ownerRevision: 999 };
  assert.throws(() => validateCollectiveArtifactCustodyBundle(wrongHistory, scopeRef, scope.contentRef));
  const wrongQuote = structuredClone(bundle);
  assert.ok(wrongQuote.review);
  wrongQuote.review.review.annotations[0].anchor.quote = 'Forged source';
  assert.throws(() => validateCollectiveArtifactCustodyBundle(wrongQuote, scopeRef, scope.contentRef));
  const missingEffect = structuredClone(bundle);
  missingEffect.modifications.dispositions = [];
  assert.throws(() => validateCollectiveArtifactCustodyBundle(missingEffect, scopeRef, scope.contentRef));
  const disposition = snapshot.dispositions[0];
  assert.equal(disposition.state, 'accepted');
  const pending = structuredClone(bundle);
  pending.modifications.requests[0].state = 'proposal_ready';
  pending.modifications.dispositions = [
    { kind: 'collective-artifact', intent: disposition.intent, createdAt: disposition.createdAt, state: 'pending' },
  ];
  assert.throws(() => validateCollectiveArtifactCustodyBundle(pending, scopeRef, scope.contentRef), /not reconciled/);
  const falseAbsence = structuredClone(pending);
  falseAbsence.modifications.dispositions = [
    {
      kind: 'collective-artifact',
      intent: disposition.intent,
      createdAt: disposition.createdAt,
      state: 'failed',
      failedAt: Date.now(),
      reason: 'owner_effect_absent',
    },
  ];
  assert.throws(
    () => validateCollectiveArtifactCustodyBundle(falseAbsence, scopeRef, scope.contentRef),
    /failed disposition has an owner effect/,
  );
  assert.equal(snapshot.requests.length, 1);
  assert.equal(snapshot.proposals.length, 1);
  assert.equal(snapshot.dispositions.length, 1);
  const dir = await mkdtemp(join(tmpdir(), 'f290-custody-journal-'));
  let target = new ArtifactReviewStore(join(dir, 'target.sqlite'));
  t.after(async () => {
    target.close();
    await rm(dir, { recursive: true, force: true });
  });
  target.collectiveCustody.installSnapshot(snapshot, scopeRef, scope.contentRef, 'target-real-local-owner');
  target.collectiveCustody.installSnapshot(snapshot, scopeRef, scope.contentRef, 'target-real-local-owner');
  target.close();
  target = new ArtifactReviewStore(join(dir, 'target.sqlite'));
  assert.throws(
    () =>
      target.collectiveCustody.assertTargetAvailable(snapshot, scopeRef, scope.contentRef, 'target-real-local-owner'),
    /collision/,
  );
  const restored = target.requests.collective.get(requestId, scopeRef);
  assert.equal(restored?.ownerUserId, 'target-real-local-owner');
  assert.deepEqual(restored?.target, snapshot.requests[0].target);
  assert.deepEqual(target.text.latestProposal(requestId), f.modifications.text.latestProposal(requestId));
  assert.deepEqual(
    target.acceptances.collective.winner(requestId, scopeRef)?.receipt,
    f.modifications.acceptances.collective.winner(requestId, scopeRef)?.receipt,
  );
  assert.equal(target.text.source(requestId), null);
  target.requests.collective.reserve({
    ownerUserId: 'target-real-local-owner',
    requestingHumanId: snapshot.requests[0].requestingHumanId,
    target: snapshot.requests[0].target,
    instruction: 'A different Collective discussion',
    annotationIds: snapshot.requests[0].annotationIds,
    source: {
      ...snapshot.requests[0].source,
      scopeRef: 'another-scope',
      contentRef: 'another-content',
      requestEventId: 'another-event',
    },
  });
  assert.equal(target.collectiveCustody.exportSnapshot(scopeRef, scope.contentRef).requests.length, 1);
  const corrupt = structuredClone(snapshot);
  corrupt.proposals[0].fingerprint = 'f'.repeat(64);
  assert.throws(() => target.collectiveCustody.validateSnapshot(corrupt, scopeRef, scope.contentRef));
  const privateRecord = {
    ...snapshot,
    requests: [
      { ...snapshot.requests[0], execution: { threadId: 'private-thread', invocationId: 'private-execution' } },
    ],
  };
  assert.throws(() => target.collectiveCustody.validateSnapshot(privateRecord, scopeRef, scope.contentRef));
  assert.throws(() => target.collectiveCustody.validateSnapshot(snapshot, 'another-scope', scope.contentRef));
});
