import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InMemoryQueueLedgerStore } = await import(
  '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

function message(idempotencyKey, content = idempotencyKey) {
  return {
    from: { kind: 'user', userId: 'owner-1' },
    userId: 'owner-1',
    content,
    mentions: ['opus', 'codex'],
    timestamp: 100,
    threadId: 'thread-admission',
    idempotencyKey,
    deliveryStatus: 'queued',
  };
}

function queueInput(idempotencyKey, content = idempotencyKey) {
  return {
    from: { kind: 'user', userId: 'owner-1' },
    threadId: 'thread-admission',
    userId: 'owner-1',
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    idempotencyKey,
    content,
    targetCats: ['opus', 'codex'],
    intent: 'execute',
  };
}

describe('ADR-043 atomic memory message + Queue admission', () => {
  it('binds the single source row to the exact stored message and replays without duplication', async () => {
    const ledger = new InMemoryQueueLedgerStore();
    const queue = new InvocationQueue(ledger);
    const messages = new MessageStore();

    const first = await queue.send(messages, message('request-1'), queueInput('request-1'));
    assert.equal(first.outcome, 'enqueued');
    assert.equal(first.deduped, false);
    assert.equal(first.entries.length, 1);
    assert.ok(first.entries.every((entry) => entry.payload.messageId === first.message.id));
    assert.deepEqual(
      (await ledger.list('thread-admission')).map((entry) => [entry.payload.sourceRecordId, entry.payload.messageId]),
      [[first.message.id, first.message.id]],
    );

    const replay = await queue.send(messages, message('request-1'), queueInput('request-1'));
    assert.equal(replay.outcome, 'enqueued');
    assert.equal(replay.deduped, true);
    assert.equal(replay.message.id, first.message.id);
    assert.equal((await ledger.list('thread-admission')).length, 1);
  });

  it('rejects capacity before persisting either the message or any fan-out row', async () => {
    const ledger = new InMemoryQueueLedgerStore();
    const queue = new InvocationQueue(ledger);
    const messages = new MessageStore();

    for (let index = 0; index < 5; index += 1) {
      const id = `fill-${index}`;
      assert.equal((await queue.send(messages, message(id), queueInput(id))).outcome, 'enqueued');
    }
    const rejected = await queue.send(messages, message('over-capacity'), queueInput('over-capacity'));
    assert.deepEqual(rejected, { outcome: 'full' });
    assert.equal(messages.getByIdempotencyKey('owner-1', 'thread-admission', 'over-capacity'), null);
    assert.equal((await ledger.list('thread-admission')).length, 5);
  });
});

it('common send keeps durable acceptance when its wake fails and registers observers before wake', async () => {
  const events = [];
  const messages = new MessageStore();
  const queue = new InvocationQueue(undefined, {
    onAdmitted: ({ message: source, entries }) => {
      events.push('wake');
      assert.ok(messages.getById(source.id));
      assert.equal(entries.length, 1);
      throw new Error('owned wake failure');
    },
  });
  const admitted = await queue.send(messages, message('observer-order'), {
    ...queueInput('observer-order'),
    onQueueEntriesAdmitted: () => events.push('observer'),
  });
  assert.equal(admitted.outcome, 'enqueued');
  assert.deepEqual(events, ['observer', 'wake']);
  assert.equal(queue.list('thread-admission', 'owner-1').length, 1);
});

it('an exact Live recipient cannot be replaced with a conversation fallback', async () => {
  const messages = new MessageStore();
  const queue = new InvocationQueue(undefined, { resolveTargets: async () => ['opus'] });
  await assert.rejects(
    () =>
      queue.send(messages, message('explicit-conflict'), {
        ...queueInput('explicit-conflict'),
        liveSessionId: 'exact-live-session',
        targetCats: ['codex'],
      }),
    /explicit targets cannot be rerouted/,
  );
  assert.equal(messages.getByIdempotencyKey('owner-1', 'thread-admission', 'explicit-conflict'), null);
  assert.equal(queue.list('thread-admission', 'owner-1').length, 0);
});

it('a failed atomic write does not consume the source identity or freeze a default policy', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { saveMessageDispositionPreference } = await import('../dist/config/user-preferences-store.js');
  const projectRoot = await mkdtemp(join(tmpdir(), 'f117-admission-failure-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const ledger = new InMemoryQueueLedgerStore();
  const enqueue = ledger.enqueueNow.bind(ledger);
  let fail = true;
  ledger.enqueueNow = (...args) => {
    if (fail) throw new Error('owned precommit failure');
    return enqueue(...args);
  };
  const messages = new MessageStore();
  const queue = new InvocationQueue(ledger, { projectRoot });
  await assert.rejects(
    () => queue.send(messages, message('recover-policy'), queueInput('recover-policy')),
    /owned precommit failure/,
  );
  assert.equal(messages.getByIdempotencyKey('owner-1', 'thread-admission', 'recover-policy'), null);
  assert.equal((await ledger.list('thread-admission')).length, 0);
  saveMessageDispositionPreference(projectRoot, { scope: 'global', disposition: 'continue_current' });
  fail = false;
  const recovered = await queue.send(messages, message('recover-policy'), queueInput('recover-policy'));
  assert.equal(recovered.deduped, false);
  assert.equal(recovered.entry.delivery.authorIntentByTarget.opus.requested, 'continue_current');
});
