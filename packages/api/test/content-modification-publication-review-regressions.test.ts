import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { catConsumableHostSpeaker } from '../src/domains/cats/services/stores/host-message-policy.js';
import { mediaPublicationFixture as fixture } from './helpers/media-publication-fixture.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function responseInput(f: Fixture, childId: string) {
  const credentials = f.dispatch.credentials.get(childId);
  assert.ok(credentials);
  const publication = f.messages.getById(String(f.carriers()[0]?.source?.meta?.publicationMessageId));
  assert.ok(publication);
  const review = f.store.get(f.request.record.progress.review!.reviewId)!;
  const round = review.rounds.at(-1)!;
  return {
    method: 'POST' as const,
    url: '/api/callbacks/artifact-review/respond',
    headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
    payload: {
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
        explanation: '依据原批注交回。',
      })),
    },
  };
}
async function continuation(f: Fixture) {
  f.publish('append');
  await f.recover();
  assert.equal(f.carriers().length, 1, f.errors.map(String).join('; '));
  assert.equal(catConsumableHostSpeaker(f.carriers()[0]!), 'Host 作品生成完成：原任务续办');
  return f.dispatch.waitForAwakening(f.carriers()[0]!.id);
}

test('an accepted publication response replays its exact receipt without a new mutation', async (t) => {
  const f = await fixture(t);
  const childId = await continuation(f);
  const input = await responseInput(f, childId);
  const first = await f.app.inject(input);
  assert.equal(first.statusCode, 200, first.body);
  const revision = f.store.get(input.payload.reviewId)!.revision;
  const replay = await f.app.inject(input);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json().receipt, first.json().receipt);
  assert.equal(f.store.get(input.payload.reviewId)!.revision, revision);
  assert.equal(f.store.pendingVersion(input.payload.reviewId), null);
  const altered = await f.app.inject({
    ...input,
    payload: { ...input.payload, artifactRef: '/uploads/review-input.png' },
  });
  assert.equal(altered.statusCode, 409, altered.body);
  assert.equal(altered.json().error, 'operation_reused');
  assert.equal(f.store.get(input.payload.reviewId)!.revision, revision);
});

for (const boundary of ['original-source-withdrawn', 'return-source-withdrawn'] as const) {
  test(`accepted business receipt recovery follows original-Human authority after ${boundary}`, async (t) => {
    const f = await fixture(t, true);
    await f.markOriginalHandled();
    const childId = await continuation(f);
    f.reviews.setCommittedProjection(async () => {});
    const response = await f.app.inject(await responseInput(f, childId));
    assert.equal(response.statusCode, 200, response.body);
    const before = f.store.get(f.request.record.progress.review!.reviewId)!.revision;
    const existingReceipts = f.messages
      .getByThread(f.thread.id, 100, 'operator')
      .filter((message) => message.extra?.contentModificationReceiptV1?.state === 'candidate').length;
    if (boundary === 'original-source-withdrawn') f.humanMessage._tombstone = true;
    else f.messages.getById(f.carriers()[0]!.id)!._tombstone = true;
    await f.recover();
    assert.equal(
      f.messages
        .getByThread(f.thread.id, 100, 'operator')
        .filter((message) => message.extra?.contentModificationReceiptV1?.state === 'candidate').length,
      boundary === 'return-source-withdrawn' ? 1 : existingReceipts,
      'An authorized original Human retains the one accepted business receipt; return Queue/body state is not a gate',
    );
    if (boundary === 'original-source-withdrawn' && !existingReceipts)
      assert.ok(f.errors.some((error) => String(error).includes('access_denied')));
    await f.recover();
    assert.equal(
      f.messages
        .getByThread(f.thread.id, 100, 'operator')
        .filter((message) => message.extra?.contentModificationReceiptV1?.state === 'candidate').length,
      boundary === 'return-source-withdrawn' ? 1 : existingReceipts,
    );
    assert.equal(f.store.get(f.request.record.progress.review!.reviewId)!.revision, before);
  });
}

test('an accepted pending publication response retries using its persisted selector', async (t) => {
  const f = await fixture(t);
  const childId = await continuation(f);
  const input = await responseInput(f, childId);
  const publish = f.media.publishVersion.bind(f.media);
  f.media.publishVersion = async () => {
    throw new Error('fixture_owner_unavailable');
  };
  const failed = await f.app.inject(input);
  assert.equal(failed.statusCode, 500);
  assert.ok(f.store.pendingVersion(input.payload.reviewId));
  f.media.publishVersion = publish;
  const retried = await f.app.inject(input);
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(f.store.pendingVersion(input.payload.reviewId), null);
  assert.equal(f.store.get(input.payload.reviewId)!.rounds.at(-1)!.asset.ownerRevision, 2);
});

