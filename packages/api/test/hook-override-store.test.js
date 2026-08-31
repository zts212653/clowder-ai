/**
 * F237 PR3 — HookOverrideStore + HookRegistry override integration tests
 *
 * P1 fix (PR #22): manifest is resolved internally via manifestLookup,
 * not passed by callers — prevents gate bypass via mismatched hookId/manifest.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

// ── FakeRedis with HASH + sorted set support ──

class FakeRedis {
  constructor() {
    this.kv = new Map();
    this.hashes = new Map(); // key → Map<field, value>
    this.sorted = new Map(); // key → Map<member, score>
    this.ttls = new Map();
  }

  async set(key, value, ...args) {
    this.kv.set(key, value);
    if (args[0] === 'EX' && typeof args[1] === 'number') {
      this.ttls.set(key, args[1]);
    }
    return 'OK';
  }

  async get(key) {
    return this.kv.get(key) ?? null;
  }

  async del(key) {
    const existed = this.kv.has(key) ? 1 : 0;
    this.kv.delete(key);
    return existed;
  }

  async hset(key, field, value) {
    const h = this.hashes.get(key) ?? new Map();
    h.set(field, value);
    this.hashes.set(key, h);
    return 1;
  }

  async hget(key, field) {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key) {
    const h = this.hashes.get(key);
    if (!h || h.size === 0) return null;
    return Object.fromEntries(h.entries());
  }

  async hdel(key, field) {
    const h = this.hashes.get(key);
    if (!h) return 0;
    return h.delete(field) ? 1 : 0;
  }

  async zadd(key, score, member) {
    const s = this.sorted.get(key) ?? new Map();
    s.set(member, score);
    this.sorted.set(key, s);
    return 1;
  }

  async zremrangebyscore(key, min, max) {
    const s = this.sorted.get(key);
    if (!s) return 0;
    const minN = typeof min === 'number' ? min : 0;
    const maxN = typeof max === 'number' ? max : Infinity;
    let removed = 0;
    for (const [member, score] of [...s.entries()]) {
      if (score >= minN && score <= maxN) {
        s.delete(member);
        removed++;
      }
    }
    return removed;
  }

  async zrangebyscore(key, min, max, ...args) {
    const s = this.sorted.get(key);
    if (!s) return [];
    const minN = typeof min === 'number' ? min : 0;
    const maxN = max === '+inf' ? Infinity : Number(max);
    let entries = [...s.entries()].filter(([, score]) => score >= minN && score <= maxN).sort((a, b) => a[1] - b[1]);
    if (args[0] === 'LIMIT') {
      const offset = args[1] ?? 0;
      const count = args[2] ?? entries.length;
      entries = entries.slice(offset, offset + count);
    }
    return entries.map(([member]) => member);
  }

  /** R7: SETNX — set if not exists (atomic in production Redis). */
  async setnx(key, value) {
    if (this.kv.has(key)) return 0;
    this.kv.set(key, value);
    return 1;
  }

  /** R7: INCR — atomic increment (returns new value). */
  async incr(key) {
    const val = this.kv.get(key);
    const num = val ? Number.parseInt(val, 10) : 0;
    const next = num + 1;
    this.kv.set(key, String(next));
    return next;
  }
}

// ── Test manifest factories ──

function makeManifest(id, overrides = {}) {
  return {
    id,
    name: `Test ${id}`,
    stage: 'session-init',
    order: 100,
    version: 1,
    enabled: true,
    template: `${id.toLowerCase()}.md`,
    inputs: [],
    disableable: true,
    safetyTier: 'editable',
    transparencyTier: 'visible-by-default',
    governanceTier: 'immutable',
    ...overrides,
  };
}

/**
 * Build a manifestLookup function from a set of manifests.
 * This mirrors the production pattern where the store resolves manifests
 * from the registry by hookId — callers never pass manifests directly.
 */
function buildLookup(...manifests) {
  const map = new Map(manifests.map((m) => [m.id, m]));
  return (hookId) => map.get(hookId);
}

// ── Tests ──

