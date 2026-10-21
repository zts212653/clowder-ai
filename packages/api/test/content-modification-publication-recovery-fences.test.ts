import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { reviewVersionOperationId } from '../src/domains/collaborative-content/artifact-review/version-response-service.js';
import { publicationRecoveryFingerprint } from '../src/domains/collaborative-content/modification/publication-recovery-contract.js';
import { publicationRecoveryFixture, publicationResponseRecord } from './helpers/publication-recovery-fixture.js';

test('only the direct owner Human can authorize a recovery, with a strict public response body', async (t) => {
  const f = await publicationRecoveryFixture(t);
  const credentials = f.dispatch.credentials.get(f.childId)!;
  for (const headers of [
    {},
    { 'x-cat-cafe-user': 'other-owner' },
    {
      ...f.ownerInput.headers,
      'x-invocation-id': credentials.invocationId,
      'x-callback-token': credentials.callbackToken,
    },
    { ...f.ownerInput.headers, 'x-agent-key-secret': 'forged' },
    { ...f.ownerInput.headers, origin: 'https://untrusted.example' },
  ]) {
    const result = await f.app.inject({ ...f.ownerInput, headers });
    assert.notEqual(result.statusCode, 200, result.body);
  }
  const forged = await f.app.inject({
    ...f.ownerInput,
    payload: { ...f.command, response: { ...f.response, publicationSource: {} } },
  });
  assert.equal(forged.statusCode, 400, forged.body);
  assert.equal(f.carriers().length, 1);
  assert.deepEqual(f.store.returns.publicationForRequest(f.intent.requestId), f.intent);
});

test('stale selectors and response coordinates cannot create a generation or change the original history', async (t) => {
  const f = await publicationRecoveryFixture(t);
  const wrongResponses = [
    { requestId: 'another-request' },
    { reviewId: 'another-review' },
    { expectedRevision: 999 },
    { expectedTaskRevision: 999 },
    { expectedOwnerRevision: 999 },
    { expectedLedgerRevision: 999 },
    { artifactRef: '/uploads/another.png' },
    { expectedArtifactRevision: 'changed' },
    { responses: [{ annotationId: 'unrelated', disposition: 'addressed', explanation: 'borrowed' }] },
  ];
  const wrongCommands = [
    { expectedGeneration: 1 },
    { recoveryOfReceiptRef: 'unrelated' },
    { expectedPriorInvocationId: f.child.invocationId },
    { expectedRequestRevision: 999 },
    ...wrongResponses.map((delta) => ({ response: { ...f.response, ...delta } })),
  ];
  for (const delta of wrongCommands) {
    const refused = await f.app.inject({ ...f.ownerInput, payload: { ...f.command, ...delta } });
    assert.notEqual(refused.statusCode, 200, `${JSON.stringify(delta)}: ${refused.body}`);
  }
  assert.equal(f.carriers().length, 1);
  assert.deepEqual(f.store.returns.get(f.intent.receiptRef), f.intent);
  assert.equal(f.store.pendingVersion(f.intent.reviewId), null);
});

