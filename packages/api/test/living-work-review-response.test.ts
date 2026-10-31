import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { cat, human, now, submission, workResponseFixture } from './helpers/living-work-response-fixture.js';

test('one common submit returns v4 and responds to the original v1 opinion without a second owner effect', async (t) => {
  const f = await workResponseFixture(t);
  const result = await f.service.commit(f.command, cat);
  assert.equal(result.reference.ownerRevision, 4);
  const review = f.store.get('review')!;
  assert.equal(review.rounds[0]?.annotations[0]?.state, 'open');
  assert.equal(review.rounds[1]?.asset.ownerRevision, 4);
  assert.equal(review.rounds[1]?.responseSource?.ownerRevision, 1);
  assert.deepEqual(review.rounds[1]?.responses[0]?.resultAnchor, f.command.reviewResponse.responses[0]?.resultAnchor);
  assert.equal((await f.owner.listOutbox(f.command.contentRef)).length, 4);
  const before = f.opens();
  await f.service.commit(f.command, cat);
  assert.equal(f.opens(), before);
  assert.equal(f.store.get('review')?.rounds.length, 2);
});

test('committed v4 repairs both projections after head v5, without the ended producer or source file', async (t) => {
  const f = await workResponseFixture(t);
  f.injector.exec(
    "CREATE TRIGGER interrupt_v4 BEFORE INSERT ON work_version_annotations WHEN NEW.owner_revision=4 BEGIN SELECT RAISE(ABORT,'projection interrupted'); END",
  );
  await assert.rejects(f.service.commit(f.command, cat), /pending recovery/);
  assert.equal((await f.owner.describe(f.command.contentRef)).currentOwnerRevision, 4);
  assert.equal(f.store.get('review')?.rounds.length, 1);
  assert.ok(f.store.pendingVersion('review'));
  f.injector.exec('DROP TRIGGER interrupt_v4');
  const { reviewResponse: _response, ...normal } = f.command;
  await f.service.commit({ ...normal, ...submission('v5'), expectedOwnerRevision: 4 }, cat);
  f.revoke();
  const before = f.opens();
  const recovered = await f.responses.recover(f.store.get('review')!, human);
  assert.equal(recovered?.review.rounds.at(-1)?.asset.ownerRevision, 4);
  assert.equal(f.store.works.get('operator', f.command.contentRef, 4)?.operationId, 'v4');
  assert.equal(f.store.pendingVersion('review'), null);
  assert.equal((await f.owner.describe(f.command.contentRef)).currentOwnerRevision, 5);
  assert.equal(f.opens(), before, 'fact projection does not reopen a source or revive a producer');
  assert.equal(await f.responses.recover(f.store.get('review')!, human), null);
  const resolution = {
    action: 'resolve-review-submission' as const,
    reviewId: 'review',
    sourceRound: 1,
    expectedReviewRevision: 1,
    pendingOperationId: 'v4',
    operationId: 'observe-repaired-v4',
  };
  assert.equal(
    (await f.responses.resolve(resolution, human)).status,
    'saved',
    'a recovery read winning the race must leave resolution idempotent',
  );
});