describe('HookOverrideStore', () => {
  /** @type {import('../dist/domains/prompt-hooks/HookOverrideStore.js').HookOverrideStore} */
  let store;
  let redis;

  // Default manifests for most tests
  const S1 = makeManifest('S1');
  const S2 = makeManifest('S2', { disableable: true });
  const D5 = makeManifest('D5', { safetyTier: 'editable' });
  const D8 = makeManifest('D8', { safetyTier: 'limited-edit' });

  beforeEach(async () => {
    redis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
    store = new mod.HookOverrideStore(redis, buildLookup(S1, S2, D5, D8));
  });

  describe('enable/disable', () => {
    test('enable writes override and records event', async () => {
      await store.enable('S1', 'opus');

      const override = await store.getOverride('S1');
      assert.equal(override.hookId, 'S1');
      assert.equal(override.enabled, true);
      assert.equal(override.source, 'operator');
      assert.equal(override.updatedBy, 'opus');

      const events = await store.listEvents();
      assert.equal(events.length, 1);
      assert.equal(events[0].action, 'enable');
      assert.equal(events[0].hookId, 'S1');
    });

    test('disable writes override for disableable hook', async () => {
      await store.disable('S2', 'codex');

      const override = await store.getOverride('S2');
      assert.equal(override.enabled, false);
      assert.equal(override.updatedBy, 'codex');
    });

    test('disable rejects non-disableable hook', async () => {
      // Build store with S1 as non-disableable
      const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
      const s1NotDisableable = makeManifest('S1', { disableable: false });
      const restrictedStore = new mod.HookOverrideStore(redis, buildLookup(s1NotDisableable));

      await assert.rejects(
        () => restrictedStore.disable('S1', 'opus'),
        (err) => {
          assert.equal(err.name, 'OverrideGateError');
          assert.equal(err.gate, 'disableable');
          return true;
        },
      );
    });
  });

  describe('content override', () => {
    test('setContentOverride stores content and increments version', async () => {
      await store.setContentOverride('D5', 'new content v1', 'opus');

      const o1 = await store.getOverride('D5');
      assert.equal(o1.contentOverride, 'new content v1');
      assert.equal(o1.contentVersion, 1);

      await store.setContentOverride('D5', 'new content v2', 'opus');
      const o2 = await store.getOverride('D5');
      assert.equal(o2.contentOverride, 'new content v2');
      assert.equal(o2.contentVersion, 2);
    });

    test('setContentOverride rejects readonly safetyTier', async () => {
      // Build store with S1 as readonly
      const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
      const s1Readonly = makeManifest('S1', { safetyTier: 'readonly' });
      const restrictedStore = new mod.HookOverrideStore(redis, buildLookup(s1Readonly));

      await assert.rejects(
        () => restrictedStore.setContentOverride('S1', 'hack', 'opus'),
        (err) => err.gate === 'safetyTier' && err.manifestValue === 'readonly',
      );
    });

    test('setContentOverride rejects limited-edit with auto-eval source', async () => {
      await assert.rejects(
        () => store.setContentOverride('D8', 'new', 'system', { source: 'auto-eval' }),
        (err) => err.gate === 'safetyTier' && err.manifestValue === 'limited-edit',
      );
    });

    test('setContentOverride allows limited-edit with operator source', async () => {
      await store.setContentOverride('D8', 'fixed text', 'operator', { source: 'operator' });
      const o = await store.getOverride('D8');
      assert.equal(o.contentOverride, 'fixed text');
    });

    test('clearContentOverride removes content but keeps other override state', async () => {
      await store.disable('D5', 'opus');
      await store.setContentOverride('D5', 'override text', 'opus');
      await store.clearContentOverride('D5', 'opus');

      const o = await store.getOverride('D5');
      assert.equal(o.enabled, false);
      assert.equal(o.contentOverride, undefined);
      assert.equal(o.contentVersion, undefined);
    });
  });

  describe('rollback', () => {
    test('rollback removes all override state for a hook', async () => {
      await store.disable('D5', 'opus');
      await store.setContentOverride('D5', 'override', 'opus');
      await store.rollback('D5', 'opus');

      const o = await store.getOverride('D5');
      assert.equal(o, null);
    });

    test('rollback records event', async () => {
      await store.rollback('D5', 'opus');
      const events = await store.listEvents();
      const rollbackEvent = events.find((e) => e.action === 'rollback');
      assert.ok(rollbackEvent);
      assert.equal(rollbackEvent.hookId, 'D5');
    });
  });

  describe('listOverrides + loadSnapshot', () => {
    test('listOverrides returns all overrides for workspace', async () => {
      await store.enable('S1', 'opus');
      await store.disable('S2', 'codex');

      const list = await store.listOverrides();
      assert.equal(list.length, 2);
      const ids = list.map((o) => o.hookId).sort();
      assert.deepEqual(ids, ['S1', 'S2']);
    });

    test('loadSnapshot returns ReadonlyMap keyed by hookId', async () => {
      await store.disable('D5', 'opus');
      const snapshot = await store.loadSnapshot();
      assert.equal(snapshot.size, 1);
      assert.equal(snapshot.get('D5').enabled, false);
    });
  });

  describe('per-workspace isolation', () => {
    test('overrides in different workspaces are independent', async () => {
      await store.enable('S1', 'opus', { workspaceId: 'ws-a' });
      await store.disable('S1', 'opus', { workspaceId: 'ws-b' });

      const oA = await store.getOverride('S1', 'ws-a');
      const oB = await store.getOverride('S1', 'ws-b');
      assert.equal(oA.enabled, true);
      assert.equal(oB.enabled, false);
    });
  });

  describe('event stream', () => {
    test('events are recorded with correct fields', async () => {
      await store.disable('D5', 'opus');
      await store.enable('D5', 'codex');

      const events = await store.listEvents();
      assert.equal(events.length, 2);
      assert.equal(events[0].action, 'disable');
      assert.equal(events[0].actorId, 'opus');
      assert.equal(events[1].action, 'enable');
      assert.equal(events[1].actorId, 'codex');
    });
  });

  describe('safety gate — mismatched hookId bypass prevention (P1 regression)', () => {
    test('disable rejects unknown hookId (fail-closed)', async () => {
      await assert.rejects(
        () => store.disable('UNKNOWN', 'opus'),
        (err) => {
          assert.equal(err.name, 'OverrideGateError');
          assert.equal(err.gate, 'unknown-hook');
          assert.equal(err.hookId, 'UNKNOWN');
          return true;
        },
      );
    });

    test('enable rejects unknown hookId (fail-closed)', async () => {
      await assert.rejects(
        () => store.enable('UNKNOWN', 'opus'),
        (err) => {
          assert.equal(err.name, 'OverrideGateError');
          assert.equal(err.gate, 'unknown-hook');
          return true;
        },
      );
    });

    test('setContentOverride rejects unknown hookId (fail-closed)', async () => {
      await assert.rejects(
        () => store.setContentOverride('UNKNOWN', 'hacked', 'opus'),
        (err) => {
          assert.equal(err.name, 'OverrideGateError');
          assert.equal(err.gate, 'unknown-hook');
          return true;
        },
      );
    });

    test('rollback rejects unknown hookId (fail-closed) — no audit event written (terra P2)', async () => {
      await assert.rejects(
        () => store.rollback('UNKNOWN', 'opus'),
        (err) => {
          assert.equal(err.name, 'OverrideGateError');
          assert.equal(err.gate, 'unknown-hook');
          assert.equal(err.hookId, 'UNKNOWN');
          return true;
        },
      );
      const events = await store.listEvents();
      assert.equal(events.length, 0, 'permanent audit stream must stay clean for unknown hooks');
    });

    test('clearContentOverride rejects unknown hookId (fail-closed) — sibling of rollback gate', async () => {
      await assert.rejects(
        () => store.clearContentOverride('UNKNOWN', 'opus'),
        (err) => {
          assert.equal(err.name, 'OverrideGateError');
          assert.equal(err.gate, 'unknown-hook');
          return true;
        },
      );
      const events = await store.listEvents();
      assert.equal(events.length, 0);
    });

    test('rollback on orphaned override (hook removed from registry) fails closed — override survives, no event', async () => {
      // Phase 1: hook exists → operator disables it (override + event written)
      await store.disable('S2', 'opus', { reason: 'pre-upgrade disable' });
      // Phase 2: package upgrade removes the hook from the registry
      const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
      const orphanStore = new mod.HookOverrideStore(redis, buildLookup(S1)); // S2 gone
      await assert.rejects(
        () => orphanStore.rollback('S2', 'opus'),
        (err) => err.gate === 'unknown-hook',
      );
      // Deliberate fail-closed tradeoff (terra review): orphaned overrides are NOT
      // clearable via this operator path — needs a dedicated migration channel,
      // not an arbitrary-string write into the permanent audit stream.
      const survivor = await orphanStore.getOverride('S2');
      assert.notEqual(survivor, null, 'orphaned override left untouched');
      const events = await orphanStore.listEvents();
      assert.equal(events.length, 1, 'only the original disable event exists — no rollback event');
    });

    test('cannot disable non-disableable S1 by passing D5 manifest identity — gate uses internal lookup', async () => {
      // This is the exact codex P1 repro scenario:
      // Before the fix, caller could pass D5's manifest (disableable:true) with hookId='S1'
      // to bypass S1's disableable:false gate. Now the store resolves manifest internally.
      const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
      const s1Protected = makeManifest('S1', { disableable: false, safetyTier: 'readonly' });
      const d5Editable = makeManifest('D5', { disableable: true, safetyTier: 'editable' });
      const protectedStore = new mod.HookOverrideStore(redis, buildLookup(s1Protected, d5Editable));

      // Attempt to disable S1 — gate must check S1's own manifest (disableable:false), not any other
      await assert.rejects(
        () => protectedStore.disable('S1', 'opus'),
        (err) => {
          assert.equal(err.name, 'OverrideGateError');
          assert.equal(err.hookId, 'S1');
          assert.equal(err.gate, 'disableable');
          return true;
        },
      );

      // Attempt to content-override S1 — gate must check S1's own manifest (readonly), not any other
      await assert.rejects(
        () => protectedStore.setContentOverride('S1', 'injected', 'opus'),
        (err) => {
          assert.equal(err.name, 'OverrideGateError');
          assert.equal(err.hookId, 'S1');
          assert.equal(err.gate, 'safetyTier');
          assert.equal(err.manifestValue, 'readonly');
          return true;
        },
      );

      // D5 should still work (its own manifest is permissive)
      await protectedStore.disable('D5', 'opus');
      await protectedStore.setContentOverride('D5', 'legitimate override', 'opus');
      const d5Override = await protectedStore.getOverride('D5');
      assert.equal(d5Override.enabled, false);
      assert.equal(d5Override.contentOverride, 'legitimate override');

      // S1 must remain untouched
      const s1Override = await protectedStore.getOverride('S1');
      assert.equal(s1Override, null);
    });
  });
});