test('one CAS winner survives concurrent owner commands, database reopen and exact operation replay', async (t) => {
  const f = await publicationRecoveryFixture(t);
  const competing = { ...f.command, operationId: randomUUID() };
  const results = await Promise.all([
    f.app.inject(f.ownerInput),
    f.app.inject(f.ownerInput),
    f.app.inject({ ...f.ownerInput, payload: competing }),
  ]);
  const winner = results[2]?.statusCode === 200 ? competing : f.command;
  const successes = results.filter((result) => result.statusCode === 200);
  assert.equal(successes.length, winner === competing ? 1 : 2, results.map((result) => result.body).join('\n'));
  assert.equal(new Set(successes.map((result) => result.json().intent.receiptRef)).size, 1);
  const winnerReplay = await f.app.inject({ ...f.ownerInput, payload: winner });
  assert.equal(winnerReplay.statusCode, 200, winnerReplay.body);
  assert.equal(f.carriers().length, 2);
  const selected = f.store.returns.publicationForRequest(f.intent.requestId)!;
  const reopened = new ArtifactReviewStore(join(f.root, 'collaborative-content', 'artifact-reviews.sqlite'));
  try {
    assert.deepEqual(reopened.returns.publicationForRequest(f.intent.requestId), selected);
    assert.equal(
      reopened.returns.publications.replay(
        'operator',
        winner.operationId,
        publicationRecoveryFingerprint(f.intent.requestId, winner),
      ),
      selected.receiptRef,
    );
  } finally {
    reopened.close();
  }
  const changed = await f.app.inject({
    ...f.ownerInput,
    payload: { ...winner, response: { ...f.response, operationId: randomUUID() } },
  });
  assert.equal(changed.statusCode, 409, changed.body);
  assert.equal(changed.json().error, 'operation_reused');
  assert.deepEqual(f.store.returns.get(f.intent.receiptRef), f.intent);
});

test('live predecessors cannot be superseded; another terminal failure requires its own explicit generation', async (t) => {
  const f = await publicationRecoveryFixture(t, false);
  const refused = await f.app.inject(f.ownerInput);
  assert.equal(refused.statusCode, 403, refused.body);
  await f.end(f.childId);
  const first = await f.admittedChild();
  const next = {
    ...f.command,
    operationId: randomUUID(),
    expectedGeneration: 1,
    recoveryOfReceiptRef: first.current.receiptRef,
    expectedPriorInvocationId: first.id,
  };
  assert.equal((await f.app.inject({ ...f.ownerInput, payload: next })).statusCode, 403);
  await f.end(first.id);
  await f.recover();
  assert.equal(f.carriers().length, 2, 'the poller never authorizes a successor');
  const changed = await f.app.inject({
    ...f.ownerInput,
    payload: { ...next, response: { ...f.response, operationId: randomUUID() } },
  });
  assert.equal(changed.statusCode, 409, changed.body);
  const second = await f.app.inject({ ...f.ownerInput, payload: next });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().intent.recovery.generation, 2);
  assert.equal(f.carriers().length, 3);
  assert.deepEqual(f.store.returns.get(f.intent.receiptRef), f.intent);
});

for (const boundary of [
  'recalled-human',
  'changed-audience',
  'publication-recalled',
  'corrupt-native',
  'no-response-input',
  'cancelled-request',
  'task-closed',
  'owner-receipt',
] as const) {
  test(`owner recovery refuses ${boundary} without creating another carrier`, async (t) => {
    const f = await publicationRecoveryFixture(t);
    if (boundary === 'recalled-human') f.humanMessage._tombstone = true;
    if (boundary === 'changed-audience') f.humanMessage.whisperTo = [];
    if (boundary === 'publication-recalled')
      f.messages.getById(f.intent.source.publicationMessageId)!._tombstone = true;
    if (boundary === 'corrupt-native') await writeFile(f.image.absPath, 'changed native bytes');
    if (boundary === 'no-response-input') publicationResponseRecord(f, f.childId).response.inputEntryIds = [];
    if (boundary === 'cancelled-request') await f.integration.requests.cancel(f.intent.requestId, f.human);
    if (boundary === 'task-closed') {
      const task = await f.tasks.get(f.intent.taskId);
      assert.ok(task);
      task.status = 'done';
    }
    if (boundary === 'owner-receipt') {
      const operationReceipt = f.media.operationReceipt.bind(f.media);
      f.media.operationReceipt = async (contentRef, operationId, principal) => {
        assert.equal(operationId, reviewVersionOperationId(f.intent.reviewId, f.response.operationId));
        return (
          (await operationReceipt(contentRef, operationId, principal)) ??
          ({ receiptId: 'already-committed' } as Awaited<ReturnType<typeof operationReceipt>>)
        );
      };
    }
    const refused = await f.app.inject(f.ownerInput);
    assert.notEqual(refused.statusCode, 200, refused.body);
    assert.equal(f.carriers().length, 1);
    assert.deepEqual(f.store.returns.get(f.intent.receiptRef), f.intent);
    assert.equal(f.store.pendingVersion(f.intent.reviewId), null);
  });
}

