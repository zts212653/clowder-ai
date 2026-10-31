import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicationRecoveryFixture } from './helpers/publication-recovery-fixture.js';

test('a reserved pre-commit response survives a terminal child and resumes only through explicit Human recovery', async (t) => {
  const f = await publicationRecoveryFixture(t, false);
  const credentials = f.dispatch.credentials.get(f.childId)!;
  const reserve = f.store.reserveVersion.bind(f.store);
  f.store.reserveVersion = (input, payload) => {
    reserve(input, payload);
    throw new Error('fixture_crash_after_reservation_before_owner_write');
  };
  const callback = {
    method: 'POST' as const,
    url: '/api/callbacks/artifact-review/respond',
    headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
    payload: f.response,
  };
  const interrupted = await f.app.inject(callback);
  f.store.reserveVersion = reserve;
  assert.equal(interrupted.statusCode, 500, interrupted.body);
  const pending = structuredClone(f.store.pendingVersion(f.intent.reviewId));
  assert.ok(pending);
  const original = await f.reviews.read(f.intent.reviewId, f.human);
  assert.equal(original.pendingVersion, true);
  assert.equal(original.review.rounds.length, 1);
  await f.end(f.childId);
  await f.recover();
  assert.deepEqual(f.store.pendingVersion(f.intent.reviewId), pending);
  assert.equal(f.carriers().length, 1, 'ordinary polling cannot authorize a new execution');
  const altered = await f.app.inject({
    ...f.ownerInput,
    payload: {
      ...f.command,
      response: { ...f.response, responses: f.response.responses.map((r) => ({ ...r, explanation: 'substituted' })) },
    },
  });
  assert.equal(altered.statusCode, 409, altered.body);
  assert.deepEqual(f.store.pendingVersion(f.intent.reviewId), pending);
  const next = await f.admittedChild();
  assert.notEqual(next.id, f.childId);
  assert.equal(next.current.recovery?.response.operationId, f.response.operationId);
  assert.deepEqual(f.store.pendingVersion(f.intent.reviewId), pending, 'the sealed business intent is retained');
  assert.notEqual((await f.app.inject(callback)).statusCode, 200, 'the old execution is fenced');
  const committed = await f.app.inject(next.callback);
  assert.equal(committed.statusCode, 200, committed.body);
  assert.equal(f.store.pendingVersion(f.intent.reviewId), null);
  assert.equal(f.store.get(f.intent.reviewId)?.rounds.length, 2);
  const replay = await f.app.inject(next.callback);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json().receipt, committed.json().receipt);
  assert.equal(f.carriers().length, 2);
});

test('a producer ending after reservation loses publication authority before the owner effect', async (t) => {
  const f = await publicationRecoveryFixture(t, false);
  const credentials = f.dispatch.credentials.get(f.childId);
  assert.ok(credentials);
  const publish = f.media.publishVersion.bind(f.media);
  f.media.publishVersion = async (input) => {
    f.dispatch.turns.transitionTerminal(f.childId, {
      status: 'succeeded',
      terminalReason: 'fixture_ended_after_admission',
      endedAt: Date.now(),
    });
    return publish(input);
  };
  const rejected = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/artifact-review/respond',
    headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
    payload: f.response,
  });
  assert.equal(rejected.statusCode, 403, rejected.body);
  assert.equal(await f.media.currentRevision(f.intent.contentRef, f.human), 1);
  assert.equal(f.store.get(f.intent.reviewId)?.rounds.length, 1);
});

test('a saved owner receipt repairs the accepted response after the producer ends without another publication', async (t) => {
  const f = await publicationRecoveryFixture(t, false);
  const credentials = f.dispatch.credentials.get(f.childId);
  assert.ok(credentials);
  const finish = f.store.finishVersion.bind(f.store);
  f.store.finishVersion = () => {
    throw new Error('fixture_projection_crash_after_owner_commit');
  };
  const interrupted = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/artifact-review/respond',
    headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
    payload: f.response,
  });
  assert.equal(interrupted.statusCode, 500, interrupted.body);
  assert.equal(await f.media.currentRevision(f.intent.contentRef, f.human), 2);
  assert.ok(f.store.pendingVersion(f.intent.reviewId));
  f.store.finishVersion = finish;
  await f.end(f.childId);
  let writes = 0;
  f.media.publishVersion = async () => {
    writes += 1;
    throw new Error('unexpected second publication');
  };
  const repaired = await f.reviews.read(f.intent.reviewId, f.human);
  assert.equal(repaired.pendingVersion, false);
  assert.equal(repaired.review.rounds.at(-1)?.asset.ownerRevision, 2);
  assert.equal(writes, 0);
  assert.equal(f.store.get(f.intent.reviewId)?.rounds.length, 2);
  assert.equal((await f.owner.listOutbox(f.intent.contentRef)).length, 2);
});
