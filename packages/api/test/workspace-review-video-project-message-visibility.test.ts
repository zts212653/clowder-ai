import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deriveGrowingSourceMessageRevision,
  MessageStore,
} from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { VideoProjectReviewService } from '../src/domains/collaborative-content/workspace-review/video-project-review-service.js';
import { at, cat, contentRef, fixture, principal } from './workspace-review-video-project.fixture.js';

async function setup(recipients: string[] = ['astra']) {
  const f = await fixture();
  const messages = new MessageStore();
  const source = messages.append({
    userId: 'operator',
    from: { kind: 'user', userId: 'operator' },
    content: 'A private issue',
    mentions: [],
    threadId: 'thread-1',
    visibility: 'whisper',
    whisperTo: recipients as (typeof cat.actor.actorId)[],
    timestamp: Date.now(),
  });
  const messageAuthority = { messages, authorizeSource: async () => {} };
  const service = new VideoProjectReviewService({ store: f.store.ledgers, projects: f.projects, messageAuthority });
  const opened = await service.prepare({ principal, contentRef, operationId: 'prepare' });
  const marked = await service.annotate({
    principal,
    reviewId: opened.review.reviewId,
    expectedRevision: 1,
    operationId: 'mark',
    body: source.content,
    target: { kind: 'project' },
  });
  const annotation = marked.review.annotations[0];
  assert.ok(annotation);
  const frozen = await f.projects.load({ principal, contentRef });
  f.store.ledgers.mutate(
    {
      reviewId: opened.review.reviewId,
      expectedRevision: 2,
      operationId: 'seed-import-facts',
      actor: principal.actor,
      kind: 'test-seed-source',
      now: at,
      request: {},
    },
    (review) => ({
      ...review,
      revision: 3,
      annotations: review.annotations.map((item) => ({
        ...item,
        projectMessage: {
          source: {
            threadId: source.threadId,
            messageId: source.id,
            messageRevision: deriveGrowingSourceMessageRevision(source),
            attachmentId: 'attachment-1',
            selectionId: 'selection-1',
            visibility: 'whisper',
            whisperTo: recipients,
          },
          screeningId: 'screening-1',
          input: { contentRef, ownerRevision: 1, blobDigest: frozen.blobDigest },
          media: { contentRef: 'media-1', ownerRevision: 1, blobDigest: frozen.blobDigest },
          selection: { id: 'selection-1', mediaRange: { startPts: 0, endPts: 1 }, target: { kind: 'project' } },
        },
      })),
    }),
  );
  return { ...f, service, messages, source, reviewId: opened.review.reviewId, annotationId: annotation.id };
}

test('F326 a project-authorized Cat outside the frozen message audience cannot read body, locations or count', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const view = await f.service.read({ principal: cat, reviewId: f.reviewId });
  assert.equal(view.review.annotations.length, 0);
  assert.equal(view.annotationResolutions.length, 0);
  assert.ok(!JSON.stringify(view).includes('A private issue'));
  assert.ok(!JSON.stringify(view).includes(f.source.id));
});

test('F326 private message opinions do not leak by operation receipt or mutation response', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  assert.equal(await f.service.operationReceipt({ principal: cat, reviewId: f.reviewId, operationId: 'mark' }), null);
  await assert.rejects(
    f.service.act({
      principal: cat,
      reviewId: f.reviewId,
      expectedRevision: 3,
      operationId: 'reply',
      action: { kind: 'replied', annotationId: f.annotationId, replyId: 'reply-1', body: 'I should not know this' },
    }),
    { code: 'access_denied' },
  );
});

test('F326 revealing the source whisper does not widen its frozen ledger audience', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  await f.messages.revealWhispers('thread-1', 'operator');
  assert.equal((await f.service.read({ principal: cat, reviewId: f.reviewId })).review.annotations.length, 0);
  const human = await f.service.read({ principal, reviewId: f.reviewId });
  assert.equal(human.review.annotations.length, 1);
  assert.equal(human.review.annotations[0]?.projectMessage?.source.visibility, 'whisper');
});

for (const change of ['withdrawn', 'edited', 'narrowed'] as const)
  test(`F326 ${change} source narrows Cat access and retains Human history`, async (t) => {
    const f = await setup(['sol']);
    t.after(f.cleanup);
    assert.equal((await f.service.read({ principal: cat, reviewId: f.reviewId })).review.annotations.length, 1);
    const original = f.messages.getById(f.source.id);
    assert.ok(original);
    if (change === 'withdrawn') await f.messages.softDelete(original.id, 'operator');
    if (change === 'edited') original.content = 'Edited by Human';
    if (change === 'narrowed') original.whisperTo = [];
    assert.equal((await f.service.read({ principal: cat, reviewId: f.reviewId })).review.annotations.length, 0);
    assert.equal(await f.service.operationReceipt({ principal: cat, reviewId: f.reviewId, operationId: 'mark' }), null);
    const human = await f.service.read({ principal, reviewId: f.reviewId });
    assert.equal(human.review.annotations[0]?.body, 'A private issue');
    assert.equal(
      human.review.annotations[0]?.projectMessage?.sourceState,
      change === 'narrowed' ? 'current' : 'changed',
    );
  });

