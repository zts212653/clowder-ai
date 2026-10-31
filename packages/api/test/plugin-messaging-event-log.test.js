/**
 * K-1 / F288 — event log store (plan Task 6 substrate)
 * INV-3 per-thread monotonic sequence; D-3 eventKey dedupe; retention trim floor.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

/** @type {typeof import('../dist/domains/messaging/stores/memory.js')} */
let memory;
let log;

beforeEach(async () => {
  memory = await import('../dist/domains/messaging/stores/memory.js');
  log = new memory.MemoryEventLogStore();
});

const RETENTION = 5;

function publishEvent(threadId, messageId) {
  return {
    eventId: `ev-${messageId}`,
    type: 'message.publish',
    envelope: {
      messageId,
      revision: 1,
      threadId,
      actor: { kind: 'plugin', id: 'inst-a' },
      audience: { kind: 'public' },
      occurredAt: '2026-07-15T00:00:00.000Z',
      payload: {
        provenance: { origin: { kind: 'plugin', instanceId: 'inst-a' }, epistemicStatus: 'inference' },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'x' } }],
      },
    },
  };
}

describe('MemoryEventLogStore — sequence assignment (INV-3)', () => {
  test('assigns strictly monotonic 1..n per thread', async () => {
    const r1 = await log.append('t1', 'k1', publishEvent('t1', 'm1'), RETENTION);
    const r2 = await log.append('t1', 'k2', publishEvent('t1', 'm2'), RETENTION);
    const r3 = await log.append('t1', 'k3', publishEvent('t1', 'm3'), RETENTION);
    assert.deepEqual(
      [r1, r2, r3].map((r) => r.sequence),
      [1, 2, 3],
    );
    assert.deepEqual(
      [r1, r2, r3].map((r) => r.deduped),
      [false, false, false],
    );
    const events = await log.readAfter('t1', 0, 10);
    assert.deepEqual(
      events.map((e) => e.sequence),
      [1, 2, 3],
    );
  });

  test('threads have independent counters', async () => {
    await log.append('t1', 'k1', publishEvent('t1', 'm1'), RETENTION);
    const other = await log.append('t2', 'k1', publishEvent('t2', 'm1'), RETENTION);
    assert.equal(other.sequence, 1);
  });

  test('D-3: same eventKey within retained window dedupes to the original sequence', async () => {
    const first = await log.append('t1', 'publish:m1:1', publishEvent('t1', 'm1'), RETENTION);
    const retry = await log.append('t1', 'publish:m1:1', publishEvent('t1', 'm1'), RETENTION);
    assert.equal(retry.deduped, true);
    assert.equal(retry.sequence, first.sequence);
    assert.equal((await log.readAfter('t1', 0, 10)).length, 1);
  });
});

describe('MemoryEventLogStore — reads and retention', () => {
  test('readAfter returns ascending events after cursor, bounded by limit', async () => {
    for (let i = 1; i <= 4; i += 1) {
      await log.append('t1', `k${i}`, publishEvent('t1', `m${i}`), RETENTION);
    }
    const events = await log.readAfter('t1', 1, 2);
    assert.deepEqual(
      events.map((e) => e.sequence),
      [2, 3],
    );
  });

  test('retention trim: oldest events drop, floor rises, head keeps counting', async () => {
    for (let i = 1; i <= 8; i += 1) {
      await log.append('t1', `k${i}`, publishEvent('t1', `m${i}`), RETENTION);
    }
    assert.equal(await log.headSequence('t1'), 8);
    assert.equal(await log.minSequence('t1'), 4); // kept: 4..8 (retention 5)
    const events = await log.readAfter('t1', 0, 100);
    assert.deepEqual(
      events.map((e) => e.sequence),
      [4, 5, 6, 7, 8],
    );
  });

  test('empty thread: minSequence null, headSequence 0, readAfter empty', async () => {
    assert.equal(await log.minSequence('t-empty'), null);
    assert.equal(await log.headSequence('t-empty'), 0);
    assert.deepEqual(await log.readAfter('t-empty', 0, 10), []);
  });

  test('trimmed eventKey no longer dedupes (documented window-bounded dedupe)', async () => {
    await log.append('t1', 'kX', publishEvent('t1', 'mX'), RETENTION);
    for (let i = 1; i <= 6; i += 1) {
      await log.append('t1', `k${i}`, publishEvent('t1', `m${i}`), RETENTION);
    }
    const again = await log.append('t1', 'kX', publishEvent('t1', 'mX'), RETENTION);
    assert.equal(again.deduped, false);
    assert.equal(again.sequence, 8);
  });
});
