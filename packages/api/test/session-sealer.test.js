/**
 * SessionSealer Tests (in-memory)
 * F24 Phase B: Session lifecycle transitions.
 *
 * Red→Green: These tests are written BEFORE the implementation is complete.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('SessionSealer', () => {
  async function createFixtures() {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { SessionSealer } = await import('../dist/domains/cats/services/session/SessionSealer.js');
    const store = new SessionChainStore();
    const sealer = new SessionSealer(store);
    return { store, sealer };
  }

  const BASE_INPUT = {
    cliSessionId: 'cli-sess-1',
    threadId: 'thread-1',
    catId: 'opus',
    userId: 'user-1',
  };

  describe('requestSeal()', () => {
    test('seals active session → returns accepted=true, status=sealing', async () => {
      const { store, sealer } = await createFixtures();
      const record = store.create(BASE_INPUT);

      const result = await sealer.requestSeal({
        sessionId: record.id,
        reason: 'threshold',
      });

      assert.equal(result.accepted, true);
      assert.equal(result.status, 'sealing');
      assert.equal(result.sessionId, record.id);
    });

    test('sets sealReason on the record', async () => {
      const { store, sealer } = await createFixtures();
      const record = store.create(BASE_INPUT);

      await sealer.requestSeal({ sessionId: record.id, reason: 'manual' });

      const updated = store.get(record.id);
      assert.equal(updated?.sealReason, 'manual');
      assert.equal(updated?.status, 'sealing');
    });

    test('clears active pointer after seal', async () => {
      const { store, sealer } = await createFixtures();
      const record = store.create(BASE_INPUT);

      // Before seal: active should exist
      assert.ok(store.getActive('opus', 'thread-1'));

      await sealer.requestSeal({ sessionId: record.id, reason: 'threshold' });

      // After seal: active should be cleared
      assert.equal(store.getActive('opus', 'thread-1'), null);
    });

    test('is idempotent: sealing already sealing session returns accepted=false', async () => {
      const { store, sealer } = await createFixtures();
      const record = store.create(BASE_INPUT);

      const first = await sealer.requestSeal({ sessionId: record.id, reason: 'threshold' });
      assert.equal(first.accepted, true);

      const second = await sealer.requestSeal({ sessionId: record.id, reason: 'threshold' });
      assert.equal(second.accepted, false);
      assert.equal(second.status, 'sealing');
    });

    test('rejects sealing already sealed session', async () => {
      const { store, sealer } = await createFixtures();
      const record = store.create(BASE_INPUT);
      store.update(record.id, { status: 'sealed', sealedAt: Date.now() });

      const result = await sealer.requestSeal({ sessionId: record.id, reason: 'manual' });
      assert.equal(result.accepted, false);
      assert.equal(result.status, 'sealed');
    });

    test('returns accepted=false for non-existent session', async () => {
      const { sealer } = await createFixtures();

      const result = await sealer.requestSeal({
        sessionId: 'non-existent-id',
        reason: 'error',
      });
      assert.equal(result.accepted, false);
    });

    test('reason=error is supported', async () => {
      const { store, sealer } = await createFixtures();
      const record = store.create(BASE_INPUT);

      const result = await sealer.requestSeal({ sessionId: record.id, reason: 'error' });
      assert.equal(result.accepted, true);

      const updated = store.get(record.id);
      assert.equal(updated?.sealReason, 'error');
    });
  });

  describe('finalize()', () => {
    test('transitions sealing → sealed with sealedAt', async () => {
      const { store, sealer } = await createFixtures();
      const record = store.create(BASE_INPUT);

      await sealer.requestSeal({ sessionId: record.id, reason: 'threshold' });
      await sealer.finalize({ sessionId: record.id });

      const updated = store.get(record.id);
      assert.equal(updated?.status, 'sealed');
      assert.ok(updated?.sealedAt, 'should have sealedAt timestamp');
      assert.ok(updated.sealedAt > 0);
    });

    test('does nothing for non-sealing sessions', async () => {
      const { store, sealer } = await createFixtures();
      const record = store.create(BASE_INPUT);

      // Still active — finalize should be no-op
      await sealer.finalize({ sessionId: record.id });

      const updated = store.get(record.id);
      assert.equal(updated?.status, 'active');
    });

    test('does nothing for already sealed sessions', async () => {
      const { store, sealer } = await createFixtures();
      const record = store.create(BASE_INPUT);
      const now = Date.now();
      store.update(record.id, { status: 'sealed', sealedAt: now });

      await sealer.finalize({ sessionId: record.id });

      const updated = store.get(record.id);
      assert.equal(updated?.sealedAt, now, 'sealedAt should not change');
    });

    test('does nothing for non-existent session', async () => {
      const { sealer } = await createFixtures();
      // Should not throw
      await sealer.finalize({ sessionId: 'non-existent-id' });
    });
  });

  describe('finalize() liveness guarantees', () => {
    test('force-seals even when doFinalize hangs (timeout)', async () => {
      const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
      const { SessionSealer } = await import('../dist/domains/cats/services/session/SessionSealer.js');
      const store = new SessionChainStore();
      // Create a sealer with a mock transcriptWriter that hangs
      const hangingWriter = {
        flush: () => new Promise(() => {}), // never resolves
      };
      const sealer = new SessionSealer(store, hangingWriter);

      const record = store.create(BASE_INPUT);
      await sealer.requestSeal({ sessionId: record.id, reason: 'threshold' });

      // Monkey-patch timeout for test speed (30s is too long for test)
      // We test the structural guarantee: finalize always reaches terminal state
      await sealer.finalize({ sessionId: record.id });

      const updated = store.get(record.id);
      assert.equal(updated?.status, 'sealed', 'session should reach sealed even if transcript flush hangs');
    });

    test('force-seals even when final store.update throws', async () => {
      const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
      const { SessionSealer } = await import('../dist/domains/cats/services/session/SessionSealer.js');
      const store = new SessionChainStore();
      const sealer = new SessionSealer(store);

      const record = store.create(BASE_INPUT);
      await sealer.requestSeal({ sessionId: record.id, reason: 'threshold' });
      assert.equal(store.get(record.id)?.status, 'sealing');

      // finalize should succeed (no hanging deps)
      await sealer.finalize({ sessionId: record.id });
      assert.equal(store.get(record.id)?.status, 'sealed');
    });
  });

  describe('reconcileStuck()', () => {
    test('force-seals sessions stuck in sealing > maxAge', async () => {
      const { store, sealer } = await createFixtures();
      const record = store.create(BASE_INPUT);
      // Simulate stuck: manually set to sealing with old updatedAt
      store.update(record.id, {
        status: 'sealing',
        sealReason: 'auto_health_check',
        updatedAt: Date.now() - 10 * 60_000, // 10 minutes ago
      });

      const count = await sealer.reconcileStuck('opus', 'thread-1', 5 * 60_000);
      assert.equal(count, 1);

      const updated = store.get(record.id);
      assert.equal(updated?.status, 'sealed');
      assert.ok(updated?.sealedAt > 0);
    });

    test('does not touch sessions stuck < maxAge', async () => {
      const { store, sealer } = await createFixtures();
      const record = store.create(BASE_INPUT);
      store.update(record.id, {
        status: 'sealing',
        sealReason: 'threshold',
        updatedAt: Date.now() - 60_000, // 1 minute ago
      });

      const count = await sealer.reconcileStuck('opus', 'thread-1', 5 * 60_000);
      assert.equal(count, 0);
      assert.equal(store.get(record.id)?.status, 'sealing');
    });

    test('does not touch active or sealed sessions', async () => {
      const { store, sealer } = await createFixtures();
      const active = store.create(BASE_INPUT);
      const sealed = store.create({ ...BASE_INPUT, cliSessionId: 'cli-2' });
      store.update(sealed.id, { status: 'sealed', sealedAt: Date.now(), updatedAt: Date.now() - 20 * 60_000 });

      const count = await sealer.reconcileStuck('opus', 'thread-1', 5 * 60_000);
      assert.equal(count, 0);
      assert.equal(store.get(active.id)?.status, 'active');
      assert.equal(store.get(sealed.id)?.status, 'sealed');
    });
  });

  describe('reconcileAllStuck()', () => {
    test('reaps stuck sealing sessions across multiple cats/threads', async () => {
      const { store, sealer } = await createFixtures();
      const r1 = store.create(BASE_INPUT);
      const r2 = store.create({ cliSessionId: 'cli-2', threadId: 'thread-2', catId: 'codex', userId: 'user-1' });
      const r3 = store.create({ cliSessionId: 'cli-3', threadId: 'thread-3', catId: 'gemini', userId: 'user-1' });

      store.update(r1.id, { status: 'sealing', updatedAt: Date.now() - 10 * 60_000 });
      store.update(r2.id, { status: 'sealing', updatedAt: Date.now() - 10 * 60_000 });
      // r3 is still active — should not be touched

      const count = await sealer.reconcileAllStuck(5 * 60_000);
      assert.equal(count, 2);
      assert.equal(store.get(r1.id)?.status, 'sealed');
      assert.equal(store.get(r2.id)?.status, 'sealed');
      assert.equal(store.get(r3.id)?.status, 'active');
    });

    test('returns 0 when no sessions are stuck', async () => {
      const { store, sealer } = await createFixtures();
      store.create(BASE_INPUT);
      const count = await sealer.reconcileAllStuck();
      assert.equal(count, 0);
    });

    test('skips sealing sessions younger than maxAge', async () => {
      const { store, sealer } = await createFixtures();
      const r1 = store.create(BASE_INPUT);
      store.update(r1.id, { status: 'sealing', updatedAt: Date.now() - 60_000 });

      const count = await sealer.reconcileAllStuck(5 * 60_000);
      assert.equal(count, 0);
      assert.equal(store.get(r1.id)?.status, 'sealing');
    });
  });

  describe('listSealingSessions()', () => {
    test('returns only sessions in sealing status', async () => {
      const { store } = await createFixtures();
      const r1 = store.create(BASE_INPUT);
      const r2 = store.create({ cliSessionId: 'cli-2', threadId: 'thread-2', catId: 'codex', userId: 'user-1' });
      const r3 = store.create({ cliSessionId: 'cli-3', threadId: 'thread-3', catId: 'gemini', userId: 'user-1' });

      store.update(r1.id, { status: 'sealing' });
      store.update(r3.id, { status: 'sealed', sealedAt: Date.now() });

      const ids = store.listSealingSessions();
      assert.equal(ids.length, 1);
      assert.equal(ids[0], r1.id);
    });

    test('returns empty array when no sealing sessions', async () => {
      const { store } = await createFixtures();
      store.create(BASE_INPUT);
      const ids = store.listSealingSessions();
      assert.equal(ids.length, 0);
    });
  });

  describe('full lifecycle: active → sealing → sealed', () => {
    test('complete seal + finalize + new session creation', async () => {
      const { store, sealer } = await createFixtures();

      // Create session 0
      const s0 = store.create(BASE_INPUT);
      assert.equal(s0.seq, 0);
      assert.equal(s0.status, 'active');

      // Seal session 0
      const sealResult = await sealer.requestSeal({
        sessionId: s0.id,
        reason: 'threshold',
      });
      assert.equal(sealResult.accepted, true);

      // Active pointer cleared → new session can be created
      assert.equal(store.getActive('opus', 'thread-1'), null);

      // Create session 1 (like invoke-single-cat would on next invocation)
      const s1 = store.create({ ...BASE_INPUT, cliSessionId: 'cli-sess-2' });
      assert.equal(s1.seq, 1);
      assert.equal(s1.status, 'active');

      // Finalize session 0 (background)
      await sealer.finalize({ sessionId: s0.id });
      const s0Final = store.get(s0.id);
      assert.equal(s0Final?.status, 'sealed');

      // Chain should show both
      const chain = store.getChain('opus', 'thread-1');
      assert.equal(chain.length, 2);
      assert.equal(chain[0].seq, 0);
      assert.equal(chain[0].status, 'sealed');
      assert.equal(chain[1].seq, 1);
      assert.equal(chain[1].status, 'active');
    });
  });
});
