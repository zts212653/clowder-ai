/**
 * Seal Trigger Integration Tests
 * F24 Phase B: Tests that shouldSeal() + requestSeal() work together
 * in the context of a session lifecycle.
 *
 * These tests verify the integration between:
 * - SessionChainStore (session records)
 * - SessionSealer (lifecycle transitions)
 * - shouldSeal() (threshold detection)
 * - getSealConfig() (per-cat configuration)
 *
 * Note: invoke-single-cat integration is tested here at the logic level,
 * not by running the full generator (which requires mocking AgentService).
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('Seal trigger integration', () => {
  async function loadModules() {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { SessionSealer } = await import('../dist/domains/cats/services/session/SessionSealer.js');
    // F33 Phase 2: seal-thresholds.ts merged into session-strategy.ts
    const { shouldSeal, getSealConfig } = await import('../dist/config/session-strategy.js');
    return { SessionChainStore, SessionSealer, shouldSeal, getSealConfig };
  }

  const BASE_INPUT = {
    cliSessionId: 'cli-sess-1',
    threadId: 'thread-1',
    catId: 'opus',
    userId: 'user-1',
  };

  describe('threshold detection → seal → new session', () => {
    test('opus at 90% fillRatio triggers seal', async () => {
      const { SessionChainStore, SessionSealer, shouldSeal, getSealConfig } = await loadModules();
      const store = new SessionChainStore();
      const sealer = new SessionSealer(store);
      const config = getSealConfig('opus');

      // Create active session
      const s0 = store.create(BASE_INPUT);

      // Simulate context health at 90% (opus seal threshold)
      const health = {
        usedTokens: 180_000,
        windowTokens: 200_000,
        fillRatio: 0.9,
        source: 'exact',
        measuredAt: Date.now(),
      };
      store.update(s0.id, { contextHealth: health, updatedAt: Date.now() });

      // Check threshold
      assert.equal(shouldSeal(health.fillRatio, health.windowTokens, health.usedTokens, config), true);

      // Trigger seal
      const result = await sealer.requestSeal({ sessionId: s0.id, reason: 'threshold' });
      assert.equal(result.accepted, true);

      // Active pointer cleared
      assert.equal(store.getActive('opus', 'thread-1'), null);

      // New invocation creates new session
      const s1 = store.create({ ...BASE_INPUT, cliSessionId: 'cli-sess-2' });
      assert.equal(s1.seq, 1);
      assert.equal(s1.status, 'active');

      // Finalize old session
      await sealer.finalize({ sessionId: s0.id });
      assert.equal(store.get(s0.id)?.status, 'sealed');
    });

    test('opus at 89% does NOT trigger seal', async () => {
      const { SessionChainStore, shouldSeal, getSealConfig } = await loadModules();
      const store = new SessionChainStore();
      const config = getSealConfig('opus');

      store.create(BASE_INPUT);

      const health = {
        usedTokens: 178_000,
        windowTokens: 200_000,
        fillRatio: 0.89,
        source: 'exact',
        measuredAt: Date.now(),
      };

      // 89% with 22k remaining > 16k (turnBudget + safetyMargin)
      assert.equal(shouldSeal(health.fillRatio, health.windowTokens, health.usedTokens, config), false);
    });

    test('codex at 85% triggers seal', async () => {
      const { SessionChainStore, SessionSealer, shouldSeal, getSealConfig } = await loadModules();
      const store = new SessionChainStore();
      const sealer = new SessionSealer(store);
      const config = getSealConfig('codex');

      const s0 = store.create({ ...BASE_INPUT, catId: 'codex' });

      const health = {
        usedTokens: 108_800,
        windowTokens: 128_000,
        fillRatio: 0.85,
        source: 'approx',
        measuredAt: Date.now(),
      };

      assert.equal(shouldSeal(health.fillRatio, health.windowTokens, health.usedTokens, config), true);

      const result = await sealer.requestSeal({ sessionId: s0.id, reason: 'threshold' });
      assert.equal(result.accepted, true);
    });

    test('gemini at 65% triggers seal', async () => {
      const { SessionChainStore, SessionSealer, shouldSeal, getSealConfig } = await loadModules();
      const store = new SessionChainStore();
      const sealer = new SessionSealer(store);
      const config = getSealConfig('gemini');

      const s0 = store.create({ ...BASE_INPUT, catId: 'gemini' });

      const health = {
        usedTokens: 650_000,
        windowTokens: 1_000_000,
        fillRatio: 0.65,
        source: 'approx',
        measuredAt: Date.now(),
      };

      assert.equal(shouldSeal(health.fillRatio, health.windowTokens, health.usedTokens, config), true);

      const result = await sealer.requestSeal({ sessionId: s0.id, reason: 'threshold' });
      assert.equal(result.accepted, true);
    });

    test('turnBudget guard: 89% opus but only 15k remaining → seal', async () => {
      const { SessionChainStore, SessionSealer, shouldSeal, getSealConfig } = await loadModules();
      const store = new SessionChainStore();
      const sealer = new SessionSealer(store);
      const config = getSealConfig('opus');

      const s0 = store.create(BASE_INPUT);

      // 89% but only 15k remaining < 16k (turnBudget + safetyMargin)
      const health = {
        usedTokens: 185_000,
        windowTokens: 200_000,
        fillRatio: 0.925,
        source: 'exact',
        measuredAt: Date.now(),
      };

      assert.equal(shouldSeal(health.fillRatio, health.windowTokens, health.usedTokens, config), true);

      const result = await sealer.requestSeal({ sessionId: s0.id, reason: 'threshold' });
      assert.equal(result.accepted, true);
    });
  });

  describe('multi-session chain', () => {
    test('3-session chain: create → seal → create → seal → create', async () => {
      const { SessionChainStore, SessionSealer } = await loadModules();
      const store = new SessionChainStore();
      const sealer = new SessionSealer(store);

      // Session 0
      const s0 = store.create(BASE_INPUT);
      await sealer.requestSeal({ sessionId: s0.id, reason: 'threshold' });
      await sealer.finalize({ sessionId: s0.id });

      // Session 1
      const s1 = store.create({ ...BASE_INPUT, cliSessionId: 'cli-2' });
      await sealer.requestSeal({ sessionId: s1.id, reason: 'threshold' });
      await sealer.finalize({ sessionId: s1.id });

      // Session 2
      const s2 = store.create({ ...BASE_INPUT, cliSessionId: 'cli-3' });

      // Verify chain
      const chain = store.getChain('opus', 'thread-1');
      assert.equal(chain.length, 3);
      assert.equal(chain[0].status, 'sealed');
      assert.equal(chain[0].seq, 0);
      assert.equal(chain[1].status, 'sealed');
      assert.equal(chain[1].seq, 1);
      assert.equal(chain[2].status, 'active');
      assert.equal(chain[2].seq, 2);
      assert.equal(chain[2].id, s2.id);
    });

    test('manual seal reason is preserved through finalize', async () => {
      const { SessionChainStore, SessionSealer } = await loadModules();
      const store = new SessionChainStore();
      const sealer = new SessionSealer(store);

      const s0 = store.create(BASE_INPUT);
      await sealer.requestSeal({ sessionId: s0.id, reason: 'manual' });
      await sealer.finalize({ sessionId: s0.id });

      const sealed = store.get(s0.id);
      assert.equal(sealed?.sealReason, 'manual');
      assert.equal(sealed?.status, 'sealed');
    });
  });
});