describe('HookRegistry override integration', () => {
  /** @type {import('../dist/domains/prompt-hooks/HookRegistry.js').HookRegistry} */
  let HookRegistry;

  beforeEach(async () => {
    const mod = await import('../dist/domains/prompt-hooks/HookRegistry.js');
    HookRegistry = mod.HookRegistry;
  });

  test('isEnabled returns manifest baseline when no overrides', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(import.meta.dirname, '__fixtures__', 'override-test-1');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 's1'), { recursive: true });
    writeFileSync(
      join(dir, 's1', 'hook.yaml'),
      [
        'id: S1',
        'name: Test S1',
        'stage: session-init',
        'order: 100',
        'version: 3',
        'enabled: true',
        'template: s1.md',
        'inputs: []',
        'disableable: true',
        'safetyTier: editable',
        'transparencyTier: visible-by-default',
        'governanceTier: immutable',
      ].join('\n'),
    );
    writeFileSync(join(dir, 's1', 's1.md'), '<!-- S1 -->');

    const registry = new HookRegistry(dir);
    registry.scan();
    assert.equal(registry.isEnabled('S1'), true);
    assert.equal(registry.getActiveVersion('S1'), 3);
    assert.equal(registry.getDisabledBySource('S1'), 'manifest');
    assert.equal(registry.getContentOverride('S1'), undefined);

    rmSync(dir, { recursive: true, force: true });
  });

  test('override snapshot overrides manifest baseline', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(import.meta.dirname, '__fixtures__', 'override-test-2');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 's1'), { recursive: true });
    writeFileSync(
      join(dir, 's1', 'hook.yaml'),
      [
        'id: S1',
        'name: Test S1',
        'stage: session-init',
        'order: 100',
        'version: 1',
        'enabled: true',
        'template: s1.md',
        'inputs: []',
        'disableable: true',
        'safetyTier: editable',
        'transparencyTier: visible-by-default',
        'governanceTier: immutable',
      ].join('\n'),
    );
    writeFileSync(join(dir, 's1', 's1.md'), '<!-- S1 -->');

    const registry = new HookRegistry(dir);
    registry.scan();

    // Set override: disable S1 via operator
    const snapshot = new Map();
    snapshot.set('S1', {
      hookId: 'S1',
      enabled: false,
      contentOverride: 'overridden content',
      contentVersion: 5,
      source: 'operator',
      updatedAt: Date.now(),
      updatedBy: 'opus',
    });
    registry.setOverrideSnapshot(snapshot);

    assert.equal(registry.isEnabled('S1'), false);
    assert.equal(registry.getActiveVersion('S1'), 5);
    assert.equal(registry.getDisabledBySource('S1'), 'operator');
    assert.equal(registry.getContentOverride('S1'), 'overridden content');

    // Clear overrides → back to manifest
    registry.clearOverrideSnapshot();
    assert.equal(registry.isEnabled('S1'), true);
    assert.equal(registry.getActiveVersion('S1'), 1);

    rmSync(dir, { recursive: true, force: true });
  });

  test('auto-eval source maps to correct disabledBy', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(import.meta.dirname, '__fixtures__', 'override-test-3');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'd5'), { recursive: true });
    writeFileSync(
      join(dir, 'd5', 'hook.yaml'),
      [
        'id: D5',
        'name: Test D5',
        'stage: per-turn',
        'order: 500',
        'version: 1',
        'enabled: true',
        'template: d5.md',
        'inputs: []',
        'disableable: true',
        'safetyTier: editable',
        'transparencyTier: visible-by-default',
        'governanceTier: auto-evolve',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'd5', 'd5.md'), '<!-- D5 -->');

    const registry = new HookRegistry(dir);
    registry.scan();

    registry.setOverrideSnapshot(
      new Map([
        [
          'D5',
          {
            hookId: 'D5',
            enabled: false,
            source: 'auto-eval',
            updatedAt: Date.now(),
            updatedBy: 'system',
          },
        ],
      ]),
    );

    assert.equal(registry.getDisabledBySource('D5'), 'auto-eval');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('End-to-end: HookOverrideStore → HookRegistry → HookPipeline', () => {
  test('disable override suppresses hook in pipeline output', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');

    // Set up two hooks: H1 (will be disabled via override) and H2 (baseline)
    const dir = join(import.meta.dirname, '__fixtures__', 'e2e-override-test');
    rmSync(dir, { recursive: true, force: true });
    for (const id of ['h1', 'h2']) {
      mkdirSync(join(dir, id), { recursive: true });
      writeFileSync(
        join(dir, id, 'hook.yaml'),
        [
          `id: ${id.toUpperCase()}`,
          `name: Test ${id.toUpperCase()}`,
          'stage: session-init',
          `order: ${id === 'h1' ? 100 : 200}`,
          'version: 1',
          'enabled: true',
          `template: ${id}.md`,
          'inputs: []',
          'disableable: true',
          'safetyTier: editable',
          'transparencyTier: visible-by-default',
          'governanceTier: immutable',
        ].join('\n'),
      );
      writeFileSync(join(dir, id, `${id}.md`), `Content from ${id.toUpperCase()}`);
    }

    const { HookRegistry } = await import('../dist/domains/prompt-hooks/HookRegistry.js');
    const { HookPipeline } = await import('../dist/domains/prompt-hooks/HookPipeline.js');
    const { HookOverrideStore } = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');

    const redis = new FakeRedis();
    const registry = new HookRegistry(dir);
    registry.scan();

    // Build store with registry-backed manifest lookup
    const manifestLookup = (hookId) => registry.getHook(hookId)?.manifest;
    const store = new HookOverrideStore(redis, manifestLookup);

    // Baseline: both hooks fire
    const pipeline1 = new HookPipeline(registry, new Map(), (id) => `Content from ${id}`);
    const input = { catId: 'opus' };
    const baseline = pipeline1.executeStage('session-init', input);
    assert.equal(baseline.patches.length, 2, 'Both hooks fire at baseline');
    assert.equal(baseline.events.filter((e) => e.status === 'fired').length, 2);

    // Disable H1 via override store → load snapshot → inject into registry
    await store.disable('H1', 'opus', { reason: 'e2e test' });
    const snapshot = await store.loadSnapshot();
    registry.setOverrideSnapshot(snapshot);

    // After override: only H2 fires, H1 is disabled
    const pipeline2 = new HookPipeline(registry, new Map(), (id) => `Content from ${id}`);
    const overridden = pipeline2.executeStage('session-init', input);
    assert.equal(overridden.patches.length, 1, 'Only H2 fires after H1 disabled');
    assert.equal(overridden.patches[0].hookId, 'H2');
    const disabledEvent = overridden.events.find((e) => e.hookId === 'H1');
    assert.equal(disabledEvent.status, 'disabled');
    assert.equal(disabledEvent.disabledBy, 'operator');

    // Rollback H1 → clears override → both fire again
    await store.rollback('H1', 'opus');
    const snapshot2 = await store.loadSnapshot();
    registry.setOverrideSnapshot(snapshot2);

    const pipeline3 = new HookPipeline(registry, new Map(), (id) => `Content from ${id}`);
    const restored = pipeline3.executeStage('session-init', input);
    assert.equal(restored.patches.length, 2, 'Both hooks fire after rollback');

    // Verify event stream records the full lifecycle
    const events = await store.listEvents();
    assert.equal(events.length, 2); // disable + rollback
    assert.equal(events[0].action, 'disable');
    assert.equal(events[0].reason, 'e2e test');
    assert.equal(events[1].action, 'rollback');

    rmSync(dir, { recursive: true, force: true });
  });

  test('content override changes pipeline output', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');

    const dir = join(import.meta.dirname, '__fixtures__', 'e2e-content-test');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'h1'), { recursive: true });
    writeFileSync(
      join(dir, 'h1', 'hook.yaml'),
      [
        'id: H1',
        'name: Test H1',
        'stage: session-init',
        'order: 100',
        'version: 1',
        'enabled: true',
        'template: h1.md',
        'inputs: []',
        'disableable: true',
        'safetyTier: editable',
        'transparencyTier: visible-by-default',
        'governanceTier: immutable',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'h1', 'h1.md'), 'Original baseline content');

    const { HookRegistry } = await import('../dist/domains/prompt-hooks/HookRegistry.js');
    const { HookPipeline } = await import('../dist/domains/prompt-hooks/HookPipeline.js');
    const { HookOverrideStore } = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');

    const redis = new FakeRedis();
    const registry = new HookRegistry(dir);
    registry.scan();

    // Build store with registry-backed manifest lookup
    const manifestLookup = (hookId) => registry.getHook(hookId)?.manifest;
    const store = new HookOverrideStore(redis, manifestLookup);

    // Set content override
    await store.setContentOverride('H1', 'Overridden by operator', 'opus');
    const snapshot = await store.loadSnapshot();
    registry.setOverrideSnapshot(snapshot);

    // Pipeline should use overridden content
    const pipeline = new HookPipeline(registry, new Map(), (id) => `Rendered ${id}`);
    const result = pipeline.executeStage('session-init', { catId: 'opus' });
    assert.equal(result.patches.length, 1);
    assert.equal(result.patches[0].content, 'Overridden by operator');

    // R7: Version in trace is now activeEpochVersion (stable monotonic ID),
    // not contentVersion (mutable edit counter). First override = manifest(1)+1 = 2.
    const firedEvent = result.events.find((e) => e.status === 'fired');
    assert.equal(firedEvent.version, 2); // activeEpochVersion = 2

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── sol review P1-1: stale overrides must not survive manifest tightening ──

