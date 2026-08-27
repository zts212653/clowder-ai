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

  test('#1329 getOrCreateActive() creates one unbound logical node and reuses it', async () => {
    const store = await createStore();
    const input = {
      threadId: 'thread-logical',
      catId: 'opus',
      userId: 'user-1',
      compressionCount: null,
    };

    const first = store.getOrCreateActive(input);
    const second = store.getOrCreateActive(input);

    assert.equal(first.id, second.id);
    assert.equal(first.cliSessionId, undefined);
    assert.equal(first.compressionCount, null);
    assert.equal(store.getChain('opus', 'thread-logical').length, 1);
  });

  test('#1329 logical active ownership includes userId on a shared thread', async () => {
    const store = await createStore();
    const ownerA = { threadId: 'default', catId: 'opus', userId: 'user-a', compressionCount: null };
    const ownerB = { threadId: 'default', catId: 'opus', userId: 'user-b', compressionCount: null };

    const firstA = store.getOrCreateActive(ownerA);
    const firstB = store.getOrCreateActive(ownerB);
    const secondA = store.getOrCreateActive(ownerA);
    const secondB = store.getOrCreateActive(ownerB);

    assert.notEqual(firstA.id, firstB.id);
    assert.equal(firstA.seq, 0);
    assert.equal(firstB.seq, 0);
    assert.equal(secondA.id, firstA.id);
    assert.equal(secondB.id, firstB.id);
    assert.equal(store.getActive('opus', 'default', 'user-a').id, firstA.id);
    assert.equal(store.getActive('opus', 'default', 'user-b').id, firstB.id);
    assert.equal(store.getChain('opus', 'default', 'user-a').length, 1);
    assert.equal(store.getChain('opus', 'default', 'user-b').length, 1);

    store.update(firstA.id, { status: 'sealed' });
    const nextA = store.getOrCreateActive({ ...ownerA, cliSessionId: 'cli-owner-a-next' });
    assert.equal(nextA.seq, 1);
  });

  test('#1329 bindCliSessionId() attaches runtime identity to the existing logical node', async () => {
    const store = await createStore();
    const logical = store.getOrCreateActive({
      threadId: 'thread-logical',
      catId: 'opus',
      userId: 'user-1',
      compressionCount: null,
    });

    const bound = store.bindCliSessionId(logical.id, 'cli-late');
    assert.equal(bound.id, logical.id);
    assert.equal(bound.cliSessionId, 'cli-late');
    assert.equal(store.getByCliSessionId('cli-late').id, logical.id);
    assert.equal(store.getChain('opus', 'thread-logical').length, 1);
  });

  test('#1329 applyPolicySnapshot resets hybrid progress only when the revision changes', async () => {
    const store = await createStore();
    const logical = store.getOrCreateActive({
      threadId: 'thread-policy',
      catId: 'opus',
      userId: 'user-1',
      compressionCount: 0,
    });
    const snapshot = {
      config: { strategy: 'hybrid', thresholds: { warn: 0.75, action: 0.85 }, hybrid: { maxCompressions: 2 } },
      source: 'runtime_override',
      revision: 'revision-a',
      changedAt: 10,
      execution: { status: 'active', missingCapabilities: [] },
    };

    store.applyPolicySnapshot(logical.id, snapshot);
    store.recordCompressionEvent(logical.id, 'revision-a', 'inv-policy');
    store.applyPolicySnapshot(logical.id, snapshot);
    assert.equal(store.get(logical.id).hybridProgress.observedCount, 1);

    store.applyPolicySnapshot(logical.id, { ...snapshot, revision: 'revision-b', changedAt: 20 });
    const updated = store.get(logical.id);
    assert.equal(updated.appliedPolicy.revision, 'revision-b');
    assert.deepEqual(updated.hybridProgress, {
      policyRevision: 'revision-b',
      observedCount: 0,
      startedAt: updated.hybridProgress.startedAt,
    });
  });

  test('#1329 records hybrid progress atomically without inventing an unknown lifetime total', async () => {
    const store = await createStore();
    const logical = store.getOrCreateActive({
      threadId: 'thread-progress',
      catId: 'opus',
      userId: 'user-1',
      compressionCount: null,
    });
    const snapshot = {
      config: { strategy: 'hybrid', thresholds: { warn: 0.75, action: 0.85 }, hybrid: { maxCompressions: 2 } },
      source: 'runtime_override',
      revision: 'revision-a',
      changedAt: 10,
      execution: { status: 'active', missingCapabilities: [] },
    };
    store.applyPolicySnapshot(logical.id, snapshot);

    const first = store.recordCompressionEvent(logical.id, 'revision-a', 'inv-first');
    const second = store.recordCompressionEvent(logical.id, 'revision-a', 'inv-second');
    const stale = store.recordCompressionEvent(logical.id, 'revision-old', 'inv-stale-policy');

    assert.equal(first.revisionMatched, true);
    assert.equal(second.hybridProgress.observedCount, 2);
    assert.equal(second.compressionCount, null);
    assert.equal(stale.revisionMatched, false);
    assert.equal(stale.hybridProgress.observedCount, 2);
    assert.equal(store.get(logical.id).compressionCount, null);
    assert.deepEqual(store.get(logical.id).compressionObservation, {
      invocationId: 'inv-stale-policy',
      sequence: 2,
      observedAt: store.get(logical.id).updatedAt,
    });
  });

  test('#1329 increments lifetime telemetry only when zero was actually observed', async () => {
    const store = await createStore();
    const logical = store.getOrCreateActive({
      threadId: 'thread-observed',
      catId: 'opus',
      userId: 'user-1',
      compressionCount: 0,
    });
    const snapshot = {
      config: { strategy: 'compress', thresholds: { warn: 0.75, action: 0.85 } },
      source: 'runtime_override',
      revision: 'revision-compress',
      changedAt: 10,
      execution: { status: 'active', missingCapabilities: [] },
    };
    store.applyPolicySnapshot(logical.id, snapshot);

    const event = store.recordCompressionEvent(logical.id, 'revision-compress', 'inv-compress');
    assert.equal(event.compressionCount, 1);
    assert.equal(event.hybridProgress, null);
    assert.deepEqual(store.get(logical.id).compressionObservation, {
      invocationId: 'inv-compress',
      sequence: 1,
      observedAt: store.get(logical.id).updatedAt,
    });
  });

  test('#1329 Redis result decoding preserves unknown counters when fields are absent', async () => {
    const { RedisSessionChainStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisSessionChainStore.js'
    );
    const store = new RedisSessionChainStore({
      eval: async () => ['recorded'],
    });
    store.get = async () => ({
      hybridProgress: {
        policyRevision: 'revision-a',
        observedCount: 7,
        startedAt: 10,
      },
    });

    const event = await store.recordCompressionEvent('session-a', 'revision-a', 'inv-redis-decode');

    assert.equal(event.compressionCount, null);
    assert.equal(event.hybridProgress.observedCount, 7);
  });

  test('create() and update() preserve workspace binding metadata', async () => {
    const store = await createStore();
    const record = store.create({
      ...BASE_INPUT,
      workingDirectory: '/repo-a',
      workspaceFingerprint: '/repo-a',
    });

    assert.equal(record.workingDirectory, '/repo-a');
    assert.equal(record.workspaceFingerprint, '/repo-a');

    store.update(record.id, {
      workingDirectory: '/repo-b',
      workspaceFingerprint: '/repo-b',
    });

    const updated = store.get(record.id);
    assert.equal(updated.workingDirectory, '/repo-b');
    assert.equal(updated.workspaceFingerprint, '/repo-b');
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

  test('update() stores the active session capacity pin', async () => {
    const store = await createStore();
    const record = store.create(BASE_INPUT);
    const capacityPin = {
      windowTokens: 200_000,
      inputCeilingTokens: 184_000,
      source: 'reported',
      provenance: 'Carrier reported 200,000 tokens',
      actionable: true,
    };

    const updated = store.update(record.id, { capacityPin });

    assert.ok(updated);
    assert.deepEqual(updated.capacityPin, capacityPin);
    assert.deepEqual(store.getActive('opus', 'thread-1').capacityPin, capacityPin);
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

  test('update() active restores active index and can clear seal metadata', async () => {
    const store = await createStore();
    const record = store.create(BASE_INPUT);
    const sealedAt = Date.now();

    store.update(record.id, { status: 'sealed', sealReason: 'external_registration_failed', sealedAt });
    assert.equal(store.getActive('opus', 'thread-1'), null);

    store.update(record.id, { status: 'active', sealReason: null, sealedAt: null });

    const reopened = store.get(record.id);
    assert.equal(reopened.status, 'active');
    assert.equal(reopened.sealReason, undefined);
    assert.equal(reopened.sealedAt, undefined);
    assert.equal(store.getActive('opus', 'thread-1')?.id, record.id);
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

  test('#1329 capacity eviction preserves every owner-scoped active session on the shared default thread', async () => {
    const store = await createStore();
    const first = store.create({
      cliSessionId: 'cli-owner-0',
      threadId: 'default',
      catId: 'opus',
      userId: 'user-0',
    });
    for (let i = 1; i < 1000; i++) {
      store.create({
        cliSessionId: `cli-owner-${i}`,
        threadId: 'default',
        catId: 'opus',
        userId: `user-${i}`,
      });
    }

    assert.throws(
      () =>
        store.create({
          cliSessionId: 'cli-owner-overflow',
          threadId: 'default',
          catId: 'opus',
          userId: 'user-overflow',
        }),
      /capacity/,
    );
    assert.equal(store.getActive('opus', 'default', 'user-0')?.id, first.id);
    assert.equal(store.getByCliSessionId('cli-owner-0')?.id, first.id);
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

  // ── F198 Bug #3: chainKey stable conversation anchor (bg carrier) ──

  test('create() persists chainKey when provided', async () => {
    const store = await createStore();
    const record = store.create({ ...BASE_INPUT, chainKey: 'bg:thread-1:opus' });
    assert.equal(record.chainKey, 'bg:thread-1:opus');
  });

  test('getByChainKey() returns the record for a known chainKey', async () => {
    const store = await createStore();
    const created = store.create({ ...BASE_INPUT, chainKey: 'bg:thread-1:opus' });
    const found = store.getByChainKey('bg:thread-1:opus');
    assert.ok(found, 'should find record by chainKey');
    assert.equal(found.id, created.id);
  });

  test('getByChainKey() returns null for an unknown chainKey', async () => {
    const store = await createStore();
    store.create({ ...BASE_INPUT, chainKey: 'bg:thread-1:opus' });
    assert.equal(store.getByChainKey('bg:thread-2:opus'), null);
  });

  test('getByChainKey() returns the record even after it is sealed (write tolerance)', async () => {
    const store = await createStore();
    const created = store.create({ ...BASE_INPUT, chainKey: 'bg:thread-1:opus' });
    store.update(created.id, { status: 'sealed' });
    const found = store.getByChainKey('bg:thread-1:opus');
    assert.ok(found, 'sealed record must still be reachable by chainKey');
    assert.equal(found.id, created.id);
    assert.equal(found.status, 'sealed');
  });

  test('update() persists latestResumeSessionId', async () => {
    const store = await createStore();
    const created = store.create({ ...BASE_INPUT, chainKey: 'bg:thread-1:opus' });
    const uuid = '7c77a04d-1111-2222-3333-444455556666';
    store.update(created.id, { latestResumeSessionId: uuid });
    assert.equal(store.get(created.id).latestResumeSessionId, uuid);
  });

  test('getByChainKey() isolates distinct chainKeys', async () => {
    const store = await createStore();
    const a = store.create({ ...BASE_INPUT, cliSessionId: 'cli-a', chainKey: 'bg:thread-1:opus' });
    const b = store.create({
      ...BASE_INPUT,
      cliSessionId: 'cli-b',
      threadId: 'thread-2',
      chainKey: 'bg:thread-2:opus',
    });
    assert.equal(store.getByChainKey('bg:thread-1:opus').id, a.id);
    assert.equal(store.getByChainKey('bg:thread-2:opus').id, b.id);
  });
});
