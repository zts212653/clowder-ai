import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { respondWithMediaVersionSchema } from '@cat-cafe/shared';
import { queueEntryId } from '../src/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { mediaPublicationFixture } from './helpers/media-publication-fixture.js';
import { publicationResponseRecord, waitForRecoveryCarrierTerminal } from './helpers/publication-recovery-fixture.js';

test('an explicit owner recovery preserves the rejected terminal return and gives the same response a fresh authenticated child', async (t) => {
  const f = await mediaPublicationFixture(t, false, { publicationLedger: true });
  f.publish('append');
  await f.recover();
  const oldCarrier = f.carriers()[0];
  assert.ok(oldCarrier);
  const oldChildId = await f.dispatch.waitForAwakening(oldCarrier.id);
  const oldCredentials = f.dispatch.credentials.get(oldChildId);
  assert.ok(oldCredentials);
  const oldIntent = f.store.returns.publicationForRequest(f.request.record.requestId);
  assert.ok(oldIntent);
  const review = f.store.get(oldIntent.reviewId);
  const round = review?.rounds.at(-1);
  const publication = f.messages.getById(oldIntent.source.publicationMessageId);
  assert.ok(review && round?.ledgerRef && round.ledgerRevision && publication);
  const response = respondWithMediaVersionSchema.parse({
    requestId: f.request.record.requestId,
    reviewId: review.reviewId,
    expectedRevision: review.revision,
    expectedTaskRevision: review.task.observedRevision,
    expectedOwnerRevision: round.asset.ownerRevision,
    expectedLedgerRevision: round.ledgerRevision,
    artifactRef: f.image.urlPath,
    expectedArtifactRevision: String(publication.timestamp),
    operationId: randomUUID(),
    responses: round.annotations.map((annotation) => ({
      annotationId: annotation.id,
      disposition: 'addressed',
      explanation: '沿原请求交回已生成的这张图。',
    })),
  });
  const callback = {
    method: 'POST' as const,
    url: '/api/callbacks/artifact-review/respond',
    headers: { 'x-invocation-id': oldCredentials.invocationId, 'x-callback-token': oldCredentials.callbackToken },
    payload: response,
  };
  // Reproduce the old ledger parser fault before durable reservation, without changing source files.
  const reserve = f.store.reserveVersion.bind(f.store);
  f.store.reserveVersion = (mutation, payload) => {
    respondWithMediaVersionSchema.parse(payload);
    reserve(mutation, payload);
  };
  try {
    const rejected = await f.app.inject(callback);
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.deepEqual(rejected.json().details[0].keys, ['publicationSource']);
  } finally {
    f.store.reserveVersion = reserve;
  }
  assert.equal(f.store.pendingVersion(review.reviewId), null);
  assert.equal(f.store.get(review.reviewId)?.rounds.length, 1);
  f.dispatch.turns.transitionTerminal(oldChildId, {
    status: 'succeeded',
    terminalReason: 'fixture_callback_rejected_before_reservation',
    endedAt: Date.now(),
  });
  await f.dispatch.releaseProvider(oldChildId);
  await waitForRecoveryCarrierTerminal(f, oldCarrier.id);
  const priorCarrier = structuredClone(f.messages.getById(oldCarrier.id));
  const priorChild = structuredClone(f.dispatch.turns.get(oldChildId));
  const priorTask = structuredClone(await f.tasks.get(oldIntent.taskId));
  const priorRequest = structuredClone(f.store.requests.get(oldIntent.requestId, oldIntent.ownerUserId));
  await f.recover();
  assert.equal(f.carriers().length, 1, 'the normal poller must not guess terminal product failure');
  const command = {
    operationId: randomUUID(),
    expectedRequestRevision: priorRequest?.revision,
    expectedGeneration: 0,
    recoveryOfReceiptRef: oldIntent.receiptRef,
    expectedPriorInvocationId: oldChildId,
    response,
  };
  const ownerInput = {
    method: 'POST' as const,
    url: `/api/content-modifications/${oldIntent.requestId}/publication-recovery`,
    headers: { 'x-cat-cafe-user': 'operator' },
    payload: command,
  };
  const admitted = await f.app.inject(ownerInput);
  assert.equal(admitted.statusCode, 200, admitted.body);
  const recovered = admitted.json().intent;
  assert.notEqual(recovered.receiptRef, oldIntent.receiptRef);
  assert.equal(recovered.recovery.generation, 1);
  assert.equal(recovered.recovery.recoveryOfReceiptRef, oldIntent.receiptRef);
  assert.equal(recovered.recovery.response.operationId, response.operationId);
  assert.deepEqual(f.store.returns.get(oldIntent.receiptRef), oldIntent);
  assert.deepEqual(f.messages.getById(oldCarrier.id), priorCarrier);
  assert.deepEqual(f.dispatch.turns.get(oldChildId), priorChild);
  assert.deepEqual(await f.tasks.get(oldIntent.taskId), priorTask);
  assert.deepEqual(f.store.requests.get(oldIntent.requestId, oldIntent.ownerUserId), priorRequest);
  const repeated = await f.app.inject(ownerInput);
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.equal(repeated.json().intent.receiptRef, recovered.receiptRef);
  assert.equal(f.carriers().length, 2);
  const newCarrier = f.carriers().find((item) => item.source?.meta?.returnRef === recovered.receiptRef);
  assert.ok(newCarrier);
  const childId = await f.dispatch.waitForAwakening(newCarrier.id);
  assert.notEqual(childId, oldChildId);
  const credentials = f.dispatch.credentials.get(childId);
  assert.ok(credentials);
  assert.ok(publicationResponseRecord(f, childId).response.inputEntryIds.includes(queueEntryId(newCarrier.id)));
  const oldAttempt = await f.app.inject(callback);
  assert.notEqual(oldAttempt.statusCode, 200, 'the old authenticated child cannot respond to the new generation');
  const freshInput = {
    ...callback,
    headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
  };
  const returned = await f.app.inject(freshInput);
  assert.equal(returned.statusCode, 200, returned.body);
  const replay = await f.app.inject(freshInput);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json().receipt, returned.json().receipt);
  assert.equal(f.store.get(review.reviewId)?.rounds.length, 2);
  await f.recover();
  const candidates = f.messages
    .getByThread(f.thread.id, 100, 'operator')
    .filter(
      (message) =>
        message.extra?.contentModificationReceiptV1?.requestId === oldIntent.requestId &&
        message.extra.contentModificationReceiptV1.state === 'candidate',
    );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.replyTo, f.humanMessage.id);
  assert.equal(f.carriers().length, 2);
  assert.deepEqual(f.errors, []);
});
