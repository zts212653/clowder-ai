import assert from 'node:assert/strict';
import { sharedProposal } from './collective-artifact-proposal.fixture.js';
import { custodyHttpFixture } from './collective-custody-http.fixture.js';
import { test } from './helpers/f202-collective-installed-business.js';

async function seedAnnotation(f: Awaited<ReturnType<typeof custodyHttpFixture>>) {
  const message = await f.store.postHumanMessage(f.member.sessionToken, {
    ...f.coordinates,
    clientEventId: 'first-public-comment',
    body: '这一处需要说明。',
    recipient: { kind: 'channel' },
    replyToEventId: f.source.eventId,
    location: { channelId: 'general', rootEventId: f.source.eventId },
  });
  const result = await f.invoke(
    f.member.sessionToken,
    'annotate',
    {
      kind: 'annotate',
      messageEventId: message.eventId,
      quote: '共同阅读',
      expectedReviewRevision: 1,
    },
    'seed-review-comment',
  );
  assert.equal(result.status, 200, JSON.stringify(result));
  return { message, annotation: result.value.value.view.review.annotations[0] };
}

test('two authenticated Humans reply and resolve through the canonical ledger, recover one reply after reopen and preserve it through custody', async (t) => {
  const f = await custodyHttpFixture(t);
  const { message, annotation } = await seedAnnotation(f);
  const reply = await f.store.postHumanMessage(f.owner.sessionToken, {
    ...f.coordinates,
    clientEventId: 'reply-in-original-topic',
    body: '说明已补充，先确认这处理解。',
    recipient: { kind: 'human', humanId: f.member.human.humanId },
    replyToEventId: message.eventId,
    location: { channelId: 'general', rootEventId: f.source.eventId },
  });
  const input = {
    kind: 'review-action',
    expectedReviewRevision: 2,
    action: { kind: 'reply', annotationId: annotation.id, messageEventId: reply.eventId },
  };
  const first = await f.invoke(f.owner.sessionToken, 'annotate', input, 'reply-original-operation');
  assert.equal(first.status, 200, JSON.stringify(first));
  await f.restartSource();
  await f.restartService();
  const replay = await f.invoke(f.owner.sessionToken, 'annotate', input, 'reply-original-operation');
  assert.deepEqual(replay.value.value.receipt, { ...first.value.value.receipt, replayed: true });
  const equivalent = await f.invoke(
    f.owner.sessionToken,
    'annotate',
    { ...input, expectedReviewRevision: 3 },
    'same-message-new-transport',
  );
  assert.equal(equivalent.status, 200, JSON.stringify(equivalent));
  const read = await f.invoke(f.member.sessionToken, 'read', { annotationId: annotation.id }, 'read-reply-page');
  const review = read.value.value.view.review;
  assert.equal(review.annotations[0].replies.length, 1);
  assert.equal(review.annotations[0].replies[0].body, reply.body);
  assert.deepEqual(review.annotations[0].replies[0].author, { kind: 'human', actorId: f.owner.human.humanId });
  assert.equal(JSON.stringify(read).includes('real-local-owner'), false);
  const resolution = {
    kind: 'review-action',
    expectedReviewRevision: review.revision,
    action: { kind: 'set_annotation_state', annotationId: annotation.id, state: 'resolved' },
  };
  const resolved = await f.invoke(f.member.sessionToken, 'annotate', resolution, 'resolve-review-comment');
  assert.equal(resolved.status, 200, JSON.stringify(resolved));
  assert.equal((await f.invoke(f.owner.sessionToken, 'annotate', resolution, 'stale-review-CAS')).status, 409);
  const offered = await f.post('custody/offer', f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    targetHumanId: f.member.human.humanId,
    expectedCustodyRevision: 1,
    requestId: 'transfer-review-discussion',
  });
  assert.equal(offered.status, 201);
  await f.drive(() => {
    const transfer = f.store.readArtifactCustody(f.targetCredential, {
      ...f.coordinates,
      artifactId: f.artifact.artifactId,
      connectionId: f.target.connectionId,
      transferId: offered.value.handoffRef,
    });
    return transfer.state === 'committed' && transfer.sourceFinalized && transfer.targetFinalized;
  });
  await f.restartTarget();
  const retained = await f.invoke(
    f.member.sessionToken,
    'read',
    { annotationId: annotation.id },
    'read-transferred-review',
  );
  assert.equal(retained.value.value.view.review.annotations[0].state, 'resolved');
  assert.deepEqual(retained.value.value.view.review.annotations[0].replies, review.annotations[0].replies);
});