test('pre-commit unknown remains on read; Human resolution fences a delayed old effect permanently', async (t) => {
  const f = await workResponseFixture(t);
  const settle = f.owner.settleStream.bind(f.owner);
  let continueOld!: () => void;
  let admitted!: () => void;
  const waiting = new Promise<void>((resolve) => {
    continueOld = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  f.owner.settleStream = async (input) => {
    admitted();
    await waiting;
    return settle(input);
  };
  const attempt = f.service.commit(f.command, cat).then(
    () => null,
    (error: unknown) => error,
  );
  await ready;
  assert.equal(await f.responses.recover(f.store.get('review')!, human), null);
  assert.ok(f.store.pendingVersion('review'));
  const resolution = {
    action: 'resolve-review-submission' as const,
    reviewId: 'review',
    sourceRound: 1,
    expectedReviewRevision: 1,
    pendingOperationId: 'v4',
    operationId: 'human-resolve',
  };
  await assert.rejects(f.responses.resolve(resolution, cat), /human_required/);
  const resolved = await f.responses.resolve(resolution, human);
  assert.equal(resolved.status, 'aborted');
  continueOld();
  assert.match(String(await attempt), /operation_reused/);
  assert.equal(f.store.pendingVersion('review'), null);
  assert.equal((await f.owner.describe(f.command.contentRef)).currentOwnerRevision, 3);
  assert.equal(f.store.history('review').filter((item) => item.receipt.outcome === 'aborted').length, 1);
  assert.equal(f.store.history('review').at(-1)?.receipt.actor.kind, 'human');
  assert.equal((await f.responses.resolve(resolution, human)).status, 'aborted');
  f.owner.settleStream = settle;
  await assert.rejects(f.service.commit(f.command, cat), /already final/);
  assert.equal((await f.owner.listOutbox(f.command.contentRef)).length, 3);
});

test('Human change wins before reservation, or reservation rejects Human write without losing its content', async (t) => {
  const f = await workResponseFixture(t);
  const write = {
    reviewId: 'review',
    operationId: 'human-new-opinion',
    expectedRevision: 1,
    actor: human.actor,
    now,
    round: 1,
    kind: 'annotate',
    request: { text: 'keep this unsent content' },
  };
  f.store.mutate(write, (review) => ({ ...review, revision: review.revision + 1 }));
  await assert.rejects(f.service.commit(f.command, cat), /revision_conflict/);
  assert.equal((await f.owner.describe(f.command.contentRef)).currentOwnerRevision, 3);
  const settle = f.owner.settleStream.bind(f.owner);
  f.owner.settleStream = async () => {
    throw new Error('process crashed before owner');
  };
  await assert.rejects(
    f.service.commit({ ...f.command, reviewResponse: { ...f.command.reviewResponse, expectedReviewRevision: 2 } }, cat),
    /crashed/,
  );
  assert.throws(
    () =>
      f.store.mutate({ ...write, expectedRevision: 2, operationId: 'human-retry' }, (review) => ({
        ...review,
        revision: review.revision + 1,
      })),
    /version_pending/,
  );
  assert.equal(write.request.text, 'keep this unsent content');
  f.owner.settleStream = settle;
});

test('same stream id never permits an old position past the new shorter video clock', async (t) => {
  const f = await workResponseFixture(t);
  const command = {
    ...f.command,
    reviewResponse: {
      ...f.command.reviewResponse,
      responses: [
        {
          ...f.command.reviewResponse.responses[0]!,
          resultAnchor: { kind: 'video-range', streamId: '0:0x1', startTick: 8000, endTick: 9000 },
        },
      ],
    },
  };
  await assert.rejects(f.service.commit(command, cat), /invalid_anchor/);
  assert.equal(f.store.pendingVersion('review'), null);
  assert.equal((await f.owner.describe(f.command.contentRef)).currentOwnerRevision, 3);
});

test('an in-flight owner effect holds the same recovery lock; its final receipt is projected rather than cancelled', async (t) => {
  const f = await workResponseFixture(t);
  const settle = f.owner.settleStream.bind(f.owner);
  let release!: () => void;
  let entered!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.owner.settleStream = async (input) => {
    const stream = input.stream;
    return settle({
      ...input,
      stream: Readable.from(
        (async function* () {
          for await (const chunk of stream) {
            yield chunk;
            entered();
            await hold;
          }
        })(),
      ),
    });
  };
  const write = f.service.commit(f.command, cat);
  await started;
  const resolve = f.responses.resolve(
    {
      action: 'resolve-review-submission',
      reviewId: 'review',
      sourceRound: 1,
      expectedReviewRevision: 1,
      pendingOperationId: 'v4',
      operationId: 'human-concurrent',
    },
    human,
  );
  await new Promise<void>((done) => setImmediate(done));
  release();
  assert.equal((await write).reference.ownerRevision, 4);
  assert.equal((await resolve).status, 'saved');
  assert.equal(f.store.pendingVersion('review'), null);
  assert.equal(f.store.history('review').filter((item) => item.receipt.outcome === 'aborted').length, 0);
  assert.equal((await f.owner.listOutbox(f.command.contentRef)).length, 4);
});
