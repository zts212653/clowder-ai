/**
 * F33 Phase 3: Session Strategy — runtime override layer + route logic
 * Tests for getSessionStrategyWithSource(), runtime override cache,
 * and the GET/PATCH/DELETE API route handlers.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

async function loadStrategyModule() {
  return import('../dist/config/session-strategy.js');
}

async function loadOverridesModule() {
  return import('../dist/config/session-strategy-overrides.js');
}

describe('session-strategy Phase 3: runtime overrides', () => {
  // ── getSessionStrategyWithSource() ──

  describe('getSessionStrategyWithSource()', () => {
    test('returns source=provider_default for known anthropic cat without overrides', async () => {
      const { getSessionStrategyWithSource } = await loadStrategyModule();
      const { _clearRuntimeOverrides } = await loadOverridesModule();
      _clearRuntimeOverrides();
      const result = getSessionStrategyWithSource('opus');
      assert.ok(result.effective);
      assert.equal(result.effective.strategy, 'handoff');
      assert.ok(['provider_default', 'config_file'].includes(result.source));
    });

    test('returns source=global_default for unknown cat', async () => {
      const { getSessionStrategyWithSource } = await loadStrategyModule();
      const { _clearRuntimeOverrides } = await loadOverridesModule();
      _clearRuntimeOverrides();
      const result = getSessionStrategyWithSource('unknown-cat-xyz');
      assert.equal(result.source, 'global_default');
      assert.equal(result.effective.strategy, 'handoff');
    });

    test('test override has highest priority', async () => {
      const { getSessionStrategyWithSource, _setTestStrategyOverride, _clearTestStrategyOverrides } =
        await loadStrategyModule();
      const { _clearRuntimeOverrides } = await loadOverridesModule();
      _clearRuntimeOverrides();
      try {
        _setTestStrategyOverride('opus', {
          strategy: 'compress',
          thresholds: { warn: 0.5, action: 0.6 },
          compress: { trackPostCompression: true },
        });
        const result = getSessionStrategyWithSource('opus');
        assert.equal(result.effective.strategy, 'compress');
        assert.equal(result.source, 'runtime_override');
      } finally {
        _clearTestStrategyOverrides();
      }
    });
  });

  // ── Runtime override cache (sync read, async write) ──

  describe('runtime override cache (no Redis)', () => {
    let overridesModule;

    beforeEach(async () => {
      overridesModule = await loadOverridesModule();
      overridesModule._clearRuntimeOverrides();
    });

    afterEach(async () => {
      overridesModule._clearRuntimeOverrides();
    });

    test('getRuntimeOverride returns undefined when no override set', () => {
      assert.equal(overridesModule.getRuntimeOverride('opus'), undefined);
    });

    test('setRuntimeOverride + getRuntimeOverride round-trip (cache only)', async () => {
      await overridesModule.setRuntimeOverride('opus', {
        strategy: 'compress',
        thresholds: { warn: 0.6, action: 0.7 },
      });
      const result = overridesModule.getRuntimeOverride('opus');
      assert.ok(result);
      assert.equal(result.strategy, 'compress');
      assert.equal(result.thresholds.warn, 0.6);
    });

    test('getAllRuntimeOverrides returns all cached overrides', async () => {
      await overridesModule.setRuntimeOverride('cat-a', { strategy: 'compress' });
      await overridesModule.setRuntimeOverride('cat-b', { strategy: 'hybrid' });
      const all = overridesModule.getAllRuntimeOverrides();
      assert.equal(all.size, 2);
      assert.equal(all.get('cat-a').strategy, 'compress');
      assert.equal(all.get('cat-b').strategy, 'hybrid');
    });

    test('deleteRuntimeOverride removes from cache', async () => {
      await overridesModule.setRuntimeOverride('opus', { strategy: 'compress' });
      const deleted = await overridesModule.deleteRuntimeOverride('opus');
      assert.equal(deleted, true);
      assert.equal(overridesModule.getRuntimeOverride('opus'), undefined);
    });

    test('deleteRuntimeOverride returns false when no override exists', async () => {
      const deleted = await overridesModule.deleteRuntimeOverride('nonexistent');
      assert.equal(deleted, false);
    });

    test('_clearRuntimeOverrides empties cache', async () => {
      await overridesModule.setRuntimeOverride('cat-a', { strategy: 'handoff' });
      overridesModule._clearRuntimeOverrides();
      assert.equal(overridesModule.getAllRuntimeOverrides().size, 0);
    });
  });

  // ── Runtime override integrated into lookup chain ──

  describe('runtime override in lookup chain', () => {
    afterEach(async () => {
      const { _clearRuntimeOverrides } = await loadOverridesModule();
      const { _clearTestStrategyOverrides } = await loadStrategyModule();
      _clearRuntimeOverrides();
      _clearTestStrategyOverrides();
    });

    test('runtime override takes precedence over provider default', async () => {
      const { getSessionStrategyWithSource } = await loadStrategyModule();
      const { setRuntimeOverride, _clearRuntimeOverrides } = await loadOverridesModule();
      _clearRuntimeOverrides();

      // Before override: should be provider_default or config_file
      const before = getSessionStrategyWithSource('opus');
      assert.notEqual(before.source, 'runtime_override');

      // Set runtime override
      await setRuntimeOverride('opus', {
        strategy: 'compress',
        compress: { trackPostCompression: true },
      });

      // After override: source should be runtime_override
      const after = getSessionStrategyWithSource('opus');
      assert.equal(after.source, 'runtime_override');
      assert.equal(after.effective.strategy, 'compress');
    });

    test('runtime override is deep-merged with base strategy', async () => {
      const { getSessionStrategyWithSource } = await loadStrategyModule();
      const { setRuntimeOverride, _clearRuntimeOverrides } = await loadOverridesModule();
      _clearRuntimeOverrides();

      // Set partial override (only thresholds)
      await setRuntimeOverride('opus', {
        thresholds: { warn: 0.6, action: 0.7 },
      });

      const result = getSessionStrategyWithSource('opus');
      assert.equal(result.source, 'runtime_override');
      // Overridden thresholds
      assert.equal(result.effective.thresholds.warn, 0.6);
      assert.equal(result.effective.thresholds.action, 0.7);
      // Base strategy preserved (handoff from anthropic default)
      assert.equal(result.effective.strategy, 'handoff');
      // Base budgets preserved
      assert.equal(result.effective.turnBudget, 12_000);
    });

    test('deleting runtime override falls back to lower source', async () => {
      const { getSessionStrategyWithSource } = await loadStrategyModule();
      const { setRuntimeOverride, deleteRuntimeOverride, _clearRuntimeOverrides } = await loadOverridesModule();
      _clearRuntimeOverrides();

      await setRuntimeOverride('opus', { strategy: 'compress' });
      assert.equal(getSessionStrategyWithSource('opus').source, 'runtime_override');

      await deleteRuntimeOverride('opus');
      const after = getSessionStrategyWithSource('opus');
      assert.notEqual(after.source, 'runtime_override');
    });

    test('test override still wins over runtime override', async () => {
      const { getSessionStrategyWithSource, _setTestStrategyOverride, _clearTestStrategyOverrides } =
        await loadStrategyModule();
      const { setRuntimeOverride, _clearRuntimeOverrides } = await loadOverridesModule();
      _clearRuntimeOverrides();

      await setRuntimeOverride('opus', { strategy: 'compress' });
      _setTestStrategyOverride('opus', {
        strategy: 'hybrid',
        thresholds: { warn: 0.1, action: 0.2 },
        hybrid: { maxCompressions: 1 },
      });

      const result = getSessionStrategyWithSource('opus');
      assert.equal(result.effective.strategy, 'hybrid');
      assert.equal(result.source, 'runtime_override');

      _clearTestStrategyOverrides();
    });
  });

  // ── Cloud R2 P1: hydration failure should not crash ──

  describe('Cloud R2 P1: initRuntimeOverrides tolerates SCAN failure', () => {
    test('initRuntimeOverrides throws on SCAN failure (caller must catch)', async () => {
      const overridesModule = await loadOverridesModule();
      overridesModule._clearRuntimeOverrides();

      const stubRedis = {
        options: { keyPrefix: '' },
        scan: async () => {
          throw new Error('SCAN connection refused');
        },
        get: async () => null,
      };

      // initRuntimeOverrides itself throws — the caller (index.ts) wraps in try/catch
      await assert.rejects(() => overridesModule.initRuntimeOverrides(stubRedis), {
        message: 'SCAN connection refused',
      });
      // Cache should remain empty (not corrupted)
      assert.equal(overridesModule.getAllRuntimeOverrides().size, 0);

      overridesModule._clearRuntimeOverrides();
    });
  });

  // ── Cloud R3 P2: partial hydration atomicity ──

  describe('Cloud R3 P2: partial SCAN failure leaves cache empty', () => {
    test('cache stays empty when SCAN fails on second page', async () => {
      const overridesModule = await loadOverridesModule();
      overridesModule._clearRuntimeOverrides();

      let scanCallCount = 0;
      const stubRedis = {
        options: { keyPrefix: '' },
        scan: async (cursor) => {
          scanCallCount++;
          if (cursor === '0') {
            // First page succeeds — returns one key and a non-zero cursor
            return ['42', ['session-strategy:override:opus']];
          }
          // Second page fails
          throw new Error('SCAN connection lost mid-iteration');
        },
        get: async (key) => {
          if (key === 'session-strategy:override:opus') {
            return JSON.stringify({ strategy: 'compress' });
          }
          return null;
        },
      };

      await assert.rejects(() => overridesModule.initRuntimeOverrides(stubRedis), {
        message: 'SCAN connection lost mid-iteration',
      });
      // Cache must be empty — no partial state from the first SCAN page
      assert.equal(
        overridesModule.getAllRuntimeOverrides().size,
        0,
        'cache should be empty after partial SCAN failure (no partial state)',
      );
      assert.ok(scanCallCount >= 2, 'should have attempted at least 2 SCAN calls');

      overridesModule._clearRuntimeOverrides();
    });
  });

  // ── Cloud R4 P2: re-hydration replaces (not appends) cache ──

  describe('Cloud R4 P2: re-hydration clears stale cache entries', () => {
    test('deleted Redis keys are removed from cache on re-init', async () => {
      const overridesModule = await loadOverridesModule();
      overridesModule._clearRuntimeOverrides();

      // First hydration: 2 keys
      const stubRedis = {
        options: { keyPrefix: '' },
        scan: async () => ['0', ['session-strategy:override:opus', 'session-strategy:override:sonnet']],
        get: async (key) => {
          if (key === 'session-strategy:override:opus') return JSON.stringify({ strategy: 'compress' });
          if (key === 'session-strategy:override:sonnet') return JSON.stringify({ strategy: 'hybrid' });
          return null;
        },
        set: async () => 'OK',
        del: async () => 1,
      };
      await overridesModule.initRuntimeOverrides(stubRedis);
      assert.equal(overridesModule.getAllRuntimeOverrides().size, 2);

      // Re-hydration: only 1 key (sonnet was deleted from Redis)
      stubRedis.scan = async () => ['0', ['session-strategy:override:opus']];
      stubRedis.get = async (key) => {
        if (key === 'session-strategy:override:opus') return JSON.stringify({ strategy: 'handoff' });
        return null;
      };
      await overridesModule.initRuntimeOverrides(stubRedis);

      const all = overridesModule.getAllRuntimeOverrides();
      assert.equal(all.size, 1, 'stale sonnet entry should be gone');
      assert.equal(all.get('opus')?.strategy, 'handoff');
      assert.equal(all.get('sonnet'), undefined, 'sonnet should not linger in cache');

      overridesModule._clearRuntimeOverrides();
    });
  });

  // ── P1-1: SCAN keyPrefix hydration (stub redis) ──

  describe('P1-1: hydrate with keyPrefix-aware SCAN', () => {
    test('initRuntimeOverrides hydrates from prefixed keys', async () => {
      const overridesModule = await loadOverridesModule();
      overridesModule._clearRuntimeOverrides();

      // Stub redis: scan returns prefixed keys, get accepts bare keys only
      const storedData = {
        'session-strategy:override:opus': JSON.stringify({ strategy: 'compress' }),
        'session-strategy:override:sonnet': JSON.stringify({ thresholds: { warn: 0.6, action: 0.7 } }),
      };
      const stubRedis = {
        options: { keyPrefix: 'cat-cafe:' },
        scan: async (cursor, _match, pattern) => {
          if (cursor !== '0') return ['0', []];
          // Return prefixed keys (as real Redis SCAN would)
          const keys = Object.keys(storedData).map((k) => `cat-cafe:${k}`);
          return [
            '0',
            keys.filter((k) => {
              const bare = pattern.replace('*', '');
              return k.startsWith(bare) || k.includes('session-strategy:override:');
            }),
          ];
        },
        get: async (key) => {
          // ioredis auto-prefixes, so get() receives bare key
          return storedData[key] ?? null;
        },
      };

      await overridesModule.initRuntimeOverrides(stubRedis);
      const all = overridesModule.getAllRuntimeOverrides();
      assert.equal(all.size, 2, `Expected 2 overrides, got ${all.size}`);
      assert.equal(all.get('opus')?.strategy, 'compress');
      assert.equal(all.get('sonnet')?.thresholds?.warn, 0.6);

      overridesModule._clearRuntimeOverrides();
    });
  });

  // ── Cloud P1: runtime override layers on resolved fallback ──

  describe('Cloud P1: runtime override layers on full fallback chain', () => {
    afterEach(async () => {
      const { _clearRuntimeOverrides } = await loadOverridesModule();
      _clearRuntimeOverrides();
    });

    test('partial runtime override preserves fallback-layer values (not just provider default)', async () => {
      // This test verifies the structural fix: runtime override merges
      // on top of the fully-resolved fallback (config-file → breed → provider → global),
      // not just the provider/global base.
      //
      // Currently no cats have runtime-config session strategy, so the fallback
      // is provider_default. But the code path is correct: resolveFallbackStrategy()
      // is called first, then runtime overlay is applied.
      const { getSessionStrategyWithSource, getSessionStrategy } = await loadStrategyModule();
      const { setRuntimeOverride, _clearRuntimeOverrides } = await loadOverridesModule();
      _clearRuntimeOverrides();

      // Get the resolved fallback for opus (anthropic provider default)
      const fallback = getSessionStrategy('opus');

      // Set runtime override with ONLY thresholds — other fields must come from fallback
      await setRuntimeOverride('opus', {
        thresholds: { warn: 0.55, action: 0.65 },
      });

      const result = getSessionStrategyWithSource('opus');
      assert.equal(result.source, 'runtime_override');
      // Overridden values
      assert.equal(result.effective.thresholds.warn, 0.55);
      assert.equal(result.effective.thresholds.action, 0.65);
      // Fallback values preserved (from resolved fallback, not just base)
      assert.equal(result.effective.strategy, fallback.strategy);
      assert.equal(result.effective.turnBudget, fallback.turnBudget);
      assert.equal(result.effective.safetyMargin, fallback.safetyMargin);
    });
  });

  // ── Cloud P2: deleteRuntimeOverride uses Redis DEL result ──

  describe('Cloud P2: delete uses Redis DEL as existence source of truth', () => {
    test('returns false when Redis DEL returns 0 (key not in Redis) despite stale cache', async () => {
      const overridesModule = await loadOverridesModule();
      overridesModule._clearRuntimeOverrides();

      const stubRedis = {
        options: { keyPrefix: '' },
        scan: async () => ['0', []],
        set: async () => 'OK',
        del: async () => 0, // Redis says key doesn't exist
        get: async () => null,
      };
      await overridesModule.initRuntimeOverrides(stubRedis);

      // Seed cache (simulating stale cache from previous process)
      await overridesModule.setRuntimeOverride('opus', { strategy: 'compress' });
      assert.ok(overridesModule.getRuntimeOverride('opus'), 'cache should have stale entry');

      // Stub del to return 0 (key already gone from Redis)
      stubRedis.del = async () => 0;

      const existed = await overridesModule.deleteRuntimeOverride('opus');
      assert.equal(existed, false, 'should return false when Redis DEL returns 0');
      assert.equal(overridesModule.getRuntimeOverride('opus'), undefined, 'cache should be cleaned up');

      overridesModule._clearRuntimeOverrides();
    });

    test('returns true when Redis DEL returns 1 (key existed in Redis)', async () => {
      const overridesModule = await loadOverridesModule();
      overridesModule._clearRuntimeOverrides();

      const stubRedis = {
        options: { keyPrefix: '' },
        scan: async () => ['0', []],
        set: async () => 'OK',
        del: async () => 1, // Redis confirms key existed
        get: async () => null,
      };
      await overridesModule.initRuntimeOverrides(stubRedis);
      await overridesModule.setRuntimeOverride('opus', { strategy: 'compress' });

      const existed = await overridesModule.deleteRuntimeOverride('opus');
      assert.equal(existed, true, 'should return true when Redis DEL returns 1');

      overridesModule._clearRuntimeOverrides();
    });
  });

  // ── P1-3: Redis write failure should not update cache ──

  describe('P1-3: cache not updated on Redis write failure', () => {
    test('setRuntimeOverride does not update cache if Redis.set throws', async () => {
      const overridesModule = await loadOverridesModule();
      overridesModule._clearRuntimeOverrides();

      const stubRedis = {
        options: { keyPrefix: 'cat-cafe:' },
        scan: async () => ['0', []],
        set: async () => {
          throw new Error('Redis write failure');
        },
        get: async () => null,
      };
      await overridesModule.initRuntimeOverrides(stubRedis);

      // Attempting to set should throw and NOT update cache
      await assert.rejects(() => overridesModule.setRuntimeOverride('opus', { strategy: 'compress' }), {
        message: 'Redis write failure',
      });
      assert.equal(
        overridesModule.getRuntimeOverride('opus'),
        undefined,
        'cache should not be updated on Redis failure',
      );

      overridesModule._clearRuntimeOverrides();
    });

    test('deleteRuntimeOverride does not update cache if Redis.del throws', async () => {
      const overridesModule = await loadOverridesModule();
      overridesModule._clearRuntimeOverrides();

      // Pre-seed cache via a stub that works for set
      const stubRedis = {
        options: { keyPrefix: 'cat-cafe:' },
        scan: async () => ['0', []],
        set: async () => 'OK',
        del: async () => {
          throw new Error('Redis delete failure');
        },
        get: async () => null,
      };
      await overridesModule.initRuntimeOverrides(stubRedis);
      await overridesModule.setRuntimeOverride('opus', { strategy: 'compress' });
      assert.ok(overridesModule.getRuntimeOverride('opus'), 'should be in cache before delete');

      await assert.rejects(() => overridesModule.deleteRuntimeOverride('opus'), { message: 'Redis delete failure' });
      // Cache should still have the entry (not deleted)
      assert.ok(overridesModule.getRuntimeOverride('opus'), 'cache should not be deleted on Redis failure');

      overridesModule._clearRuntimeOverrides();
    });
  });

  // ── mergeStrategyConfig deep-merge correctness ──

  describe('mergeStrategyConfig deep-merge', () => {
    test('partial thresholds override preserves other threshold', async () => {
      const { mergeStrategyConfig } = await loadStrategyModule();
      const base = {
        strategy: 'handoff',
        thresholds: { warn: 0.8, action: 0.9 },
        turnBudget: 12_000,
        safetyMargin: 4_000,
      };
      const merged = mergeStrategyConfig(base, { thresholds: { action: 0.85 } });
      assert.equal(merged.thresholds.warn, 0.8); // Preserved
      assert.equal(merged.thresholds.action, 0.85); // Overridden
    });

    test('nested handoff/compress/hybrid objects merge independently', async () => {
      const { mergeStrategyConfig } = await loadStrategyModule();
      const base = {
        strategy: 'hybrid',
        thresholds: { warn: 0.7, action: 0.8 },
        hybrid: { maxCompressions: 3 },
        handoff: { preSealMemoryDump: true, bootstrapDepth: 'extractive' },
      };
      const override = {
        hybrid: { maxCompressions: 5 },
      };
      const merged = mergeStrategyConfig(base, override);
      assert.equal(merged.hybrid.maxCompressions, 5);
      // handoff preserved from base
      assert.equal(merged.handoff.preSealMemoryDump, true);
    });
  });
});