describe('Manifest tightening — stale override reconciliation (sol P1-1)', () => {
  test('loadSnapshot strips disable-override when manifest tightens to non-disableable', async () => {
    const redis = new FakeRedis();
    const { HookOverrideStore } = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');

    // Phase 1: hook is disableable → operator disables it
    const v1Manifest = makeManifest('S1', { disableable: true, safetyTier: 'editable' });
    const store1 = new HookOverrideStore(redis, buildLookup(v1Manifest));
    await store1.disable('S1', 'opus', { reason: 'test disable' });

    // Verify the override was written
    const snapshot1 = await store1.loadSnapshot();
    assert.equal(snapshot1.get('S1')?.enabled, false, 'Override was written with enabled:false');

    // Phase 2: package upgrade tightens S1 to non-disableable → new store with new manifest
    const v2Manifest = makeManifest('S1', { disableable: false, safetyTier: 'editable' });
    const store2 = new HookOverrideStore(redis, buildLookup(v2Manifest));

    // loadSnapshot must reconcile: strip the stale enabled:false
    const snapshot2 = await store2.loadSnapshot();
    const override = snapshot2.get('S1');
    assert.notEqual(override, null, 'Override entry still exists');
    assert.equal(override?.enabled, undefined, 'enabled:false stripped — manifest no longer allows disabling');
  });

  test('loadSnapshot strips contentOverride when manifest tightens to readonly', async () => {
    const redis = new FakeRedis();
    const { HookOverrideStore } = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');

    // Phase 1: hook is editable → operator sets content override
    const v1Manifest = makeManifest('D5', { disableable: true, safetyTier: 'editable' });
    const store1 = new HookOverrideStore(redis, buildLookup(v1Manifest));
    await store1.setContentOverride('D5', 'custom content', 'opus');

    const snapshot1 = await store1.loadSnapshot();
    assert.equal(snapshot1.get('D5')?.contentOverride, 'custom content');
    assert.equal(snapshot1.get('D5')?.contentVersion, 1);

    // Phase 2: package upgrade tightens D5 to readonly
    const v2Manifest = makeManifest('D5', { disableable: true, safetyTier: 'readonly' });
    const store2 = new HookOverrideStore(redis, buildLookup(v2Manifest));

    const snapshot2 = await store2.loadSnapshot();
    const override = snapshot2.get('D5');
    assert.notEqual(override, null, 'Override entry still exists');
    assert.equal(override?.contentOverride, undefined, 'contentOverride stripped — manifest is now readonly');
    assert.equal(override?.contentVersion, undefined, 'contentVersion also stripped');
  });

  test('loadSnapshot drops overrides for hooks removed from registry', async () => {
    const redis = new FakeRedis();
    const { HookOverrideStore } = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');

    // Phase 1: hook exists → operator disables it
    const v1Manifest = makeManifest('REMOVED', { disableable: true });
    const store1 = new HookOverrideStore(redis, buildLookup(v1Manifest));
    await store1.disable('REMOVED', 'opus');

    // Phase 2: hook removed from registry (manifest lookup returns undefined)
    const store2 = new HookOverrideStore(redis, () => undefined);
    const snapshot = await store2.loadSnapshot();
    assert.equal(snapshot.get('REMOVED'), undefined, 'Orphaned override is dropped from snapshot');
  });
});

