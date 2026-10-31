import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectCommandJsonPage } from '../src/domains/collaborative-content/modification/project/json-page.js';
import { visibleProjectReview } from '../src/domains/collaborative-content/workspace-review/project-message/audience.js';
import { VideoProjectReviewService } from '../src/domains/collaborative-content/workspace-review/video-project-review-service.js';
import { videoProjectLedgerSource } from '../src/domains/collaborative-content/workspace-review/video-project-review-source.js';
import { cat, principal } from './workspace-review-video-project.fixture.js';
import { setup } from './workspace-review-video-project-audience.fixture.js';

for (const kind of ['read', 'write-replay', 'receipt'] as const)
  test(`F326 audience ${kind} hides private revision, activity timestamp and source metadata`, async (t) => {
    const f = await setup();
    t.after(f.cleanup);
    const before = await f.service.read({ principal: cat, reviewId: f.reviewId });
    assert.equal(before.review.revision, 1);
    assert.equal(
      await f.service.operationReceipt({ principal: cat, reviewId: f.reviewId, operationId: 'seed-import-facts' }),
      null,
    );
    const request = {
      principal: cat,
      reviewId: f.reviewId,
      expectedRevision: before.review.revision,
      operationId: 'public',
      body: 'A public opinion',
      target: { kind: 'project' as const },
    };
    const publicResult = kind === 'read' ? undefined : await f.service.annotate(request);
    const visible = await f.service.read({ principal: cat, reviewId: f.reviewId });
    const human = await f.service.read({ principal, reviewId: f.reviewId });
    await f.service.act({
      principal,
      reviewId: f.reviewId,
      expectedRevision: human.review.revision,
      operationId: 'private-reply',
      action: { kind: 'replied', annotationId: f.annotationId, replyId: 'private-reply', body: 'Private follow-up' },
    });
    const after = await f.service.read({ principal: cat, reviewId: f.reviewId });
    assert.deepEqual(after.review, visible.review);
    assert.equal(
      await f.service.operationReceipt({ principal: cat, reviewId: f.reviewId, operationId: 'private-reply' }),
      null,
    );
    if (publicResult) {
      const replay = await f.service.annotate(request);
      assert.equal(replay.review.revision, visible.review.revision);
      assert.equal(replay.receipt.revision, publicResult.receipt.revision);
      const receipt = await f.service.operationReceipt({ principal: cat, reviewId: f.reviewId, operationId: 'public' });
      assert.equal(receipt?.revision, publicResult.receipt.revision);
      assert.ok(!JSON.stringify(replay).includes('Private follow-up'));
    }
    f.reopen();
    const restored = new VideoProjectReviewService({
      store: f.store.ledgers,
      projects: f.projects,
      messageAuthority: { messages: f.messages, authorizeSource: async () => {} },
    });
    assert.deepEqual((await restored.read({ principal: cat, reviewId: f.reviewId })).review, after.review);
  });

test('F326 a hidden mutation racing a public Cat write changes no audience CAS and commits once', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const before = await f.service.read({ principal: cat, reviewId: f.reviewId });
  const mutate = f.store.ledgers.mutate.bind(f.store.ledgers);
  let injected = false;
  f.store.ledgers.mutate = (input, transition) => {
    if (input.actor.kind === 'cat' && !injected) {
      injected = true;
      const current = f.store.ledgers.get(f.reviewId);
      assert.ok(current);
      mutate(
        {
          ...input,
          expectedRevision: current.revision,
          actor: principal.actor,
          operationId: 'hidden-race',
          kind: 'test-hidden-race',
          request: {},
        },
        (review) => ({
          ...review,
          revision: review.revision + 1,
          updatedAt: '2026-10-10T18:00:00.000Z',
          annotations: review.annotations.map((item) =>
            item.id === f.annotationId ? { ...item, updatedAt: '2026-10-10T18:00:00.000Z' } : item,
          ),
        }),
      );
    }
    return mutate(input, transition);
  };
  const result = await f.service.annotate({
    principal: cat,
    reviewId: f.reviewId,
    expectedRevision: before.review.revision,
    operationId: 'public-race',
    body: 'Public after private',
    target: { kind: 'project' },
  });
  assert.equal(result.review.revision, before.review.revision + 1);
  assert.equal(result.review.annotations.length, 1);
  assert.equal(result.receipt.revision, result.review.revision);
  assert.equal(
    f.store.ledgers.get(f.reviewId)?.annotations.filter((item) => item.operationId === 'public-race').length,
    1,
  );
});

test('F326 an actually visible competing mutation still fences stale audience CAS', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const before = await f.service.read({ principal: cat, reviewId: f.reviewId });
  await f.service.annotate({
    principal: cat,
    reviewId: f.reviewId,
    expectedRevision: before.review.revision,
    operationId: 'first',
    body: 'First public opinion',
    target: { kind: 'project' },
  });
  await assert.rejects(
    f.service.annotate({
      principal: cat,
      reviewId: f.reviewId,
      expectedRevision: before.review.revision,
      operationId: 'stale',
      body: 'Stale public opinion',
      target: { kind: 'project' },
    }),
    { code: 'revision_conflict' },
  );
  assert.equal(
    f.store.ledgers.get(f.reviewId)?.annotations.some((item) => item.operationId === 'stale'),
    false,
  );
});