test('F326 public writes and idempotent mutation replays do not expose another whisper opinion', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const request = {
    principal: cat,
    reviewId: f.reviewId,
    expectedRevision: (await f.service.read({ principal: cat, reviewId: f.reviewId })).review.revision,
    operationId: 'public-comment',
    body: 'Public opinion',
    target: { kind: 'project' as const },
  };
  for (let i = 0; i < 2; i++) {
    const result = await f.service.annotate(request);
    assert.equal(result.review.annotations.length, 1);
    assert.equal(result.review.annotations[0]?.body, 'Public opinion');
    assert.ok(!JSON.stringify(result).includes('A private issue'));
  }
});

test('F326 a frozen recipient can reply with real Cat actor but source read permission does not grant mutation', async (t) => {
  const f = await setup(['sol']);
  t.after(f.cleanup);
  const readOnly = new VideoProjectReviewService({
    store: f.store.ledgers,
    projects: f.projects,
    messageAuthority: {
      messages: f.messages,
      authorizeSource: async ({ permission }) => {
        if (permission === 'write') throw new Error('Read-only source');
      },
    },
  });
  assert.equal((await readOnly.read({ principal: cat, reviewId: f.reviewId })).review.annotations.length, 1);
  await assert.rejects(
    readOnly.act({
      principal: cat,
      reviewId: f.reviewId,
      expectedRevision: 3,
      operationId: 'denied-reply',
      action: { kind: 'replied', annotationId: f.annotationId, replyId: 'denied', body: 'Cannot write' },
    }),
    { code: 'access_denied' },
  );
  const result = await f.service.act({
    principal: cat,
    reviewId: f.reviewId,
    expectedRevision: (await f.service.read({ principal: cat, reviewId: f.reviewId })).review.revision,
    operationId: 'reply',
    action: { kind: 'replied', annotationId: f.annotationId, replyId: 'reply-1', body: 'I can see the source' },
  });
  assert.deepEqual(result.review.annotations[0]?.replies?.[0]?.author, cat.actor);
  assert.deepEqual(result.review.annotations[0]?.projectHistory?.at(-1)?.actor, cat.actor);
});

for (const kind of ['located', 'replied', 'addressed', 'reopened', 'resolved'] as const)
  test(`F326 nonrecipient cannot ${kind} a frozen whisper or recover its receipt`, async (t) => {
    const f = await setup();
    t.after(f.cleanup);
    const base = await f.projects.load({ principal, contentRef });
    const action =
      kind === 'located'
        ? {
            kind,
            annotationId: f.annotationId,
            targets: [
              {
                kind: 'video-project' as const,
                baseOwnerRevision: base.ownerRevision,
                baseRevision: base.blobDigest,
                target: { kind: 'project' as const },
              },
            ],
          }
        : kind === 'replied'
          ? { kind, annotationId: f.annotationId, replyId: 'reply-1', body: 'Private access attempt' }
          : kind === 'addressed'
            ? { kind, annotationId: f.annotationId, result: { kind: 'not-changed' as const, reason: 'Attempt' } }
            : { kind, annotationId: f.annotationId, reason: 'Attempt' };
    await assert.rejects(
      f.service.act({
        principal: cat,
        reviewId: f.reviewId,
        expectedRevision: 3,
        operationId: `private-${kind}`,
        action,
      }),
      { code: 'access_denied' },
    );
    assert.equal(
      await f.service.operationReceipt({ principal: cat, reviewId: f.reviewId, operationId: `private-${kind}` }),
      null,
    );
    assert.equal(f.store.ledgers.get(f.reviewId)?.revision, 3);
  });

test('F326 unverified source authority fails closed while legacy direct opinions keep their project rules', async (t) => {
  const f = await setup(['sol']);
  t.after(f.cleanup);
  const unsafe = new VideoProjectReviewService({ store: f.store.ledgers, projects: f.projects });
  assert.equal((await unsafe.read({ principal, reviewId: f.reviewId })).review.annotations.length, 0);
  const revoked = new VideoProjectReviewService({
    store: f.store.ledgers,
    projects: f.projects,
    messageAuthority: {
      messages: f.messages,
      authorizeSource: async () => {
        throw new Error('Revoked');
      },
    },
  });
  assert.equal((await revoked.read({ principal, reviewId: f.reviewId })).review.annotations.length, 0);
});