describe('HookRegistry defense-in-depth against stale overrides (sol P1-1)', () => {
  test('isEnabled ignores disable-override when manifest is non-disableable', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { HookRegistry } = await import('../dist/domains/prompt-hooks/HookRegistry.js');

    const dir = join(import.meta.dirname, '__fixtures__', 'sol-p1-1-disable');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 's1'), { recursive: true });
    writeFileSync(
      join(dir, 's1', 'hook.yaml'),
      [
        'id: S1',
        'name: Test S1',
        'stage: session-init',
        'order: 100',
        'version: 1',
        'enabled: true',
        'template: s1.md',
        'inputs: []',
        'disableable: false',
        'safetyTier: readonly',
        'transparencyTier: visible-by-default',
        'governanceTier: immutable',
      ].join('\n'),
    );
    writeFileSync(join(dir, 's1', 's1.md'), '<!-- S1 -->');

    const registry = new HookRegistry(dir);
    registry.scan();

    // Inject a stale override that claims to disable S1
    const staleSnapshot = new Map();
    staleSnapshot.set('S1', {
      hookId: 'S1',
      enabled: false,
      source: 'operator',
      updatedAt: Date.now(),
      updatedBy: 'past-opus',
    });
    registry.setOverrideSnapshot(staleSnapshot);

    // Defense-in-depth: isEnabled must respect current manifest, not stale override
    assert.equal(registry.isEnabled('S1'), true, 'S1 stays enabled — manifest says non-disableable');
    assert.equal(registry.getDisabledBySource('S1'), 'manifest', 'disabledBy reports manifest, not stale override');

    rmSync(dir, { recursive: true, force: true });
  });

  test('getContentOverride ignores stale content when manifest is readonly', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { HookRegistry } = await import('../dist/domains/prompt-hooks/HookRegistry.js');

    const dir = join(import.meta.dirname, '__fixtures__', 'sol-p1-1-content');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 's1'), { recursive: true });
    writeFileSync(
      join(dir, 's1', 'hook.yaml'),
      [
        'id: S1',
        'name: Test S1',
        'stage: session-init',
        'order: 100',
        'version: 1',
        'enabled: true',
        'template: s1.md',
        'inputs: []',
        'disableable: false',
        'safetyTier: readonly',
        'transparencyTier: visible-by-default',
        'governanceTier: immutable',
      ].join('\n'),
    );
    writeFileSync(join(dir, 's1', 's1.md'), '<!-- S1 -->');

    const registry = new HookRegistry(dir);
    registry.scan();

    // Inject a stale override with content on a now-readonly hook
    const staleSnapshot = new Map();
    staleSnapshot.set('S1', {
      hookId: 'S1',
      contentOverride: 'injected content from before tightening',
      contentVersion: 3,
      source: 'operator',
      updatedAt: Date.now(),
      updatedBy: 'past-opus',
    });
    registry.setOverrideSnapshot(staleSnapshot);

    assert.equal(registry.getContentOverride('S1'), undefined, 'Content override ignored — manifest is readonly');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Audit event TTL=0 (sol P1-2)', () => {
  test('events persist without TTL', async () => {
    const redis = new FakeRedis();
    const { HookOverrideStore } = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');

    const store = new HookOverrideStore(redis, buildLookup(makeManifest('S1')));
    await store.enable('S1', 'opus', { reason: 'audit test' });

    // Find the event key and verify no TTL was set
    const eventKeys = [...redis.kv.keys()].filter((k) => k.startsWith('hook-override-event:'));
    assert.equal(eventKeys.length, 1, 'One event key was written');

    const ttl = redis.ttls.get(eventKeys[0]);
    assert.equal(ttl, undefined, 'No TTL set on event key — permanent storage per Iron Law 5');
  });
});

// ── Sol round 2: field-level provenance + limited-edit reconciliation ──

describe('Field-level provenance (sol round 2 — shared source corruption)', () => {
  test('enable() sets enabledSource independently of contentSource', async () => {
    const redis = new FakeRedis();
    const { HookOverrideStore } = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');

    const manifest = makeManifest('D5', {
      disableable: true,
      safetyTier: 'editable',
    });
    const store = new HookOverrideStore(redis, buildLookup(manifest));

    // auto-eval sets content, then operator enables — source should NOT corrupt contentSource
    await store.setContentOverride('D5', 'eval content', 'eval-bot', { source: 'auto-eval' });
    await store.enable('D5', 'human', { source: 'operator' });

    const override = await store.getOverride('D5');
    assert.equal(override?.contentSource, 'auto-eval', 'contentSource preserved from setContentOverride');
    assert.equal(override?.enabledSource, 'operator', 'enabledSource set by enable()');
    assert.equal(override?.source, 'operator', 'source reflects last operation (enable)');
  });

  test('disable() sets enabledSource independently of contentSource', async () => {
    const redis = new FakeRedis();
    const { HookOverrideStore } = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');

    const manifest = makeManifest('D5', {
      disableable: true,
      safetyTier: 'editable',
    });
    const store = new HookOverrideStore(redis, buildLookup(manifest));

    // operator sets content, then auto-eval disables
    await store.setContentOverride('D5', 'custom content', 'human', { source: 'operator' });
    await store.disable('D5', 'eval-bot', { source: 'auto-eval' });

    const override = await store.getOverride('D5');
    assert.equal(override?.contentSource, 'operator', 'contentSource preserved from setContentOverride');
    assert.equal(override?.enabledSource, 'auto-eval', 'enabledSource set by disable()');
  });

  test('clearContentOverride strips contentSource', async () => {
    const redis = new FakeRedis();
    const { HookOverrideStore } = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');

    const manifest = makeManifest('D5', {
      disableable: true,
      safetyTier: 'editable',
    });
    const store = new HookOverrideStore(redis, buildLookup(manifest));

    await store.setContentOverride('D5', 'content', 'human', { source: 'operator' });
    await store.clearContentOverride('D5', 'human');

    const override = await store.getOverride('D5');
    assert.equal(override?.contentOverride, undefined, 'contentOverride cleared');
    assert.equal(override?.contentSource, undefined, 'contentSource cleared');
  });
});

describe('Manifest tightening — editable → limited-edit reconciliation (sol round 2)', () => {
  test('loadSnapshot strips auto-eval content when manifest tightens to limited-edit', async () => {
    const redis = new FakeRedis();
    const { HookOverrideStore } = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');

    // Phase 1: hook is editable → auto-eval sets content
    const v1Manifest = makeManifest('D5', {
      disableable: true,
      safetyTier: 'editable',
    });
    const store1 = new HookOverrideStore(redis, buildLookup(v1Manifest));
    await store1.setContentOverride('D5', 'auto-eval content', 'eval-bot', { source: 'auto-eval' });

    const snapshot1 = await store1.loadSnapshot();
    assert.equal(snapshot1.get('D5')?.contentOverride, 'auto-eval content', 'Content set while editable');

    // Phase 2: manifest tightened to limited-edit → auto-eval content must be stripped
    const v2Manifest = makeManifest('D5', {
      disableable: true,
      safetyTier: 'limited-edit',
    });
    const store2 = new HookOverrideStore(redis, buildLookup(v2Manifest));

    const snapshot2 = await store2.loadSnapshot();
    const override = snapshot2.get('D5');
    assert.notEqual(override, null, 'Override entry still exists');
    assert.equal(
      override?.contentOverride,
      undefined,
      'auto-eval content stripped — limited-edit only allows operator',
    );
  });

  test('loadSnapshot preserves operator content when manifest tightens to limited-edit', async () => {
    const redis = new FakeRedis();
    const { HookOverrideStore } = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');

    // Phase 1: hook is editable → operator sets content
    const v1Manifest = makeManifest('D5', {
      disableable: true,
      safetyTier: 'editable',
    });
    const store1 = new HookOverrideStore(redis, buildLookup(v1Manifest));
    await store1.setContentOverride('D5', 'operator content', 'human', { source: 'operator' });

    // Phase 2: manifest tightened to limited-edit → operator content survives
    const v2Manifest = makeManifest('D5', {
      disableable: true,
      safetyTier: 'limited-edit',
    });
    const store2 = new HookOverrideStore(redis, buildLookup(v2Manifest));

    const snapshot2 = await store2.loadSnapshot();
    const override = snapshot2.get('D5');
    assert.equal(
      override?.contentOverride,
      'operator content',
      'operator content preserved — limited-edit allows operator',
    );
  });

  test('loadSnapshot strips content when enable() corrupted source but contentSource is auto-eval', async () => {
    const redis = new FakeRedis();
    const { HookOverrideStore } = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');

    // Phase 1: auto-eval sets content, then operator enables (corrupting shared source)
    const v1Manifest = makeManifest('D5', {
      disableable: true,
      safetyTier: 'editable',
    });
    const store1 = new HookOverrideStore(redis, buildLookup(v1Manifest));
    await store1.setContentOverride('D5', 'eval content', 'eval-bot', { source: 'auto-eval' });
    await store1.enable('D5', 'human', { source: 'operator' });

    // Verify: shared source says 'operator' but contentSource says 'auto-eval'
    const raw = await store1.getOverride('D5');
    assert.equal(raw?.source, 'operator', 'Shared source corrupted by enable()');
    assert.equal(raw?.contentSource, 'auto-eval', 'contentSource preserves true provenance');

    // Phase 2: manifest tightened to limited-edit → must use contentSource, NOT source
    const v2Manifest = makeManifest('D5', {
      disableable: true,
      safetyTier: 'limited-edit',
    });
    const store2 = new HookOverrideStore(redis, buildLookup(v2Manifest));

    const snapshot = await store2.loadSnapshot();
    const override = snapshot.get('D5');
    assert.equal(
      override?.contentOverride,
      undefined,
      'Content stripped despite source=operator — reconciliation uses contentSource',
    );
  });
});

