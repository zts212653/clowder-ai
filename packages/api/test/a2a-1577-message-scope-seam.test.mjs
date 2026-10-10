import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.ts';
import { createQueueLedgerAdmission } from '../src/domains/cats/services/agents/invocation/queue-ledger/QueueLedgerAdmission.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';

// Actual in-memory Message/Queue atomic seam. No Redis or invocation authority claim.
const participation = {
  serviceInstanceId: 'svc_100000000000',
  collectiveId: 'col_100000000000',
  connectionId: 'con_100000000000',
  eventId: 'evt_100000000000',
  location: { channelId: 'A' },
  catId: 'codex-astra',
  participationRevision: 1,
  actor: { kind: 'human', humanId: 'human_guest00000', displayName: 'Guest' },
};
function fixture(scope = 'collective-participation') {
  const from =
    scope === 'collective-work'
      ? { kind: 'system', service: 'collective-work' }
      : { kind: 'external', connectorId: 'collective' };
  const message = {
    userId: 'isolated-owner',
    threadId: 'isolated-scope',
    from,
    content: 'owned input',
    mentions: ['codex-astra'],
    timestamp: 1,
    deliveryStatus: 'queued',
    ...(scope === 'collective-work'
      ? { extra: { collectiveWorkInvocationV1: { v: 1, taskId: 'isolated-task', observedRevision: 1 } } }
      : { source: { connector: 'collective', meta: { participation } } }),
  };
  return { scope, message, from };
}
function admit(store, ledger, f, overrides = {}) {
  return store.appendWithQueueLedgerAdmission(
    f.message,
    (messageId) =>
      createQueueLedgerAdmission({
        sourceId: messageId,
        messageId,
        threadId: f.message.threadId,
        owner: { kind: 'user', userId: f.message.userId },
        kind: 'conversation_input',
        from: f.from,
        targetCatIds: ['codex-astra'],
        content: f.message.content,
        intent: 'execute',
        ownerAuthProvenance: 'unknown',
        executionScope: f.scope,
        enqueuedAt: 1,
        ...overrides,
      }),
    ledger,
  );
}
for (const scope of ['collective-participation', 'collective-work']) {
  test(`${scope} atomically preserves the source and narrow ledger scope`, () => {
    const store = new MessageStore();
    const ledger = new InMemoryQueueLedgerStore();
    const f = fixture(scope);
    const result = admit(store, ledger, f);
    assert.equal(result.outcome, 'enqueued');
    assert.equal(result.entries[0].execution.executionScope, scope);
    assert.deepEqual(result.message.from, f.from);
    assert.deepEqual(result.message.source, f.message.source);
    assert.equal(result.entries[0].execution.ownerAuthProvenance, 'unknown');
  });
}
for (const [label, change, overrides] of [
  [
    'missing public source',
    (f) => {
      delete f.message.source;
    },
  ],
  [
    'wrong source connector',
    (f) => {
      f.message.source.connector = 'other';
    },
  ],
  [
    'wrong durable sender',
    (f) => {
      f.message.from = { kind: 'external', connectorId: 'other' };
    },
  ],
  ['different participation target', () => {}, { targetCatIds: ['opus'] }],
  ['different ledger sender', () => {}, { from: { kind: 'external', connectorId: 'other' } }],
  [
    'invalid participation receipt',
    (f) => {
      f.message.source.meta.participation = { ...participation, participationRevision: 0 };
    },
  ],
  [
    'work without invocation receipt',
    (f) => {
      f.scope = 'collective-work';
      f.from = { kind: 'system', service: 'collective-work' };
      f.message.from = f.from;
      delete f.message.source;
    },
  ],
]) {
  test(`rejects ${label} without orphan ledger work or visible source`, async () => {
    const store = new MessageStore();
    const ledger = new InMemoryQueueLedgerStore();
    const f = structuredClone(fixture());
    change(f);
    assert.throws(() => admit(store, ledger, f, overrides), /Collective|collective|MessageFrom/);
    assert.deepEqual(await ledger.list(f.message.threadId), []);
    assert.deepEqual(store.getByThread(f.message.threadId), []);
  });
}
