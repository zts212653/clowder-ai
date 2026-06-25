/**
 * F237 Phase 2-D: HookOverrideStore tests (AC-P2-15/16/17/18)
 *
 * Tests Redis-backed override store with constraint validation,
 * effective state resolution, and audit trail.
 * Uses FakeRedis (Map-backed) — no real Redis connection needed.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { FakeRedis } from './helpers/fake-redis.js';

describe('HookOverrideStore (P2-D)', () => {
  /** @type {typeof import('../dist/domains/prompt-hooks/HookOverrideStore.js')} */
  let storeMod;
  /** @type {typeof import('../dist/domains/prompt-hooks/HookRegistry.js')} */
  let registryMod;
  /** @type {import('../dist/domains/prompt-hooks/HookRegistry.js').HookRegistry} */
  let hookRegistry;

  before(async () => {
    const [sm, rm] = await Promise.all([
      import('../dist/domains/prompt-hooks/HookOverrideStore.js'),
      import('../dist/domains/prompt-hooks/HookRegistry.js'),
    ]);
    storeMod = sm;
    registryMod = rm;

    // Scan real hook manifests for constraint field values
    const { findMonorepoRoot } = await import('../dist/utils/monorepo-root.js');
    const root = findMonorepoRoot();
    hookRegistry = new registryMod.HookRegistry(
      join(root, 'assets', 'prompt-hooks'),
      join(root, 'assets', 'prompt-templates'),
    );
    hookRegistry.scan();
  });

  // -- AC-P2-15: Basic CRUD + two-layer resolution --------------------------

  describe('CRUD operations (AC-P2-15)', () => {
    it('getOverride returns null for unset hook', async () => {
      const store = new storeMod.HookOverrideStore(/** @type {any} */ (new FakeRedis()), hookRegistry);
      const result = await store.getOverride('S1');
      assert.equal(result, null);
    });

    it('setOverride + getOverride round-trip', async () => {
      const store = new storeMod.HookOverrideStore(/** @type {any} */ (new FakeRedis()), hookRegistry);
      // S3 (co-creator context) is disableable:true, safetyTier:readonly, governanceTier:human-gated
      // Setting enabled=false should work since disableable=true
      await store.setOverride('S3', {
        enabled: false,
        source: 'operator',
        updatedAt: 1000,
        reason: 'testing disable',
      });
      const result = await store.getOverride('S3');
      assert.ok(result);
      assert.equal(result.enabled, false);
      assert.equal(result.source, 'operator');
      assert.equal(result.reason, 'testing disable');
    });

    it('clearOverride removes the override', async () => {
      const store = new storeMod.HookOverrideStore(/** @type {any} */ (new FakeRedis()), hookRegistry);
      await store.setOverride('S3', {
        enabled: false,
        source: 'operator',
        updatedAt: 1000,
      });
      assert.ok(await store.getOverride('S3'));
      await store.clearOverride('S3');
      assert.equal(await store.getOverride('S3'), null);
    });

    it('listOverrides returns all active overrides', async () => {
      const store = new storeMod.HookOverrideStore(/** @type {any} */ (new FakeRedis()), hookRegistry);
      await store.setOverride('S3', { enabled: false, source: 'operator', updatedAt: 1000 });
      await store.setOverride('D15', { enabled: false, source: 'auto-eval', updatedAt: 2000 });
      const list = await store.listOverrides();
      assert.equal(list.length, 2);
      const ids = list.map((x) => x.hookId).sort();
      assert.deepEqual(ids, ['D15', 'S3']);
    });

    it('listOverrides cleans stale index entries', async () => {
      const redis = new FakeRedis();
      const store = new storeMod.HookOverrideStore(/** @type {any} */ (redis), hookRegistry);
      // Add to index but not to data (simulating partial cleanup)
      await redis.sadd('hook-override:__index', 'GHOST');
      await store.setOverride('S3', { enabled: false, source: 'operator', updatedAt: 1000 });
      const list = await store.listOverrides();
      // GHOST should be cleaned, only S3 remains
      assert.equal(list.length, 1);
      assert.equal(list[0].hookId, 'S3');
      const members = await redis.smembers('hook-override:__index');
      assert.ok(!members.includes('GHOST'), 'Stale entry should be removed from index');
    });
  });

  // -- AC-P2-18: Constraint enforcement ------------------------------------

  describe('Constraint enforcement (AC-P2-18)', () => {
    it('rejects disable on disableable:false hook (S1)', async () => {
      const store = new storeMod.HookOverrideStore(/** @type {any} */ (new FakeRedis()), hookRegistry);
      // S1 (identity) has disableable:false
      const hook = hookRegistry.getHook('S1');
      assert.ok(hook, 'S1 must exist');
      assert.equal(hook.manifest.disableable, false, 'S1 must be disableable:false');

      await assert.rejects(
        () => store.setOverride('S1', { enabled: false, source: 'operator', updatedAt: 1000 }),
        (err) => {
          assert.ok(err instanceof storeMod.HookOverrideConstraintError);
          assert.equal(err.constraint, 'disableable');
          assert.equal(err.hookId, 'S1');
          return true;
        },
      );
    });

    it('rejects template override on safetyTier:readonly hook (S1)', async () => {
      const store = new storeMod.HookOverrideStore(/** @type {any} */ (new FakeRedis()), hookRegistry);
      const hook = hookRegistry.getHook('S1');
      assert.ok(hook);
      assert.equal(hook.manifest.safetyTier, 'readonly', 'S1 must be safetyTier:readonly');

      await assert.rejects(
        () =>
          store.setOverride('S1', {
            templateContent: 'hacked identity',
            source: 'operator',
            updatedAt: 1000,
          }),
        (err) => {
          assert.ok(err instanceof storeMod.HookOverrideConstraintError);
          assert.equal(err.constraint, 'safetyTier');
          return true;
        },
      );
    });

    it('rejects version override on governanceTier:immutable hook', async () => {
      const store = new storeMod.HookOverrideStore(/** @type {any} */ (new FakeRedis()), hookRegistry);
      // Find an immutable hook
      const allHooks = hookRegistry.getAllHooks();
      const immutableHook = allHooks.find((h) => h.manifest.governanceTier === 'immutable');
      if (!immutableHook) {
        // No immutable hooks in current manifests — skip gracefully
        return;
      }
      await assert.rejects(
        () =>
          store.setOverride(immutableHook.manifest.id, {
            version: 99,
            source: 'operator',
            updatedAt: 1000,
          }),
        (err) => {
          assert.ok(err instanceof storeMod.HookOverrideConstraintError);
          assert.equal(err.constraint, 'governanceTier');
          return true;
        },
      );
    });

    it('allows disable on disableable:true hook', async () => {
      const store = new storeMod.HookOverrideStore(/** @type {any} */ (new FakeRedis()), hookRegistry);
      // D15 (voice mode) is disableable:true
      const hook = hookRegistry.getHook('D15');
      assert.ok(hook, 'D15 must exist');
      assert.equal(hook.manifest.disableable, true);
      // Should not throw
      await store.setOverride('D15', { enabled: false, source: 'operator', updatedAt: 1000 });
      const result = await store.getOverride('D15');
      assert.ok(result);
      assert.equal(result.enabled, false);
    });

    it('throws for unknown hookId', async () => {
      const store = new storeMod.HookOverrideStore(/** @type {any} */ (new FakeRedis()), hookRegistry);
      await assert.rejects(
        () => store.setOverride('NONEXISTENT', { source: 'operator', updatedAt: 1000 }),
        /Unknown hook/,
      );
    });
  });

  // -- AC-P2-16: Template override gated by safetyTier ---------------------

  describe('Template override gating (AC-P2-16)', () => {
    it('accepts template override on limited-edit or editable hook', async () => {
      const store = new storeMod.HookOverrideStore(/** @type {any} */ (new FakeRedis()), hookRegistry);
      const allHooks = hookRegistry.getAllHooks();
      const editableHook = allHooks.find(
        (h) => h.manifest.safetyTier === 'limited-edit' || h.manifest.safetyTier === 'editable',
      );
      if (!editableHook) {
        // All hooks are readonly — skip (spec says 3/52 are editable)
        return;
      }
      // Should not throw
      await store.setOverride(editableHook.manifest.id, {
        templateContent: 'Custom template content',
        source: 'operator',
        updatedAt: 1000,
        reason: 'testing editable template',
      });
      const result = await store.getOverride(editableHook.manifest.id);
      assert.ok(result);
      assert.equal(result.templateContent, 'Custom template content');
    });
  });

  // -- AC-P2-17: Audit trail -----------------------------------------------

  describe('Audit trail (AC-P2-17)', () => {
    it('preserves source, updatedAt, and reason', async () => {
      const store = new storeMod.HookOverrideStore(/** @type {any} */ (new FakeRedis()), hookRegistry);
      await store.setOverride('D15', {
        enabled: false,
        source: 'auto-eval',
        updatedAt: 1719300000000,
        reason: 'Auto-eval determined this hook is noisy',
      });
      const result = await store.getOverride('D15');
      assert.ok(result);
      assert.equal(result.source, 'auto-eval');
      assert.equal(result.updatedAt, 1719300000000);
      assert.equal(result.reason, 'Auto-eval determined this hook is noisy');
    });

    it('fills updatedAt if missing', async () => {
      const store = new storeMod.HookOverrideStore(/** @type {any} */ (new FakeRedis()), hookRegistry);
      await store.setOverride('D15', {
        enabled: false,
        source: 'operator',
        updatedAt: 0,
      });
      const result = await store.getOverride('D15');
      assert.ok(result);
      assert.ok(result.updatedAt > 0, 'updatedAt should be auto-filled');
    });
  });

  // -- AC-P2-15: Effective state resolution ---------------------------------

  describe('Effective state resolution (AC-P2-15)', () => {
    it('returns baseline when no override exists', async () => {
      const store = new storeMod.HookOverrideStore(/** @type {any} */ (new FakeRedis()), hookRegistry);
      const state = await store.resolveEffective('S1');
      const hook = hookRegistry.getHook('S1');
      assert.ok(hook);
      assert.equal(state.enabled, hook.manifest.enabled);
      assert.equal(state.version, hook.manifest.version);
      assert.equal(state.templateOverride, null);
      assert.equal(state.source, 'baseline');
    });

    it('merges override fields over baseline', async () => {
      const store = new storeMod.HookOverrideStore(/** @type {any} */ (new FakeRedis()), hookRegistry);
      // D15 is disableable:true, so we can disable it
      await store.setOverride('D15', { enabled: false, source: 'operator', updatedAt: 1000 });
      const state = await store.resolveEffective('D15');
      assert.equal(state.enabled, false, 'Override should disable');
      assert.equal(state.source, 'operator');
      // Version should fall back to manifest baseline
      const hook = hookRegistry.getHook('D15');
      assert.ok(hook);
      assert.equal(state.version, hook.manifest.version);
      assert.equal(state.templateOverride, null);
    });

    it('includes templateOverride when set', async () => {
      const store = new storeMod.HookOverrideStore(/** @type {any} */ (new FakeRedis()), hookRegistry);
      const allHooks = hookRegistry.getAllHooks();
      const editableHook = allHooks.find(
        (h) => h.manifest.safetyTier === 'limited-edit' || h.manifest.safetyTier === 'editable',
      );
      if (!editableHook) return;
      await store.setOverride(editableHook.manifest.id, {
        templateContent: 'Custom!',
        source: 'operator',
        updatedAt: 1000,
      });
      const state = await store.resolveEffective(editableHook.manifest.id);
      assert.equal(state.templateOverride, 'Custom!');
      assert.equal(state.source, 'operator');
    });

    it('throws for unknown hookId', async () => {
      const store = new storeMod.HookOverrideStore(/** @type {any} */ (new FakeRedis()), hookRegistry);
      await assert.rejects(() => store.resolveEffective('NONEXISTENT'), /Unknown hook/);
    });
  });
});