test('F326 hidden metadata cannot invalidate a Cat JSON page or choose its default owner input', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const opened = await f.service.read({ principal: cat, reviewId: f.reviewId });
  await f.service.annotate({
    principal: cat,
    reviewId: f.reviewId,
    expectedRevision: opened.review.revision,
    operationId: 'long-public',
    body: 'Public opinion '.repeat(500),
    target: { kind: 'project' },
  });
  const before = await f.service.read({ principal: cat, reviewId: f.reviewId });
  const page = projectCommandJsonPage('request', 'project-review', { cursor: 0 }, before);
  assert.ok(page.nextCursor);
  const canonical = f.store.ledgers.get(f.reviewId);
  assert.ok(canonical);
  const hiddenSource = { ...canonical.source, ownerRevision: 999 };
  f.store.ledgers.mutate(
    {
      reviewId: f.reviewId,
      expectedRevision: canonical.revision,
      operationId: 'hidden-metadata',
      actor: principal.actor,
      kind: 'test-hidden-metadata',
      now: '2026-10-10T18:00:00.000Z',
      request: {},
    },
    (review) => ({
      ...review,
      revision: review.revision + 1,
      updatedAt: '2026-10-10T18:00:00.000Z',
      source: hiddenSource,
      sourceHistory: [hiddenSource, ...(review.sourceHistory ?? [])],
    }),
  );
  const after = await f.service.read({ principal: cat, reviewId: f.reviewId });
  assert.deepEqual(
    after,
    before,
    'An unavailable private frozen input must not choose Cat source/capability or timing',
  );
  const second = projectCommandJsonPage(
    'request',
    'project-review',
    {
      cursor: page.nextCursor,
      expectedSnapshot: page.snapshot,
    },
    after,
  );
  assert.equal(second.snapshot, page.snapshot);
  assert.ok(!JSON.stringify(after.review.sourceHistory).includes('999'));
});

test('F326 current source revocation advances only the affected audience projection without a ledger write', async (t) => {
  const f = await setup(['sol']);
  t.after(f.cleanup);
  const before = await f.service.read({ principal: cat, reviewId: f.reviewId });
  const canonicalRevision = f.store.ledgers.get(f.reviewId)?.revision;
  const original = f.messages.getById(f.source.id);
  assert.ok(original);
  original.whisperTo = [];
  const after = await f.service.read({ principal: cat, reviewId: f.reviewId });
  assert.equal(after.review.annotations.length, 0);
  assert.equal(after.review.revision, before.review.revision + 1);
  assert.equal(f.store.ledgers.get(f.reviewId)?.revision, canonicalRevision);
  assert.equal(await f.service.operationReceipt({ principal: cat, reviewId: f.reviewId, operationId: 'mark' }), null);
});

test('F326 source history output is independent of hidden canonical insertion order', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const canonical = f.store.ledgers.get(f.reviewId);
  assert.ok(canonical);
  const original = await f.projects.load({ principal, contentRef: canonical.contentRef });
  const changed = structuredClone(original.document);
  changed.title = 'Public second input';
  const saved = await f.projects.save(changed, 'public-input-two');
  const head = await f.projects.load({ principal, contentRef: canonical.contentRef });
  const sourceOne = videoProjectLedgerSource(original),
    sourceTwo = videoProjectLedgerSource(head);
  const selected = canonical.annotations[0];
  assert.ok(selected);
  const annotation = { ...selected, projectMessage: undefined };
  const a = visibleProjectReview(
    { ...canonical, sourceHistory: [sourceOne, sourceTwo] },
    [annotation],
    sourceTwo,
    original.document.origin.at,
  );
  const b = visibleProjectReview(
    { ...canonical, sourceHistory: [sourceTwo, sourceOne] },
    [annotation],
    sourceTwo,
    original.document.origin.at,
  );
  assert.deepEqual(a, b);
  assert.equal(saved.ownerRevision, 2);
});

test('F326 projection and scoped receipt failure rolls back the actual canonical operation', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const before = await f.service.read({ principal: cat, reviewId: f.reviewId });
  const canonical = f.store.ledgers.get(f.reviewId);
  f.store.ledgers.projectAudiences.receipt = () => {
    throw new Error('Scoped receipt unavailable');
  };
  await assert.rejects(
    f.service.annotate({
      principal: cat,
      reviewId: f.reviewId,
      expectedRevision: before.review.revision,
      operationId: 'rolled-back',
      body: 'Never committed',
      target: { kind: 'project' },
    }),
    /Scoped receipt unavailable/,
  );
  assert.deepEqual(f.store.ledgers.get(f.reviewId), canonical);
  assert.equal(f.store.ledgers.operationReceipt(f.reviewId, 'rolled-back'), null);
  assert.deepEqual((await f.service.read({ principal: cat, reviewId: f.reviewId })).review, before.review);
});

test('F326 source narrowing during awaited action validation grants no private write', async (t) => {
  const f = await setup(['sol']);
  t.after(f.cleanup);
  const before = await f.service.read({ principal: cat, reviewId: f.reviewId });
  const load = f.projects.load.bind(f.projects);
  let calls = 0;
  f.projects.load = async (input) => {
    const result = await load(input);
    if (input.principal.actor.kind === 'cat' && ++calls === 3) {
      const source = f.messages.getById(f.source.id);
      assert.ok(source);
      source.whisperTo = [];
    }
    return result;
  };
  await assert.rejects(
    f.service.act({
      principal: cat,
      reviewId: f.reviewId,
      expectedRevision: before.review.revision,
      operationId: 'revoked-private-reply',
      action: { kind: 'replied', annotationId: f.annotationId, replyId: 'private', body: 'Should never persist' },
    }),
    { code: 'access_denied' },
  );
  assert.equal(f.store.ledgers.operationReceipt(f.reviewId, 'revoked-private-reply'), null);
  assert.equal(f.store.ledgers.get(f.reviewId)?.annotations[0]?.replies?.length, 0);
});
