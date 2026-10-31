import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { contentModificationRequestCarrierV1Schema, type TurnExecutionRecord } from '@cat-cafe/shared';
import { catConsumableHostSpeaker } from '../src/domains/cats/services/stores/host-message-policy.js';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { mediaMessageFixture } from './helpers/media-message-fixture.js';

async function fixture(
  t: Parameters<typeof mediaMessageFixture>[0],
  mediaType: 'image/png' | 'video/mp4',
  visibility: 'public' | 'whisper' = 'whisper',
) {
  let turns = new InMemoryTurnExecutionStore();
  const f = await mediaMessageFixture(t, mediaType, {
    get: (id) => turns.get(id),
    listBySource: (query) => turns.listBySource(query),
  });
  const human = f.send();
  if (visibility === 'public') {
    human.visibility = 'public';
    delete human.whisperTo;
  }
  const request = await f.takeOver(human.id);
  const receipt = request.record.progress.review?.receiptRef;
  assert.ok(receipt);
  const key = `f309-return:${createHash('sha256').update(receipt).digest('hex')}`;
  const carrier = f.messages.getByIdempotencyKey('operator', f.thread.id, key);
  assert.ok(carrier);
  const childId = await f.dispatch.waitForAwakening(carrier.id);
  const child = f.dispatch.turns.get(childId);
  assert.ok(child);
  // Reproduce Alpha's canonical same-turn fact: Human is covered, derived Host is not.
  const sameTurn = { ...child, causal: { triggerMessageId: human.id, coveredMessageIds: [human.id] } };
  function observeMany(facts: TurnExecutionRecord[]) {
    turns = new InMemoryTurnExecutionStore();
    for (const fact of facts) {
      assert.equal(turns.createRunning(fact).outcome, 'created');
      if (fact.status !== 'running')
        turns.transitionTerminal(fact.invocationId, {
          status: fact.status,
          terminalReason: `fixture_canonical_${fact.status}`,
          endedAt: fact.endedAt ?? Date.now(),
        });
    }
  }
  const observe = (fact: TurnExecutionRecord | null) => observeMany(fact ? [fact] : []);
  const read = () => f.integration.requests.read(request.record.requestId, f.human);
  return { ...f, humanMessage: human, request, receipt, carrier, child, sameTurn, observe, observeMany, read };
}