test('a reply cannot borrow another Human message or another discussion, self-report its body, change its parent, or replay after revoke', async (t) => {
  const f = await custodyHttpFixture(t);
  const { message, annotation } = await seedAnnotation(f);
  const base = {
    kind: 'review-action',
    expectedReviewRevision: 2,
    action: { kind: 'reply', annotationId: annotation.id, messageEventId: message.eventId },
  };
  assert.equal((await f.invoke(f.owner.sessionToken, 'annotate', base, 'foreign-Human-message')).status, 403);
  const wrongParent = await f.store.postHumanMessage(f.owner.sessionToken, {
    ...f.coordinates,
    clientEventId: 'not-annotation-parent',
    body: '另一条回复。',
    recipient: { kind: 'channel' },
    replyToEventId: f.source.eventId,
    location: { channelId: 'general', rootEventId: f.source.eventId },
  });
  const wrong = { ...base, action: { ...base.action, messageEventId: wrongParent.eventId } };
  assert.equal((await f.invoke(f.owner.sessionToken, 'annotate', wrong, 'wrong-annotation-parent')).status, 403);
  const unrelated = await f.store.postHumanMessage(f.owner.sessionToken, {
    ...f.coordinates,
    clientEventId: 'unrelated-discussion',
    body: '另一件事。',
    recipient: { kind: 'channel' },
    location: { channelId: 'general' },
  });
  assert.equal(
    (
      await f.invoke(
        f.owner.sessionToken,
        'annotate',
        { ...base, action: { ...base.action, messageEventId: unrelated.eventId } },
        'cross-Topic-reply',
      )
    ).status,
    403,
  );
  const forged = { ...base, action: { ...base.action, body: 'forged' } };
  assert.equal((await f.invoke(f.member.sessionToken, 'annotate', forged, 'forged-body')).status, 400);
  const state = {
    kind: 'review-action',
    expectedReviewRevision: 2,
    action: { kind: 'set_annotation_state', annotationId: annotation.id, state: 'resolved' },
  };
  assert.equal((await f.invoke(f.member.sessionToken, 'annotate', state, 'member-resolution')).status, 200);
  await f.store.updateArtifactAccess(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    humanId: f.member.human.humanId,
    expectedAccessRevision: 1,
    access: 'revoked',
    requestId: 'revoke-review-writer',
  });
  assert.equal((await f.invoke(f.member.sessionToken, 'annotate', state, 'member-resolution')).status, 403);
  assert.equal((await f.invoke(f.owner.sessionToken, 'read', {}, 'remaining-reader')).status, 200);
});

test('Service issues a narrow historical reply capability without allowing old annotations, state changes or browser-supplied authority', async (t) => {
  const f = await custodyHttpFixture(t);
  const { message, annotation } = await seedAnnotation(f);
  const proposal = await sharedProposal(f);
  assert.equal((await f.invoke(f.owner.sessionToken, 'apply', proposal, 'adopt-before-history-reply')).status, 200);
  const current = await f.invoke(f.owner.sessionToken, 'read', {}, 'current-ledger-before-history-reply');
  const revision = current.value.value.view.review.revision;
  const reply = await f.store.postHumanMessage(f.owner.sessionToken, {
    ...f.coordinates,
    clientEventId: 'reply-after-adoption',
    body: '在旧版批注下继续讨论。',
    recipient: { kind: 'channel' },
    replyToEventId: message.eventId,
    location: { channelId: 'general', rootEventId: f.source.eventId },
  });
  const command = {
    kind: 'review-action',
    expectedReviewRevision: revision,
    action: { kind: 'reply', annotationId: annotation.id, messageEventId: reply.eventId },
  };
  const result = await f.invoke(
    f.owner.sessionToken,
    'annotate',
    command,
    'historical-reply-through-service',
    undefined,
    1,
  );
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.value.value.ownerRevision, 1);
  const oldState = {
    kind: 'review-action',
    expectedReviewRevision: revision + 1,
    action: { kind: 'set_annotation_state', annotationId: annotation.id, state: 'resolved' },
  };
  assert.equal(
    (await f.invoke(f.owner.sessionToken, 'annotate', oldState, 'old-version-state-denied', undefined, 1)).status,
    409,
  );
  assert.equal(
    (
      await f.invoke(
        f.member.sessionToken,
        'annotate',
        { kind: 'annotate', messageEventId: message.eventId, quote: '共同阅读', expectedReviewRevision: revision + 1 },
        'old-version-annotation-denied',
        undefined,
        1,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.post('constraints', f.owner.sessionToken, {
        ...f.coordinates,
        artifactId: f.artifact.artifactId,
        sourceEventId: f.source.eventId,
        action: 'annotate',
        ownerRevision: 1,
        reviewReply: command.action,
      })
    ).status,
    400,
  );
});
