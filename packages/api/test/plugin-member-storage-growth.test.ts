import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { RedisPluginPrivateStorage } from '../src/domains/plugin/host-surface/plugin-private-storage.js';
import { createPluginMemberSessions } from '../src/domains/plugin/member-sessions/service.js';
import type { ExecuteMemberSession, MemberSessionServices } from '../src/domains/plugin/member-sessions/types.js';
import { memberExecutionKey } from '../src/domains/plugin/member-sessions/validation.js';
import { FakeStorageRedis } from './helpers/fake-plugin-storage-redis.js';
import { memberSessionFixture } from './helpers/plugin-member-session-fixture.js';

function fixture() {
  const f = memberSessionFixture(),
    redis = new FakeStorageRedis();
  const storage = new RedisPluginPrivateStorage(redis as unknown as RedisClient, 'host-member-sessions:v1');
  const turns = new InMemoryTurnExecutionStore(),
    messages = new MessageStore();
  let crash = false;
  const writes: MemberSessionServices['storage'] = {
    get: (...args) => storage.get(...args),
    compareAndSet: (...args) => {
      if (crash && args[0] === 'grants') {
        crash = false;
        throw new Error('simulated_host_exit');
      }
      return storage.compareAndSet(...args);
    },
  };
  const service = () =>
    createPluginMemberSessions({ ...f.deps, storage: writes, canonicalExecution: { turns, messages } });
  return {
    ...f,
    redis,
    storage,
    turns,
    messages,
    service,
    port: service().forInstance(f.scope()),
    crashBeforeGrantWrite: () => {
      crash = true;
    },
  };
}

async function completedChild(f: ReturnType<typeof fixture>, input: ExecuteMemberSession, messageId: string) {
  const invocationId = `child-${input.executionId}`,
    at = input.semanticCursor * 10;
  f.turns.createRunning({
    invocationId,
    parentInvocationId: 'parent',
    userId: 'owner',
    threadId: 'game-thread',
    catId: createCatId('member'),
    executionKind: 'ordinary',
    providerLifecycleTracked: true,
    startedAt: at,
    causal: { triggerMessageId: messageId },
  });
  f.turns.markProviderStarted(invocationId, at + 1);
  const response = f.messages.append({
    userId: 'owner',
    threadId: 'game-thread',
    from: { kind: 'agent', catId: createCatId('member') },
    content: '',
    mentions: [],
    timestamp: at,
    lifecycle: {
      kind: 'response',
      orderKey: `${at}:${invocationId}`,
      invocationId,
      targetId: 'member',
      inputEntryIds: [`entry-${input.executionId}`],
      inputMessageIds: [messageId],
      status: 'processing',
      startedAt: at,
    },
  });
  const claim = {
    sessionId: input.sessionId,
    generation: input.generation,
    executionId: input.executionId,
    invocationId,
    responseMessageId: response.id,
  };
  await f.service().hostExecutionsForInstance(f.scope()).claim(claim);
  f.turns.transitionTerminal(invocationId, { status: 'succeeded', endedAt: at + 2, providerTeardownAt: at + 2 });
  f.messages.commitLifecycleResponseTerminal(response.id, {
    invocationId,
    status: 'completed',
    completedAt: at + 2,
    content: 'fixture response',
    mentions: [],
  });
  return claim;
}

test('continuous member inputs stay recoverable beyond the actual storage single-value bound', async () => {
  const f = fixture();
  const session = await f.owner(() => f.port.prepare(f.prepareInput));
  let firstInput: ExecuteMemberSession | undefined, firstMessageId: string | undefined;
  for (let i = 1; i <= 32; i++) {
    const input = {
      sessionId: session.sessionId,
      generation: session.generation,
      executionId: `event-${i}`,
      semanticCursor: i,
      content: `local-event-${i}:${'x'.repeat(60000)}`,
    };
    const queued = await f.port.execute(input);
    assert.ok(queued.messageId);
    if (i === 1) {
      firstInput = input;
      firstMessageId = queued.messageId;
    }
    const claim = await completedChild(f, input, queued.messageId);
    await f.service().hostExecutionsForInstance(f.scope()).settle(claim);
  }
  assert.ok(firstInput);
  assert.equal((await f.service().forInstance(f.scope()).execute(firstInput)).messageId, firstMessageId);
  assert.equal((await f.port.get(session.sessionId))?.consumedCursor, 32);
  assert.equal(f.sends(), 32);
  assert.deepEqual(f.redis.ttlCommands, []);
});

test('repeated explicit regrants preserve their records without growing one authority value without bound', async () => {
  const f = fixture();
  let session = await f.owner(() => f.port.prepare(f.prepareInput));
  for (let i = 1; i <= 32; i++) {
    await f.port.execute({
      sessionId: session.sessionId,
      generation: session.generation,
      executionId: 'initial-event',
      semanticCursor: 1,
      content: `generation-${i}:${'x'.repeat(60000)}`,
    });
    await f.owner(() => f.port.revoke(session.sessionId));
    session = await f.owner(() => f.port.prepare(f.prepareInput), `owner-game-${i}`);
  }
  assert.equal(session.generation, 33);
  assert.equal(f.sends(), 32);
  for (let generation = 1; generation <= 32; generation++) {
    const grant = await f.storage.get('grant-history', `${session.sessionId}:${generation}`);
    const saved = await f.storage.get(
      'executions',
      memberExecutionKey({ sessionId: session.sessionId, generation, executionId: 'initial-event' }),
    );
    assert.ok(grant);
    assert.ok(saved);
    const { execution } = saved.value as { execution: { content: string; messageId: string } };
    assert.equal(execution.content, `generation-${generation}:${'x'.repeat(60000)}`);
    assert.equal(execution.messageId, generation === 1 ? 'canonical-trigger' : `canonical-trigger-${generation}`);
  }
  assert.deepEqual(f.redis.ttlCommands, []);
});

test('a Host exit after the terminal receipt is durable recovers the original result and cursor without a new wake', async () => {
  const f = fixture();
  const session = await f.owner(() => f.port.prepare(f.prepareInput));
  const input = {
    sessionId: session.sessionId,
    generation: session.generation,
    executionId: 'crash-gap',
    semanticCursor: 1,
    content: 'own visible event',
  };
  const queued = await f.port.execute(input);
  assert.ok(queued.messageId);
  const claim = await completedChild(f, input, queued.messageId);
  f.crashBeforeGrantWrite();
  await assert.rejects(() => f.service().hostExecutionsForInstance(f.scope()).settle(claim), /simulated_host_exit/);
  assert.equal((await f.port.get(session.sessionId))?.consumedCursor, 0);
  const restored = f.service().forInstance(f.scope());
  const original = await restored.execute(input);
  assert.equal(original.phase, 'succeeded');
  assert.equal(original.messageId, queued.messageId);
  assert.equal((await restored.get(session.sessionId))?.consumedCursor, 1);
  assert.equal(f.sends(), 1);
  const next = await restored.execute({ ...input, executionId: 'after-recovery', semanticCursor: 2 });
  assert.notEqual(next.messageId, queued.messageId);
  assert.equal((await restored.execute(input)).messageId, queued.messageId);
  assert.equal(
    (await restored.execute({ ...input, executionId: 'after-recovery', semanticCursor: 2 })).messageId,
    next.messageId,
  );
  assert.equal(f.sends(), 2);
  assert.deepEqual(f.redis.ttlCommands, []);
});
