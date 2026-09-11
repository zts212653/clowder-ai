import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { queueEntryId } = await import('../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');

function setup() {
  const messageStore = new MessageStore();
  const invocationQueue = new InvocationQueue();
  const events = [];
  const requestDrain = mock.fn(async () => {
    events.push('drain');
  });
  const tryAutoAppendExactEntry = mock.fn(async () => {
    events.push('append');
    return { outcome: 'rejected' };
  });
  const deps = {
    messageStore,
    invocationQueue,
    queueProcessor: { requestDrain, tryAutoAppendExactEntry },
    socketManager: {
      emitToUser: mock.fn(),
      broadcastAgentMessage: mock.fn(),
    },
    log: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    },
  };
  const appendTrigger = (id) =>
    messageStore.append(
      canonicalTestMessageInput({
        id,
        from: { kind: 'agent', catId: 'opus' },
        userId: 'u1',
        catId: 'opus',
        threadId: 't1',
        content: `source-${id}`,
        mentions: ['codex'],
        timestamp: Date.now(),
      }),
    );
  return { deps, events, invocationQueue, messageStore, appendTrigger };
}

async function enqueue(deps, triggerMessage, targetCats = ['codex']) {
  return enqueueA2ATargets(deps, {
    targetCats,
    content: triggerMessage.content,
    userId: 'u1',
    ownerAuthProvenance: 'strict',
    threadId: 't1',
    triggerMessage,
    callerCatId: 'opus',
    parentInvocationId: 'parent-1',
  });
}

describe('enqueueA2ATargets single durable ledger', () => {
  it('fans one public Agent message into one deterministic source row with pending targets', async () => {
    const { deps, invocationQueue, messageStore, appendTrigger } = setup();
    const trigger = appendTrigger('a2a-source-1');

    const result = await enqueue(deps, trigger, ['codex', 'fable5']);

    assert.deepEqual(result, { enqueued: ['codex', 'fable5'] });
    const rows = invocationQueue.list('t1', 'u1');
    assert.deepEqual(
      rows.map((row) => ({
        id: row.id,
        targets: row.targets,
        messageId: row.payload.messageId,
      })),
      [{ id: queueEntryId(trigger.id), targets: ['codex', 'fable5'], messageId: trigger.id }],
    );
    const persisted = messageStore.getById(trigger.id);
    assert.equal(persisted.queueCustody, undefined);
    assert.equal(persisted.queueCustodyAdmission, undefined);
  });

  it('replay converges by source id and target without duplicating a row', async () => {
    const { deps, invocationQueue, appendTrigger } = setup();
    const trigger = appendTrigger('a2a-source-replay');

    await enqueue(deps, trigger);
    await enqueue(deps, trigger);

    assert.equal(invocationQueue.list('t1', 'u1').length, 1);
    assert.equal(invocationQueue.list('t1', 'u1')[0].id, queueEntryId(trigger.id, 'codex'));
  });

  it('skips a consumed source instead of recreating Queue work after its row is gone', async () => {
    const { deps, invocationQueue, messageStore, appendTrigger, events } = setup();
    const trigger = appendTrigger('a2a-source-consumed');

    await enqueue(deps, trigger);
    const [row] = invocationQueue.list('t1', 'u1');
    assert.ok(row);
    const claim = await invocationQueue.markProcessingDurable('t1', 'u1', {
      entryId: row.id,
      targetCats: ['codex'],
    });
    assert.equal(claim.status, 'claimed');
    assert.equal(await invocationQueue.commitClaimedProcessing('t1', [row.id], Date.now()), true);
    const lifecycle = messageStore.getById(trigger.id)?.lifecycle;
    assert.ok(lifecycle);
    assert.equal(
      messageStore.advanceLifecycleInputDispatch(trigger.id, {
        orderKey: lifecycle.orderKey,
        ...(lifecycle.producerInvocationId ? { producerInvocationId: lifecycle.producerInvocationId } : {}),
        targetId: 'codex',
        phase: 'dispatched',
        statusMessageId: 'a2a-source-consumed-response',
        dispatchedAt: Date.now(),
      }).kind,
      'applied',
    );
    assert.ok(await invocationQueue.removeProcessedAcrossUsersDurable('t1', row.id, 'succeeded'));

    assert.deepEqual(await enqueue(deps, trigger), { enqueued: [] });
    assert.equal(invocationQueue.list('t1', 'u1').length, 0);
    assert.deepEqual(events, ['append', 'drain']);
  });

  it('keeps distinct source bodies as distinct work orders instead of concatenating them', async () => {
    const { deps, invocationQueue, appendTrigger } = setup();
    const first = appendTrigger('a2a-source-first');
    const second = appendTrigger('a2a-source-second');

    await enqueue(deps, first);
    await enqueue(deps, second);

    const rows = invocationQueue.list('t1', 'u1');
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.payload.messageId),
      [first.id, second.id],
    );
    assert.deepEqual(
      rows.map((row) => row.payload.content),
      [first.content, second.content],
    );
  });

  it('applies the chain-depth limit once per source row without splitting its fan-out', async () => {
    const { deps, invocationQueue, appendTrigger } = setup();
    for (let index = 0; index < 9; index += 1) {
      invocationQueue.enqueueDurableNow(
        canonicalTestQueueInput({
          sourceId: `seed-${index}`,
          from: { kind: 'agent', catId: 'opus' },
          threadId: 't1',
          userId: 'u1',
          kind: 'message_wake',
          ownerAuthProvenance: 'strict',
          content: `seed-${index}`,
          messageId: `seed-message-${index}`,
          targetCats: ['codex'],
          sourceCategory: 'a2a',
          intent: 'execute',
          autoExecute: true,
        }),
      );
    }
    const trigger = appendTrigger('a2a-source-depth');

    const result = await enqueue(deps, trigger, ['codex', 'fable5']);

    assert.deepEqual(result, { enqueued: ['codex', 'fable5'] });
    assert.equal(invocationQueue.list('t1', 'u1').length, 10);
  });

  it('offers the row to Active Append without reintroducing ordinary Ball custody', async () => {
    const { deps, events, appendTrigger } = setup();
    deps.ballCustody = {
      record: mock.fn(async () => {
        events.push('ball');
      }),
    };
    const trigger = appendTrigger('a2a-source-order');

    await enqueue(deps, trigger);

    assert.deepEqual(events, ['append', 'drain']);
  });

  it('rejects sources that are not persisted public Agent messages', async () => {
    const { deps } = setup();
    const forged = canonicalTestMessageInput({
      id: 'missing-source',
      from: { kind: 'agent', catId: 'opus' },
      userId: 'u1',
      catId: 'opus',
      threadId: 't1',
      content: 'not persisted',
      mentions: ['codex'],
      timestamp: Date.now(),
    });

    await assert.rejects(enqueue(deps, forged), /persisted public agent source message/);
  });
});