for (const mediaType of ['image/png', 'video/mp4'] as const) {
  test(`${mediaType} takeover binds the original Human to real same-turn execution and cancellation`, async (t) => {
    const f = await fixture(t, mediaType);
    for (const [status, state] of [
      ['running', 'running'],
      ['succeeded', 'finished'],
      ['canceled', 'cancelled'],
      ['failed', 'failed'],
      ['interrupted', 'interrupted'],
    ] as const) {
      f.observe({ ...f.sameTurn, status });
      const view = await f.read();
      assert.equal(view.execution?.state, state, 'the actual media request must consume its original Human coverage');
      assert.equal(view.execution?.invocationId, f.child.invocationId);
      assert.equal(view.execution?.parentInvocationId, f.child.parentInvocationId);
      assert.equal(view.execution?.messageId, f.carrier.id, 'native withdrawal still addresses the derived carrier');
      assert.equal(view.execution?.evidenceRef, `turn-execution:${f.child.invocationId}`);
    }
    const meta = contentModificationRequestCarrierV1Schema.parse(f.carrier.source?.meta);
    assert.equal(meta.sourceMessageId, f.humanMessage.id);
    assert.equal(meta.requestId, f.request.record.requestId);
    assert.equal(meta.targetCatId, f.request.record.payload.targetCatId);
    assert.equal(meta.taskId, f.request.record.progress.task?.taskId);
    assert.equal(meta.expectedTaskRevision, f.request.record.progress.task?.revision);
    assert.equal(meta.requestReceiptRef, f.receipt);
    assert.notEqual(meta.kind, 'request_text_edit', 'media must not impersonate the text carrier variant');
    assert.equal(catConsumableHostSpeaker(f.carrier), 'Host 作品修改请求：原任务续办');
    assert.equal(f.carrier.visibility, 'whisper');
    assert.deepEqual(f.carrier.whisperTo, f.humanMessage.whisperTo);
    assert.equal(f.store.get(f.request.record.progress.review?.reviewId ?? '')?.rounds.length, 1);
    assert.equal(f.tasks.get(f.taskId)?.entrustedWork?.closure.state, 'open');
    assert.deepEqual(f.errors, []);
  });

  test(`${mediaType} Human execution retains exact owner/thread/target/round and current-child fences`, async (t) => {
    const f = await fixture(t, mediaType);
    f.observe(f.sameTurn);
    assert.equal((await f.read()).execution?.state, 'running', 'negative controls require a positive binding first');
    for (const fact of [
      null,
      { ...f.sameTurn, userId: 'another-owner' },
      { ...f.sameTurn, threadId: 'another-thread' },
      { ...f.sameTurn, catId: 'sonnet' as typeof f.sameTurn.catId },
      { ...f.sameTurn, causal: { triggerMessageId: 'another-human', coveredMessageIds: ['another-human'] } },
    ]) {
      f.observe(fact);
      const view = await f.read();
      assert.equal(view.execution?.state, 'unknown');
      assert.equal(view.execution?.parentInvocationId, undefined, 'foreign facts supply no stop target');
    }
    f.observeMany([f.sameTurn, { ...f.child, invocationId: randomUUID() }]);
    assert.equal(
      (await f.read()).execution?.state,
      'unknown',
      'competing Human/carrier causal bindings cannot choose the newest child',
    );
    f.observeMany([f.sameTurn, { ...f.sameTurn, invocationId: randomUUID() }]);
    assert.equal((await f.read()).execution?.state, 'unknown', 'multiple original-Human bindings are ambiguous');
    f.observe(f.sameTurn);
    const source = f.carrier.source;
    assert.ok(source?.meta);
    const original = source.meta;
    for (const patch of [
      { sourceMessageId: 'another-human' },
      { requestId: `f309-modification-${'f'.repeat(64)}` },
      { targetCatId: 'sonnet' },
      { taskId: 'another-task' },
      { expectedTaskRevision: (f.request.record.progress.task?.revision ?? 0) + 1 },
      { requestReceiptRef: 'another-request-round' },
      { kind: 'request_text_edit' },
    ]) {
      source.meta = { ...original, ...patch };
      assert.equal((await f.read()).execution, undefined, 'a carrier cannot borrow another request or round');
    }
    source.meta = original;
    f.carrier.visibility = 'public';
    assert.equal((await f.read()).execution, undefined, 'a private source cannot use a public carrier');
    f.carrier.visibility = 'whisper';
    f.carrier.whisperTo = ['sonnet' as typeof f.child.catId];
    assert.equal((await f.read()).execution, undefined, 'the carrier audience must remain the source audience');
    f.carrier.whisperTo = f.humanMessage.whisperTo;
    const laterId = randomUUID();
    f.observe(null);
    assert.equal(
      (await f.read()).execution?.state,
      'unknown',
      'no current scoped source record supplies no stop target',
    );
    f.observe({ ...f.sameTurn, invocationId: laterId, causal: { triggerMessageId: f.carrier.id } });
    assert.equal((await f.read()).execution?.state, 'running', 'a later actual carrier turn is still valid');
    f.observe({ ...f.sameTurn, invocationId: laterId, causal: { triggerMessageId: 'another-human' } });
    assert.equal((await f.read()).execution?.state, 'unknown');
  });
}

test('retired media delivery without a canonical executor never claims model finished', async (t) => {
  const f = await fixture(t, 'image/png');
  assert.equal(f.dispatch.queue.size(f.thread.id, 'operator'), 0);
  assert.equal(f.carrier.queueCustody, undefined);
  f.observe(null);
  assert.equal((await f.read()).execution?.state, 'unknown');
  assert.equal((await f.read()).execution?.parentInvocationId, undefined);
});

