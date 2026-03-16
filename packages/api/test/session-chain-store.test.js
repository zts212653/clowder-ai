/**
 * SessionChainStore Tests (in-memory)
 * F24: Thread → N Sessions per cat, context health tracking.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('SessionChainStore', () => {
  async function createStore() {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    return new SessionChainStore();
  }

  const BASE_INPUT = {
    cliSessionId: 'cli-sess-1',
    threadId: 'thread-1',
    catId: 'opus',
    userId: 'user-1',
  };

  test('create() returns SessionRecord with correct initial state', async () => {
    const store = await createStore();
    const record = store.create(BASE_INPUT);

    assert.ok(record.id.length > 0, 'should have an id');
    assert.equal(record.cliSessionId, 'cli-sess-1');
    assert.equal(record.threadId, 'thread-1');
    assert.equal(record.catId, 'opus');
    assert.equal(record.userId, 'user-1');
    assert.equal(record.seq, 0, 'first session should be seq 0');
    assert.equal(record.status, 'active');
    assert.equal(record.messageCount, 0);
    assert.ok(record.createdAt > 0);
    assert.equal(record.createdAt, record.updatedAt);
  });

  test('create() auto-increments seq for same cat+thread', async () => {
    const store = await createStore();
    const r0 = store.create(BASE_INPUT);
    // Seal the first so a second can be created
    store.update(r0.id, { status: 'sealed' });
    const r1 = store.create({ ...BASE_INPUT, cliSessionId: 'cli-sess-2' });

    assert.equal(r0.seq, 0);
    assert.equal(r1.seq, 1);
    assert.notEqual(r0.id, r1.id);
  });

  test('create() different cat starts at seq 0', async () => {
    const store = await createStore();
    store.create(BASE_INPUT);
    const codexRecord = store.create({ ...BASE_INPUT, catId: 'codex', cliSessionId: 'cli-codex-1' });

    assert.equal(codexRecord.seq, 0);
  });

  test('get() returns record by id', async () => {
    const store = await createStore();
    const created = store.create(BASE_INPUT);
    const found = store.get(created.id);

    assert.ok(found);
    assert.equal(found.id, created.id);
    assert.equal(found.catId, 'opus');
  });

  test('get() returns null for non-existent id', async () => {
    const store = await createStore();
    assert.equal(store.get('non-existent'), null);
  });

  test('getActive() returns active session for cat+thread', async () => {
    const store = await createStore();
    const created = store.create(BASE_INPUT);
    const active = store.getActive('opus', 'thread-1');

    assert.ok(active);
    assert.equal(active.id, created.id);
    assert.equal(active.status, 'active');
  });

  test('getActive() returns null when no active session', async () => {
    const store = await createStore();
    assert.equal(store.getActive('opus', 'thread-1'), null);
  });

  test('getActive() returns null after session is sealed', async () => {
    const store = await createStore();
    const created = store.create(BASE_INPUT);
    store.update(created.id, { status: 'sealed' });

    assert.equal(store.getActive('opus', 'thread-1'), null);
  });

  test('getChain() returns sessions sorted by seq', async () => {
    const store = await createStore();
    const r0 = store.create(BASE_INPUT);
    store.update(r0.id, { status: 'sealed' });
    const r1 = store.create({ ...BASE_INPUT, cliSessionId: 'cli-sess-2' });
    store.update(r1.id, { status: 'sealed' });
    const r2 = store.create({ ...BASE_INPUT, cliSessionId: 'cli-sess-3' });

    const chain = store.getChain('opus', 'thread-1');
    assert.equal(chain.length, 3);
    assert.equal(chain[0].seq, 0);
    assert.equal(chain[1].seq, 1);
    assert.equal(chain[2].seq, 2);
    assert.equal(chain[2].id, r2.id);
  });

  test('getChain() returns empty for unknown cat+thread', async () => {
    const store = await createStore();
    const chain = store.getChain('opus', 'no-such-thread');
    assert.deepEqual(chain, []);
  });

  test('getChainByThread() returns all cats sessions for a thread', async () => {
    const store = await createStore();
    store.create(BASE_INPUT);
    store.create({ ...BASE_INPUT, catId: 'codex', cliSessionId: 'cli-codex-1' });
    store.create({ ...BASE_INPUT, catId: 'gemini', cliSessionId: 'cli-gemini-1' });

    const all = store.getChainByThread('thread-1');
    assert.equal(all.length, 3);
    // Sorted by catId then seq
    const catIds = all.map((r) => r.catId);
    assert.ok(catIds.includes('opus'));
    assert.ok(catIds.includes('codex'));
    assert.ok(catIds.includes('gemini'));
  });

  test('getChainByThread() returns empty for unknown thread', async () => {
    const store = await createStore();
    assert.deepEqual(store.getChainByThread('unknown'), []);
  });

  test('update() changes status and updatedAt', async () => {
    const store = await createStore();
    const record = store.create(BASE_INPUT);
    const before = record.updatedAt;

    await new Promise((r) => setTimeout(r, 5));
    const updated = store.update(record.id, { status: 'sealing' });

    assert.ok(updated);
    assert.equal(updated.status, 'sealing');
    assert.ok(updated.updatedAt >= before);
  });

  test('update() stores contextHealth', async () => {
    const store = await createStore();
    const record = store.create(BASE_INPUT);

    const health = {
      usedTokens: 50000,
      windowTokens: 200000,
      fillRatio: 0.25,
      source: 'exact',
      measuredAt: Date.now(),
    };

    const updated = store.update(record.id, { contextHealth: health });
    assert.ok(updated);
    assert.deepEqual(updated.contextHealth, health);
    assert.equal(updated.contextHealth.fillRatio, 0.25);
  });

  test('update() changes cliSessionId and updates index', async () => {
    const store = await createStore();
    const record = store.create(BASE_INPUT);

    store.update(record.id, { cliSessionId: 'cli-new' });

    assert.equal(store.getByCliSessionId('cli-new').id, record.id);
    assert.equal(store.getByCliSessionId('cli-sess-1'), null, 'old CLI session ID should be unlinked');
  });

  test('update() returns null for non-existent id', async () => {
    const store = await createStore();
    assert.equal(store.update('non-existent', { status: 'sealed' }), null);
  });

  test('update() sealing removes from active index', async () => {
    const store = await createStore();
    const record = store.create(BASE_INPUT);
    assert.ok(store.getActive('opus', 'thread-1'));

    store.update(record.id, { status: 'sealing' });
    assert.equal(store.getActive('opus', 'thread-1'), null);
  });

  test('getByCliSessionId() returns correct record', async () => {
    const store = await createStore();
    const record = store.create(BASE_INPUT);
    const found = store.getByCliSessionId('cli-sess-1');

    assert.ok(found);
    assert.equal(found.id, record.id);
  });

  test('getByCliSessionId() returns null for unknown CLI session', async () => {
    const store = await createStore();
    assert.equal(store.getByCliSessionId('non-existent'), null);
  });

  test('size property reflects record count', async () => {
    const store = await createStore();
    assert.equal(store.size, 0);
    store.create(BASE_INPUT);
    assert.equal(store.size, 1);
    store.create({ ...BASE_INPUT, catId: 'codex', cliSessionId: 'cli-codex-1' });
    assert.equal(store.size, 2);
  });

  test('update() stores sealReason and sealedAt', async () => {
    const store = await createStore();
    const record = store.create(BASE_INPUT);
    const sealedAt = Date.now();

    store.update(record.id, { status: 'sealed', sealReason: 'threshold', sealedAt });

    const sealed = store.get(record.id);
    assert.equal(sealed.status, 'sealed');
    assert.equal(sealed.sealReason, 'threshold');
    assert.equal(sealed.sealedAt, sealedAt);
  });

  test('update() increments messageCount', async () => {
    const store = await createStore();
    const record = store.create(BASE_INPUT);
    assert.equal(record.messageCount, 0);

    store.update(record.id, { messageCount: 5 });
    assert.equal(store.get(record.id).messageCount, 5);
  });

  test('P2 regression: eviction does not break active session lookup', async () => {
    const store = await createStore();
    // Create an active session in thread A
    const active = store.create({
      cliSessionId: 'cli-active',
      threadId: 'thread-A',
      catId: 'opus',
      userId: 'user-1',
    });

    // Fill up to MAX_RECORDS with other thread sessions
    for (let i = 0; i < 1000; i++) {
      store.create({
        cliSessionId: `cli-fill-${i}`,
        threadId: 'thread-fill',
        catId: 'opus',
        userId: 'user-1',
      });
    }

    // The active session in thread A should still be findable
    const found = store.getActive('opus', 'thread-A');
    assert.ok(found, 'active session should survive eviction');
    assert.equal(found.id, active.id);

    // CLI index should also still work
    const byCli = store.getByCliSessionId('cli-active');
    assert.ok(byCli, 'CLI index should survive eviction');
    assert.equal(byCli.id, active.id);
  });

  test('P2 regression: create() throws when all records are truly active and at capacity', async () => {
    const store = await createStore();
    // Fill with 1000 unique threads — each has exactly 1 truly active session
    for (let i = 0; i < 1000; i++) {
      store.create({
        cliSessionId: `cli-${i}`,
        threadId: `thread-${i}`,
        catId: 'opus',
        userId: 'user-1',
      });
    }
    assert.equal(store.size, 1000);

    // The 1001st create should throw, not silently evict an active session
    assert.throws(
      () =>
        store.create({
          cliSessionId: 'cli-overflow',
          threadId: 'thread-overflow',
          catId: 'opus',
          userId: 'user-1',
        }),
      (err) => {
        assert.ok(err.message.includes('capacity'));
        return true;
      },
    );

    // All 1000 existing active sessions should still be intact
    for (let i = 0; i < 1000; i++) {
      const found = store.getActive('opus', `thread-${i}`);
      assert.ok(found, `thread-${i} active should still exist`);
    }
  });

  test('update() persists consecutiveRestoreFailures (F118 AC-C6)', async () => {
    const store = await createStore();
    const record = store.create(BASE_INPUT);
    assert.equal(record.consecutiveRestoreFailures, undefined);

    // Increment
    store.update(record.id, { consecutiveRestoreFailures: 1 });
    assert.equal(store.get(record.id).consecutiveRestoreFailures, 1);

    // Increment again
    store.update(record.id, { consecutiveRestoreFailures: 2 });
    assert.equal(store.get(record.id).consecutiveRestoreFailures, 2);

    // Reset to 0
    store.update(record.id, { consecutiveRestoreFailures: 0 });
    assert.equal(store.get(record.id).consecutiveRestoreFailures, 0);
  });
});