describe('HookRegistry defense-in-depth — limited-edit + provenance (sol round 2)', () => {
  test('getContentOverride ignores auto-eval content on limited-edit hook', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { HookRegistry } = await import('../dist/domains/prompt-hooks/HookRegistry.js');

    const dir = join(import.meta.dirname, '__fixtures__', 'sol-r2-limited');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'd5'), { recursive: true });
    writeFileSync(
      join(dir, 'd5', 'hook.yaml'),
      [
        'id: D5',
        'name: Test D5',
        'stage: per-turn',
        'order: 500',
        'version: 1',
        'enabled: true',
        'template: d5.md',
        'inputs: []',
        'disableable: true',
        'safetyTier: limited-edit',
        'transparencyTier: visible-by-default',
        'governanceTier: human-gated',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'd5', 'd5.md'), '<!-- D5 -->');

    const registry = new HookRegistry(dir);
    registry.scan();

    // Inject override with auto-eval content on limited-edit hook
    const snapshot = new Map();
    snapshot.set('D5', {
      hookId: 'D5',
      contentOverride: 'auto-eval injected content',
      contentVersion: 2,
      contentSource: 'auto-eval',
      source: 'operator', // corrupted by subsequent enable()
      updatedAt: Date.now(),
      updatedBy: 'eval-bot',
    });
    registry.setOverrideSnapshot(snapshot);

    assert.equal(
      registry.getContentOverride('D5'),
      undefined,
      'auto-eval content blocked on limited-edit hook despite source=operator',
    );

    rmSync(dir, { recursive: true, force: true });
  });

  test('getContentOverride honors operator content on limited-edit hook', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { HookRegistry } = await import('../dist/domains/prompt-hooks/HookRegistry.js');

    const dir = join(import.meta.dirname, '__fixtures__', 'sol-r2-limited-ok');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'd5'), { recursive: true });
    writeFileSync(
      join(dir, 'd5', 'hook.yaml'),
      [
        'id: D5',
        'name: Test D5',
        'stage: per-turn',
        'order: 500',
        'version: 1',
        'enabled: true',
        'template: d5.md',
        'inputs: []',
        'disableable: true',
        'safetyTier: limited-edit',
        'transparencyTier: visible-by-default',
        'governanceTier: human-gated',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'd5', 'd5.md'), '<!-- D5 -->');

    const registry = new HookRegistry(dir);
    registry.scan();

    const snapshot = new Map();
    snapshot.set('D5', {
      hookId: 'D5',
      contentOverride: 'operator-approved content',
      contentVersion: 1,
      contentSource: 'operator',
      source: 'auto-eval', // corrupted by subsequent disable()
      updatedAt: Date.now(),
      updatedBy: 'human',
    });
    registry.setOverrideSnapshot(snapshot);

    assert.equal(
      registry.getContentOverride('D5'),
      'operator-approved content',
      'operator content honored on limited-edit hook despite source=auto-eval',
    );

    rmSync(dir, { recursive: true, force: true });
  });

  test('getDisabledBySource uses enabledSource over shared source', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { HookRegistry } = await import('../dist/domains/prompt-hooks/HookRegistry.js');

    const dir = join(import.meta.dirname, '__fixtures__', 'sol-r2-disabled-by');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'd5'), { recursive: true });
    writeFileSync(
      join(dir, 'd5', 'hook.yaml'),
      [
        'id: D5',
        'name: Test D5',
        'stage: per-turn',
        'order: 500',
        'version: 1',
        'enabled: true',
        'template: d5.md',
        'inputs: []',
        'disableable: true',
        'safetyTier: limited-edit',
        'transparencyTier: visible-by-default',
        'governanceTier: human-gated',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'd5', 'd5.md'), '<!-- D5 -->');

    const registry = new HookRegistry(dir);
    registry.scan();

    // auto-eval disabled, then operator set content (corrupting shared source to 'operator')
    const snapshot = new Map();
    snapshot.set('D5', {
      hookId: 'D5',
      enabled: false,
      enabledSource: 'auto-eval',
      contentOverride: 'operator content',
      contentSource: 'operator',
      source: 'operator', // corrupted by setContentOverride
      updatedAt: Date.now(),
      updatedBy: 'human',
    });
    registry.setOverrideSnapshot(snapshot);

    assert.equal(
      registry.getDisabledBySource('D5'),
      'auto-eval',
      'disabledBy uses enabledSource, not corrupted shared source',
    );

    rmSync(dir, { recursive: true, force: true });
  });

  // -- getActiveVersion consistency with getContentOverride (sol P2) ----------

  test('getActiveVersion returns manifest version when content rejected (limited-edit + auto-eval)', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { HookRegistry } = await import('../dist/domains/prompt-hooks/HookRegistry.js');

    const dir = join(import.meta.dirname, '__fixtures__', 'sol-p2-version-rejected');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'd5'), { recursive: true });
    writeFileSync(
      join(dir, 'd5', 'hook.yaml'),
      [
        'id: D5',
        'name: Test D5',
        'stage: per-turn',
        'order: 500',
        'version: 1',
        'enabled: true',
        'template: d5.md',
        'inputs: []',
        'disableable: true',
        'safetyTier: limited-edit',
        'transparencyTier: visible-by-default',
        'governanceTier: human-gated',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'd5', 'd5.md'), '<!-- D5 baseline -->');

    const registry = new HookRegistry(dir);
    registry.scan();

    // auto-eval set content (contentVersion=99), then operator enabled (corrupting source)
    const snapshot = new Map();
    snapshot.set('D5', {
      hookId: 'D5',
      enabled: true,
      enabledSource: 'operator',
      contentOverride: 'auto-eval injected v99',
      contentVersion: 99,
      contentSource: 'auto-eval',
      source: 'operator',
      updatedAt: Date.now(),
      updatedBy: 'eval-bot',
    });
    registry.setOverrideSnapshot(snapshot);

    // Content must be rejected (limited-edit + auto-eval source)
    assert.equal(registry.getContentOverride('D5'), undefined, 'content rejected');
    // Version must match what is rendered (manifest v1), NOT stale override v99
    assert.equal(
      registry.getActiveVersion('D5'),
      1,
      'getActiveVersion returns manifest version when content is rejected (sol P2)',
    );

    rmSync(dir, { recursive: true, force: true });
  });

  test('getActiveVersion returns override version when content honored (limited-edit + operator)', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { HookRegistry } = await import('../dist/domains/prompt-hooks/HookRegistry.js');

    const dir = join(import.meta.dirname, '__fixtures__', 'sol-p2-version-honored');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'd5'), { recursive: true });
    writeFileSync(
      join(dir, 'd5', 'hook.yaml'),
      [
        'id: D5',
        'name: Test D5',
        'stage: per-turn',
        'order: 500',
        'version: 1',
        'enabled: true',
        'template: d5.md',
        'inputs: []',
        'disableable: true',
        'safetyTier: limited-edit',
        'transparencyTier: visible-by-default',
        'governanceTier: human-gated',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'd5', 'd5.md'), '<!-- D5 baseline -->');

    const registry = new HookRegistry(dir);
    registry.scan();

    const snapshot = new Map();
    snapshot.set('D5', {
      hookId: 'D5',
      contentOverride: 'operator-approved content v3',
      contentVersion: 3,
      contentSource: 'operator',
      source: 'operator',
      updatedAt: Date.now(),
      updatedBy: 'human',
    });
    registry.setOverrideSnapshot(snapshot);

    // Content must be honored (operator source on limited-edit)
    assert.equal(registry.getContentOverride('D5'), 'operator-approved content v3', 'content honored');
    // Version must match override
    assert.equal(
      registry.getActiveVersion('D5'),
      3,
      'getActiveVersion returns override version when content is honored',
    );

    rmSync(dir, { recursive: true, force: true });
  });

  test('getActiveVersion returns manifest version on readonly hook with stale override', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { HookRegistry } = await import('../dist/domains/prompt-hooks/HookRegistry.js');

    const dir = join(import.meta.dirname, '__fixtures__', 'sol-p2-version-readonly');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'd5'), { recursive: true });
    writeFileSync(
      join(dir, 'd5', 'hook.yaml'),
      [
        'id: D5',
        'name: Test D5',
        'stage: per-turn',
        'order: 500',
        'version: 2',
        'enabled: true',
        'template: d5.md',
        'inputs: []',
        'disableable: false',
        'safetyTier: readonly',
        'transparencyTier: visible-by-default',
        'governanceTier: human-gated',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'd5', 'd5.md'), '<!-- D5 readonly -->');

    const registry = new HookRegistry(dir);
    registry.scan();

    // Stale override from before manifest tightened to readonly
    const snapshot = new Map();
    snapshot.set('D5', {
      hookId: 'D5',
      contentOverride: 'stale content from editable era',
      contentVersion: 50,
      contentSource: 'operator',
      source: 'operator',
      updatedAt: Date.now(),
      updatedBy: 'human',
    });
    registry.setOverrideSnapshot(snapshot);

    assert.equal(registry.getContentOverride('D5'), undefined, 'readonly rejects content');
    assert.equal(
      registry.getActiveVersion('D5'),
      2,
      'getActiveVersion returns manifest version on readonly hook (sol P2)',
    );

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Same-ms event ordering (R5 P1-1)', () => {
  test('event IDs sort by seq, not action name', async () => {
    const s1 = makeManifest('S1-order');
    const fakeRedis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
    const lookup = (id) => (id === s1.id ? s1 : undefined);
    const orderStore = new mod.HookOverrideStore(fakeRedis, lookup);

    const frozenMs = 1700000000000;
    const origNow = Date.now;
    Date.now = () => frozenMs;
    try {
      await orderStore.setContentOverride(s1.id, 'v1', 'operator', 'u1');
      await orderStore.rollback(s1.id, 'u1');
      await orderStore.setContentOverride(s1.id, 'v2', 'operator', 'u1');
    } finally {
      Date.now = origNow;
    }

    const events = await orderStore.listEvents({ limit: 100 });
    const actions = events.map((e) => e.action);
    assert.equal(actions[0], 'content-set', 'first: content-set (v1)');
    assert.equal(actions[1], 'rollback', 'second: rollback');
    assert.equal(actions[2], 'content-set', 'third: content-set (v2)');
  });
});