test('a persisted legacy public media carrier binds Human only through its exact canonical request/outbox', async (t) => {
  const f = await fixture(t, 'image/png', 'public');
  const intent = f.store.returns.get(f.receipt);
  assert.ok(intent && intent.kind !== 'request_text_edit');
  f.carrier.source = {
    connector: 'content-review',
    label: '产物审阅',
    icon: 'cat-cafe',
    meta: { reviewReceiptRef: f.receipt, taskId: intent.taskId, reviewRevision: String(intent.reviewRevision) },
  };
  f.observe({ ...f.sameTurn, status: 'succeeded' });
  assert.equal((await f.read()).execution?.state, 'finished', 'the canonical persisted request already binds Human');
  const get = f.store.returns.get.bind(f.store.returns);
  for (const patch of [
    { requestId: `f309-modification-${'b'.repeat(64)}` },
    { ownerUserId: 'other-owner' },
    { threadId: 'other-thread' },
    { targetCatId: 'sonnet' },
    { taskId: 'other-task' },
    { expectedTaskRevision: intent.expectedTaskRevision + 1 },
    { receiptRef: 'other-receipt' },
    { reviewId: 'other-review' },
    { round: intent.round + 1 },
    { contentRef: 'other-publication' },
    { ownerRevision: intent.ownerRevision + 1 },
    { reviewRevision: intent.reviewRevision + 1 },
  ]) {
    f.store.returns.get = () => ({ ...intent, ...patch });
    const view = await f.read();
    assert.notEqual(view.execution?.state, 'finished', 'a legacy envelope cannot replace exact owner binding');
    assert.equal(view.execution?.parentInvocationId, undefined);
  }
  f.store.returns.get = get;
  assert.equal((await f.read()).execution?.state, 'finished');
});

for (const visibility of ['public', 'whisper'] as const) {
  test(`${visibility} media return recovery preserves the pre-v1 Queue winner and source audience`, async (t) => {
    const f = await mediaMessageFixture(t);
    const deliver = f.dispatch.delivery.deliver.bind(f.dispatch.delivery);
    const queued = f.store.returns.queued.bind(f.store.returns);
    f.dispatch.delivery.deliver = async (input) => {
      const receipt = input.source.meta?.requestReceiptRef;
      assert.equal(typeof receipt, 'string');
      const intent = f.store.returns.get(String(receipt));
      assert.ok(intent && intent.kind !== 'request_text_edit');
      return deliver({
        ...input,
        visibility: 'public',
        whisperTo: undefined,
        compatibleExistingSources: undefined,
        source: {
          connector: 'content-review',
          label: '产物审阅',
          icon: 'cat-cafe',
          meta: { reviewReceiptRef: receipt, taskId: intent.taskId, reviewRevision: String(intent.reviewRevision) },
        },
      });
    };
    f.store.returns.queued = () => {
      throw new Error('simulated old media crash before outbox mark');
    };
    const human = f.send();
    if (visibility === 'public') {
      human.visibility = 'public';
      delete human.whisperTo;
    }
    const request = await f.takeOver(human.id);
    const receipt = request.record.progress.review?.receiptRef;
    assert.ok(receipt);
    const key = `f309-return:${createHash('sha256').update(receipt).digest('hex')}`;
    const original = f.messages.getByIdempotencyKey('operator', f.thread.id, key);
    assert.ok(original);
    assert.equal(original.queueCustody, undefined);
    const admittedVisibility = original.visibility;
    const admittedRecipients = original.whisperTo;
    await f.dispatch.waitForAwakening(original.id);
    f.dispatch.delivery.deliver = deliver;
    f.store.returns.queued = queued;
    if (visibility === 'public') {
      await f.dispatcher.drain();
      assert.equal(f.store.returns.get(receipt)?.state, 'queued');
      assert.equal(f.store.returns.get(receipt)?.messageId, original.id);
    } else {
      await assert.rejects(f.dispatcher.drain(), /remain durably pending/);
      assert.equal(f.store.returns.get(receipt)?.state, 'pending', 'private source cannot reuse an old public carrier');
    }
    assert.equal(f.messages.getByIdempotencyKey('operator', f.thread.id, key)?.id, original.id);
    assert.equal(original.visibility ?? 'public', 'public');
    assert.equal(original.visibility, admittedVisibility, 'recovery never rewrites the admitted audience');
    assert.deepEqual(original.whisperTo, admittedRecipients);
  });
}