test('a handled multi-target Human receives one candidate receipt with error-free recovery after the child ends', async (t) => {
  const f = await fixture(t, true);
  await f.markOriginalHandled();
  const childId = await continuation(f);
  assert.deepEqual(f.errors, []);
  const input = await responseInput(f, childId);
  const response = await f.app.inject(input);
  assert.equal(response.statusCode, 200, response.body);
  f.dispatch.turns.transitionTerminal(childId, {
    status: 'succeeded',
    terminalReason: 'fixture_candidate_committed',
    endedAt: Date.now(),
  });
  await f.recover();
  await f.recover();
  const receipts = f.messages
    .getByThread(f.thread.id, 100, 'operator')
    .filter(
      (message) =>
        message.extra?.contentModificationReceiptV1?.requestId === f.request.record.requestId &&
        message.extra.contentModificationReceiptV1.state === 'candidate',
    );
  assert.equal(receipts.length, 1, f.errors.map(String).join('; '));
  assert.deepEqual(f.errors, []);
  assert.equal(receipts[0]!.replyTo, f.humanMessage.id);
  assert.equal(receipts[0]!.visibility, 'whisper');
  assert.deepEqual(receipts[0]!.whisperTo, f.humanMessage.whisperTo);
  assert.equal(f.humanMessage.deliveryStatus, undefined);
  assert.equal(Object.hasOwn(f.humanMessage, 'queueCustody'), false);
  assert.equal(f.carriers().length, 1);
});

test('independent queued media requests keep separate producers and cannot borrow one native image', async (t) => {
  const f = await fixture(t, false, { sharedProducer: true });
  const second = f.secondRequest;
  assert.ok(second);
  assert.notEqual(second.record.requestId, f.request.record.requestId);
  assert.notEqual(second.record.progress.task!.taskId, f.request.record.progress.task!.taskId);
  assert.equal(
    f.child.causal!.coveredMessageIds!.length,
    1,
    'one message_wake admits one source, no old inline worklist',
  );
  f.publish('append');
  await f.recover();
  await f.recover();
  assert.equal(f.carriers().length, 1);
  assert.ok(f.store.returns.publicationForRequest(f.request.record.requestId));
  assert.equal(f.store.returns.publicationForRequest(second.record.requestId), null);
  assert.equal(f.store.get(second.record.progress.review!.reviewId)!.rounds.length, 1);
});

for (const boundary of ['wrong-owner', 'wrong-thread', 'wrong-target', 'no-source-cause', 'ambiguous-child'] as const) {
  test(`private native producer refuses ${boundary} before registration and wake`, async (t) => {
    const f = await fixture(t);
    const original = f.dispatch.turns.listBySource.bind(f.dispatch.turns);
    t.mock.method(f.dispatch.turns, 'listBySource', (query) => {
      const records = original(query);
      if (boundary === 'ambiguous-child') return [...records, { ...records[0]!, invocationId: randomUUID() }];
      return records.map((record) => ({
        ...record,
        ...(boundary === 'wrong-owner' ? { userId: 'foreign' } : {}),
        ...(boundary === 'wrong-thread' ? { threadId: 'foreign' } : {}),
        ...(boundary === 'wrong-target' ? { catId: 'sonnet' } : {}),
        ...(boundary === 'no-source-cause' ? { causal: { triggerMessageId: 'foreign' } } : {}),
      }));
    });
    f.publish('append');
    const starts = f.dispatch.starts.length;
    await f.recover();
    assert.equal(f.carriers().length, 0);
    assert.equal(f.store.returns.publicationForRequest(f.request.record.requestId), null);
    assert.equal(f.dispatch.starts.length, starts);
  });
}

for (const producerStatus of ['running', 'canceled'] as const) {
  test(`a ${producerStatus} producer with completed native pixels never registers or wakes a continuation`, async (t) => {
    const f = await fixture(t, false, { producerStatus });
    assert.equal(f.dispatch.turns.get(f.child.invocationId)!.status, producerStatus);
    f.publish('append');
    const starts = f.dispatch.starts.length;
    await f.recover();
    assert.equal(f.store.returns.publicationForRequest(f.request.record.requestId), null);
    assert.equal(f.carriers().length, 0);
    assert.equal(f.dispatch.starts.length, starts);
  });
}
