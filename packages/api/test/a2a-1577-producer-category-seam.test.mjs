import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersistedQueueDelivery } from '../src/domains/cats/services/agents/invocation/PersistedQueueDelivery.ts';

// Actual delivery consumer; controlled storage boundary only. This test does
// not claim a Redis transaction or an InvocationQueue recovery run.
const input = {
  ownerUserId: 'isolated-operator',
  threadId: 'isolated-review',
  targetCatId: 'codex',
  idempotencyKey: 'owned-receipt',
  content: 'continue existing work',
  ownerAuthProvenance: 'strict',
  sourceCategory: 'producer_return',
  source: { connector: 'content-review', label: 'Review', meta: { receiptId: 'owned-1' } },
};
function fixture({
  sourceCategory,
  status = 'queued',
  admissionRace = false,
  retired = false,
  waitContinuationCarrier,
} = {}) {
  const message = {
    id: 'isolated-message',
    userId: input.ownerUserId,
    threadId: input.threadId,
    catId: null,
    content: input.content,
    mentions: [input.targetCatId],
    timestamp: 1,
    deliveryStatus: retired ? 'delivered' : 'queued',
    source: input.source,
  };
  const entry = {
    id: 'q:isolated-message',
    sourceCategory,
    status,
    threadId: input.threadId,
    targets: [input.targetCatId],
    payload: { messageId: message.id },
    ...(waitContinuationCarrier ? { execution: { waitContinuationCarrier } } : {}),
  };
  let progressed = 0,
    admitted = 0;
  const delivery = new PersistedQueueDelivery({
    messages: { getByIdempotencyKey: async () => (admissionRace ? null : message) },
    queue: {
      getDurableEntry: async () => (retired ? undefined : entry),
      findAdmittedEntriesForMessages: () => [],
      send: async () => {
        admitted++;
        return { outcome: 'enqueued', message, entry };
      },
    },
    progress: async () => {
      progressed++;
      return 'owned_deferred_busy';
    },
  });
  return {
    delivery,
    entry,
    message,
    get progressed() {
      return progressed;
    },
    get admitted() {
      return admitted;
    },
  };
}

for (const status of ['queued', 'claimed', 'processing']) {
  test(`existing ${status} row cannot be silently changed from unclassified to producer_return`, async () => {
    const f = fixture({ status });
    assert.equal((await f.delivery.deliver(input)).state, 'conflict');
    assert.equal(f.progressed, 0);
    assert.equal(f.entry.sourceCategory, undefined);
  });
}
test('idempotent admission-race winner must match producer category before progressing', async () => {
  const f = fixture({ sourceCategory: 'review', admissionRace: true });
  assert.equal((await f.delivery.deliver(input)).state, 'conflict');
  assert.equal(f.admitted, 1);
  assert.equal(f.progressed, 0);
  assert.equal(f.entry.sourceCategory, 'review');
});
test('matching producer_return continues the existing pending row without a made-up carrier', async () => {
  const f = fixture({ sourceCategory: 'producer_return' });
  assert.equal((await f.delivery.deliver(input)).state, 'owned_deferred_busy');
  assert.equal(f.progressed, 1);
  assert.equal(f.admitted, 0);
});
test('retired public History remains terminal and does not acquire a tombstone or new work', async () => {
  const f = fixture({ retired: true });
  assert.equal((await f.delivery.deliver(input)).state, 'terminal_owned');
  assert.equal(f.progressed, 0);
  assert.equal(f.admitted, 0);
});

const waitCarrier = {
  v: 1,
  waitId: 'owned-wait',
  outcomeId: 'owned-wait:g1:matched',
  ownerFence: { kind: 'containing_task', generation: 1 },
};
for (const admissionRace of [false, true]) {
  for (const [name, stored, supplied] of [
    ['cannot acquire a carrier retroactively', undefined, waitCarrier],
    ['cannot lose its carrier on replay', waitCarrier, undefined],
    [
      'cannot change its owner generation',
      waitCarrier,
      { ...waitCarrier, ownerFence: { kind: 'containing_task', generation: 2 } },
    ],
  ]) {
    test(`${admissionRace ? 'admission winner' : 'existing pending row'} ${name}`, async () => {
      const f = fixture({ sourceCategory: 'producer_return', admissionRace, waitContinuationCarrier: stored });
      assert.equal((await f.delivery.deliver({ ...input, waitContinuationCarrier: supplied })).state, 'conflict');
      assert.equal(f.progressed, 0);
      assert.deepEqual(f.entry.execution?.waitContinuationCarrier, stored);
    });
  }
  test(`${admissionRace ? 'admission winner' : 'pending row'} accepts only the same typed wait authority`, async () => {
    const f = fixture({ sourceCategory: 'producer_return', admissionRace, waitContinuationCarrier: waitCarrier });
    assert.equal(
      (await f.delivery.deliver({ ...input, waitContinuationCarrier: structuredClone(waitCarrier) })).state,
      'owned_deferred_busy',
    );
    assert.equal(f.progressed, 1);
  });
}