test('fresh recovery callback is bound to the original response fingerprint and exact response input', async (t) => {
  const f = await publicationRecoveryFixture(t);
  const admitted = await f.admittedChild();
  const changed = await f.app.inject({
    ...admitted.callback,
    payload: {
      ...f.response,
      responses: f.response.responses.map((response) => ({ ...response, explanation: 'substituted' })),
    },
  });
  assert.equal(changed.statusCode, 403, changed.body);
  assert.equal(f.store.pendingVersion(f.intent.reviewId), null);
  publicationResponseRecord(f, admitted.id).response.inputEntryIds = [];
  assert.equal((await f.app.inject(admitted.callback)).statusCode, 403);
  assert.equal(f.store.pendingVersion(f.intent.reviewId), null);
  assert.equal(f.store.get(f.intent.reviewId)?.rounds.length, 1);
});

test('a lost delivery response resumes the same accepted generation and immutable carrier', async (t) => {
  const f = await publicationRecoveryFixture(t);
  const oldCarrier = structuredClone(f.messages.getById(f.intent.messageId!));
  const oldChild = structuredClone(f.dispatch.turns.get(f.childId));
  const deliver = f.dispatch.delivery.deliver.bind(f.dispatch.delivery);
  let interrupted = false;
  f.dispatch.delivery.deliver = async (envelope) => {
    const accepted = await deliver(envelope);
    if (!interrupted) {
      interrupted = true;
      throw new Error('fixture_lost_delivery_response_after_durable_acceptance');
    }
    return accepted;
  };
  const first = await f.app.inject(f.ownerInput);
  assert.equal(first.statusCode, 500, first.body);
  const pending = f.store.returns.publicationForRequest(f.intent.requestId);
  assert.ok(pending?.recovery);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.recovery.generation, 1);
  assert.equal(f.carriers().length, 2);
  const carrier = f.carriers().find((item) => item.source?.meta?.returnRef === pending.receiptRef);
  assert.ok(carrier);
  const childId = await f.dispatch.waitForAwakening(carrier.id);
  f.dispatch.delivery.deliver = deliver;
  await f.recover();
  const replay = await f.app.inject(f.ownerInput);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().intent.receiptRef, pending.receiptRef);
  assert.equal(replay.json().intent.messageId, carrier.id);
  assert.equal(await f.dispatch.waitForAwakening(carrier.id), childId);
  assert.equal(f.carriers().length, 2);
  assert.deepEqual(f.store.returns.get(f.intent.receiptRef), f.intent);
  assert.deepEqual(f.messages.getById(f.intent.messageId!), oldCarrier);
  assert.deepEqual(f.dispatch.turns.get(f.childId), oldChild);
});

for (const status of ['succeeded', 'failed'] as const) {
  test(`owner recovery refuses a ${status} child while its original carrier remains actionable`, async (t) => {
    const f = await publicationRecoveryFixture(t, false);
    f.dispatch.turns.transitionTerminal(f.childId, {
      status,
      terminalReason: 'fixture_child_ended_before_carrier_terminal',
      endedAt: Date.now(),
    });
    const response = publicationResponseRecord(f, f.childId).response;
    assert.equal(response.status, 'processing', 'the original response has not reached a terminal fact');
    const prior = structuredClone(f.store.returns.publicationForRequest(f.intent.requestId));
    const result = await f.app.inject(f.ownerInput);
    assert.equal(result.statusCode, 403, result.body);
    assert.equal(f.carriers().length, 1);
    assert.deepEqual(f.store.returns.publicationForRequest(f.intent.requestId), prior);
    assert.equal(f.store.pendingVersion(f.intent.reviewId), null);
  });
}