describe('P1-3 R6: epochVersion-based version management', () => {
  test('snapshots keyed by epochVersion (manifest.version+N), activateVersion restores by epochVersion', async () => {
    const s1 = makeManifest('S1-ver');
    const fakeRedis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
    const lookup = (id) => (id === s1.id ? s1 : undefined);
    const store = new mod.HookOverrideStore(fakeRedis, lookup);

    // manifest.version=1, so first override epochVersion=2, second=3
    await store.setContentOverride(s1.id, 'content-A', 'u1');
    await store.setContentOverride(s1.id, 'content-B', 'u1');

    const beforeActivate = await store.getOverride(s1.id);
    assert.equal(beforeActivate.contentVersion, 2);
    assert.equal(beforeActivate.contentOverride, 'content-B');

    // Activate epochVersion=2 (first override) — content should restore to A
    await store.activateVersion(s1.id, 2, 'u1');

    const afterActivate = await store.getOverride(s1.id);
    assert.equal(afterActivate.contentOverride, 'content-A', 'content should be first override');
    // contentVersion stays at 2 (edit counter, not identity)
    assert.equal(afterActivate.contentVersion, 2, 'contentVersion is edit count, not reset');
  });

  test('getVersionContent returns the exact immutable snapshot instead of the truncated list preview', async () => {
    const s1 = makeManifest('S1-content');
    const fakeRedis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
    const store = new mod.HookOverrideStore(fakeRedis, (id) => (id === s1.id ? s1 : undefined));
    const content = `full-version-content:${'x'.repeat(180)}`;
    await store.setContentOverride(s1.id, content, 'u1');

    const versions = await store.listVersions(s1.id);
    assert.match(versions[0].contentPreview, /…$/);
    assert.equal(await store.getVersionContent(s1.id, versions[0].version), content);
    assert.equal(await store.getVersionContent(s1.id, 999), null);
  });

  test('epochVersion is monotonic: activate→set creates new epochVersion, no collision', async () => {
    const s1 = makeManifest('S1-mono');
    const fakeRedis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
    const lookup = (id) => (id === s1.id ? s1 : undefined);
    const store = new mod.HookOverrideStore(fakeRedis, lookup);

    await store.setContentOverride(s1.id, 'A', 'u1'); // epochVersion=2
    await store.setContentOverride(s1.id, 'B', 'u1'); // epochVersion=3
    await store.activateVersion(s1.id, 2, 'u1'); // restore A
    await store.setContentOverride(s1.id, 'C', 'u1'); // epochVersion=4 (NOT 3!)

    const versions = await store.listVersions(s1.id);
    assert.equal(versions.length, 3, 'should have 3 snapshots (2,3,4)');
    assert.equal(versions[0].version, 2);
    assert.ok(versions[0].contentPreview.includes('A'));
    assert.equal(versions[1].version, 3);
    assert.ok(versions[1].contentPreview.includes('B'), 'B must NOT be overwritten by C');
    assert.equal(versions[2].version, 4);
    assert.ok(versions[2].contentPreview.includes('C'));
  });

  test('version-activate event carries epochVersion, not contentVersion', async () => {
    const s1 = makeManifest('S1-evt');
    const fakeRedis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
    const lookup = (id) => (id === s1.id ? s1 : undefined);
    const store = new mod.HookOverrideStore(fakeRedis, lookup);

    await store.setContentOverride(s1.id, 'v1-content', 'u1');
    await store.setContentOverride(s1.id, 'v2-content', 'u1');
    await store.activateVersion(s1.id, 2, 'u1', { reason: 'reverting' });

    const events = await store.listEvents({ limit: 100 });
    const activateEvent = events.find((e) => e.action === 'version-activate');
    assert.ok(activateEvent, 'version-activate event should exist');
    assert.equal(activateEvent.epochVersion, 2, 'event should carry epochVersion');
    assert.equal(activateEvent.contentVersion, undefined, 'contentVersion should NOT be on activate events');
    assert.equal(activateEvent.reason, 'reverting');
  });

  test('content-set events carry epochVersion', async () => {
    const s1 = makeManifest('S1-cs-epoch');
    const fakeRedis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
    const lookup = (id) => (id === s1.id ? s1 : undefined);
    const store = new mod.HookOverrideStore(fakeRedis, lookup);

    await store.setContentOverride(s1.id, 'hello', 'u1');
    const events = await store.listEvents({ limit: 100 });
    assert.equal(events[0].epochVersion, 2, 'first override epochVersion = manifest.version + 1');
    assert.equal(events[0].contentVersion, 1, 'contentVersion is edit count (1)');
  });

  test('activateVersion throws for nonexistent epochVersion', async () => {
    const s1 = makeManifest('S1-nosnap');
    const fakeRedis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
    const lookup = (id) => (id === s1.id ? s1 : undefined);
    const store = new mod.HookOverrideStore(fakeRedis, lookup);

    await assert.rejects(() => store.activateVersion(s1.id, 99, 'u1'), /No content snapshot/);
  });

  test('listVersions returns all epochVersion snapshots in order', async () => {
    const s1 = makeManifest('S1-list');
    const fakeRedis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
    const lookup = (id) => (id === s1.id ? s1 : undefined);
    const store = new mod.HookOverrideStore(fakeRedis, lookup);

    await store.setContentOverride(s1.id, 'alpha', 'u1');
    await store.setContentOverride(s1.id, 'beta', 'u1');

    const versions = await store.listVersions(s1.id);
    assert.equal(versions.length, 2);
    assert.equal(versions[0].version, 2, 'first epochVersion = manifest+1 = 2');
    assert.ok(versions[0].contentPreview.includes('alpha'));
    assert.equal(versions[1].version, 3, 'second epochVersion = 3');
  });

  // ── R7 regression: activeEpochVersion propagation ──

  test('setContentOverride sets activeEpochVersion on the override (R7)', async () => {
    const s1 = makeManifest('S1-aev-set');
    const fakeRedis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
    const lookup = (id) => (id === s1.id ? s1 : undefined);
    const store = new mod.HookOverrideStore(fakeRedis, lookup);

    await store.setContentOverride(s1.id, 'v2 content', 'u1');
    const override = await store.getOverride(s1.id);
    assert.equal(override.activeEpochVersion, 2, 'activeEpochVersion = epochVersion from setContentOverride');

    await store.setContentOverride(s1.id, 'v3 content', 'u1');
    const override2 = await store.getOverride(s1.id);
    assert.equal(override2.activeEpochVersion, 3, 'activeEpochVersion advances with each setContentOverride');
  });

  test('activateVersion sets activeEpochVersion on the override (R7)', async () => {
    const s1 = makeManifest('S1-aev-activate');
    const fakeRedis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
    const lookup = (id) => (id === s1.id ? s1 : undefined);
    const store = new mod.HookOverrideStore(fakeRedis, lookup);

    await store.setContentOverride(s1.id, 'v2 content', 'u1');
    await store.setContentOverride(s1.id, 'v3 content', 'u1');
    const before = await store.getOverride(s1.id);
    assert.equal(before.activeEpochVersion, 3, 'should be at epoch 3');

    // Activate v2 — activeEpochVersion should switch to 2
    await store.activateVersion(s1.id, 2, 'u1', { reason: 'rollback to v2' });
    const after = await store.getOverride(s1.id);
    assert.equal(after.activeEpochVersion, 2, 'activateVersion should set activeEpochVersion to target');
  });

  test('clearContentOverride removes activeEpochVersion (R7)', async () => {
    const s1 = makeManifest('S1-aev-clear');
    const fakeRedis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
    const lookup = (id) => (id === s1.id ? s1 : undefined);
    const store = new mod.HookOverrideStore(fakeRedis, lookup);

    await store.setContentOverride(s1.id, 'v2 content', 'u1');
    const before = await store.getOverride(s1.id);
    assert.equal(before.activeEpochVersion, 2, 'has activeEpochVersion before clear');

    await store.clearContentOverride(s1.id, 'u1');
    const after = await store.getOverride(s1.id);
    assert.equal(after.activeEpochVersion, undefined, 'activeEpochVersion removed after clear');
  });

  test('rollback removes activeEpochVersion (R7)', async () => {
    const s1 = makeManifest('S1-aev-rollback');
    const fakeRedis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
    const lookup = (id) => (id === s1.id ? s1 : undefined);
    const store = new mod.HookOverrideStore(fakeRedis, lookup);

    await store.setContentOverride(s1.id, 'v2 content', 'u1');
    await store.rollback(s1.id, 'u1');
    const after = await store.getOverride(s1.id);
    assert.equal(after, null, 'rollback deletes entire override');
  });

  test('concurrent setContentOverride gets distinct epochVersions — no collision (R7)', async () => {
    const s1 = makeManifest('S1-concurrent');
    const fakeRedis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/HookOverrideStore.js');
    const lookup = (id) => (id === s1.id ? s1 : undefined);
    const store = new mod.HookOverrideStore(fakeRedis, lookup);

    // Fire two setContentOverride concurrently — both use SETNX+INCR so
    // they should get distinct epoch versions and not overwrite snapshots.
    await Promise.all([
      store.setContentOverride(s1.id, 'concurrent-A', 'u1'),
      store.setContentOverride(s1.id, 'concurrent-B', 'u2'),
    ]);

    const versions = await store.listVersions(s1.id);
    assert.equal(versions.length, 2, 'both concurrent writes created distinct snapshots');

    const epochVersions = versions.map((v) => v.version);
    assert.notEqual(epochVersions[0], epochVersions[1], 'epochVersions must differ');

    // Both contents should be preserved (no overwrite)
    const contents = versions.map((v) => v.contentPreview);
    assert.ok(
      contents.includes('concurrent-A') && contents.includes('concurrent-B'),
      'both snapshot contents must be preserved',
    );
  });
});
