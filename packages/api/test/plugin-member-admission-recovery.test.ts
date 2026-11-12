import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { pluginSentMessageStorageKey } from '../src/domains/plugin/host-surface/plugin-sent-message-read.js';
import { MemberSessionJournal } from '../src/domains/plugin/member-sessions/journal.js';
import { createPluginMemberSessions } from '../src/domains/plugin/member-sessions/service.js';
import type { MemberSessionRecord } from '../src/domains/plugin/member-sessions/types.js';
import { memberExecutionKey } from '../src/domains/plugin/member-sessions/validation.js';
import { memberSessionFixture } from './helpers/plugin-member-session-fixture.js';

async function fixture() {
  const f = memberSessionFixture();
  const messages = new MessageStore();
  const port = createPluginMemberSessions({
    ...f.deps,
    canonicalExecution: { messages, turns: new InMemoryTurnExecutionStore() },
  }).forInstance(f.scope());
  const grant = await f.owner(() => port.prepare(f.prepareInput));
  const input = {
    sessionId: grant.sessionId,
    generation: grant.generation,
    executionId: 'original',
    semanticCursor: 7,
    content: '本人安静机会',
  };
  const renew = async () => {
    await f.owner(() => port.revoke(grant.sessionId));
    return f.owner(() => port.prepare(f.prepareInput), 'new-owner-grant');
  };
  const lookup = () =>
    port.getExecution({ sessionId: input.sessionId, generation: input.generation, executionId: input.executionId });
  const append = () =>
    messages.append({
      userId: 'owner',
      threadId: 'game-thread',
      from: { kind: 'plugin', instanceId: 'installed' },
      content: input.content,
      mentions: [],
      timestamp: 100,
      idempotencyKey: pluginSentMessageStorageKey('installed', memberExecutionKey(input)),
      extra: {
        pluginMessage: {
          instanceId: 'installed',
          revision: 1,
          provenance: { epistemicStatus: 'observation' },
          elements: [],
        },
      },
    });
  return { ...f, port, input, renew, lookup, append };
}

test('a renewed archived reserve proves it never dispatched, without inventing a child outcome or changing its audit', async () => {
  const f = await fixture();
  f.deps.messaging.findSent = async () => {
    throw new Error('crash_after_reserve');
  };
  await assert.rejects(f.port.execute(f.input), /crash_after_reserve/);
  assert.equal((await f.lookup())?.admissionState, undefined, 'the current grant can still dispatch');
  await f.renew();
  const before = structuredClone([...f.rows]);
  const receipt = await f.lookup();
  assert.equal(receipt?.phase, 'admitting');
  assert.equal(receipt?.admissionState, 'not_dispatched');
  assert.equal(receipt?.messageId, undefined);
  assert.equal(receipt?.invocationId, undefined);
  assert.equal(f.sends(), 0);
  assert.deepEqual([...f.rows], before, 'lookup must not rewrite the immutable reserve or new grant');
});

test('renewal while the original lookup awaits prevents its later send and preserves the unclaimed reserve fact', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.deps.messaging.findSent = async () => {
    entered();
    await waiting;
    return null;
  };
  const attempt = f.port.execute(f.input);
  const rejected = assert.rejects(attempt, /generation_changed/);
  await reached;
  await f.renew();
  assert.equal((await f.lookup())?.admissionState, 'not_dispatched');
  release();
  await rejected;
  assert.equal(f.sends(), 0);
});

test('an in-flight send cannot be called unsubmitted when its append is not yet visible', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const send = f.deps.messaging.send;
  f.deps.messaging.send = async (input) => {
    entered();
    await waiting;
    f.append();
    await send(input);
  };
  const attempt = f.port.execute(f.input);
  const rejected = assert.rejects(attempt, /generation_changed/);
  await reached;
  await f.renew();
  assert.equal((await f.lookup())?.admissionState, undefined);
  release();
  await rejected;
  assert.equal((await f.lookup())?.admissionState, undefined);
  assert.equal(f.sends(), 1);
});

test('a real source appended before a lost ACK blocks the unsubmitted projection even if the archived phase is admitting', async () => {
  const f = await fixture();
  f.afterSend(async () => {
    f.append();
    throw new Error('lost_send_ack');
  });
  await assert.rejects(f.port.execute(f.input), /lost_send_ack/);
  await f.renew();
  assert.equal((await f.lookup())?.phase, 'admitting');
  assert.equal((await f.lookup())?.admissionState, undefined);
  assert.equal(f.sends(), 1);
});

test('legacy reserves without a dispatch fence stay uncertain rather than becoming absence proof', async () => {
  const f = await fixture();
  f.deps.messaging.findSent = async () => {
    throw new Error('crash_after_reserve');
  };
  await assert.rejects(f.port.execute(f.input), /crash_after_reserve/);
  const saved = await f.deps.storage.get('grants', f.input.sessionId);
  assert.ok(saved);
  const row = saved.value as MemberSessionRecord;
  const { dispatchStarted: _marker, ...legacy } = row.executions[f.input.executionId];
  await f.deps.storage.compareAndSet('grants', f.input.sessionId, saved.revision, {
    ...row,
    executions: { ...row.executions, [f.input.executionId]: legacy },
  });
  await f.renew();
  assert.equal((await f.lookup())?.admissionState, undefined);
});

test('an existing raw source blocks absence proof even for a reserve explicitly marked unclaimed', async () => {
  const f = await fixture();
  f.deps.messaging.findSent = async () => {
    throw new Error('crash_after_reserve');
  };
  await assert.rejects(f.port.execute(f.input), /crash_after_reserve/);
  f.append();
  await f.renew();
  assert.equal((await f.lookup())?.dispatchStarted, false);
  assert.equal((await f.lookup())?.admissionState, undefined);
});

test('a stale grant archive cannot erase an already-started dispatch fence', async () => {
  const f = await fixture();
  f.deps.messaging.findSent = async () => {
    throw new Error('crash_after_reserve');
  };
  await assert.rejects(f.port.execute(f.input), /crash_after_reserve/);
  const reserve = await f.lookup();
  assert.ok(reserve);
  const journal = new MemberSessionJournal(f.deps.storage);
  await journal.archiveExecution(f.input, { ...reserve, dispatchStarted: true });
  await journal.archiveExecution(f.input, reserve);
  assert.equal((await journal.execution(f.input, f.input.executionId))?.dispatchStarted, true);
  await f.renew();
  assert.equal((await f.lookup())?.admissionState, undefined);
});
