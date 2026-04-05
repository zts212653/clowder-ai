/**
 * ToolUsageCounter Tests — F150 (#339)
 * Tests recordToolUse (INCR) + aggregate (SCAN → report).
 * Uses a fake Redis to avoid real I/O.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

/** Minimal fake Redis with incr/expire/scan/mget support. */
function createFakeRedis() {
  const store = new Map();

  return {
    _store: store,

    async incr(key) {
      const cur = parseInt(store.get(key) ?? '0', 10);
      const next = cur + 1;
      store.set(key, String(next));
      return next;
    },

    async expire(_key, _seconds) {
      // no-op for tests
    },

    async scan(cursor, _matchFlag, pattern, _countFlag, _count) {
      // Simple: return all matching keys in one go (cursor '0' → done)
      if (cursor !== '0') return ['0', []];
      const glob = pattern.replace('*', '');
      const matched = [];
      for (const k of store.keys()) {
        if (k.startsWith(glob)) matched.push(k);
      }
      return ['0', matched];
    },

    async mget(...keys) {
      return keys.map((k) => store.get(k) ?? null);
    },
  };
}

describe('ToolUsageCounter', () => {
  let fakeRedis;

  beforeEach(() => {
    fakeRedis = createFakeRedis();
  });

  test('recordToolUse increments Redis counter for native tool', async () => {
    const { ToolUsageCounter } = await import('../dist/domains/cats/services/tool-usage/ToolUsageCounter.js');
    const counter = new ToolUsageCounter(fakeRedis);

    counter.recordToolUse('opus', 'Read', undefined);
    // Allow fire-and-forget promise to settle
    await new Promise((r) => setTimeout(r, 50));

    const keys = [...fakeRedis._store.keys()];
    assert.equal(keys.length, 1);
    assert.ok(keys[0].includes(':opus:native:Read'));
    assert.equal(fakeRedis._store.get(keys[0]), '1');
  });

  test('recordToolUse increments for MCP tool', async () => {
    const { ToolUsageCounter } = await import('../dist/domains/cats/services/tool-usage/ToolUsageCounter.js');
    const counter = new ToolUsageCounter(fakeRedis);

    counter.recordToolUse('codex', 'mcp__cat-cafe__cat_cafe_post_message', undefined);
    await new Promise((r) => setTimeout(r, 50));

    const keys = [...fakeRedis._store.keys()];
    assert.equal(keys.length, 1);
    assert.ok(keys[0].includes(':codex:mcp:mcp__cat-cafe__cat_cafe_post_message'));
  });

  test('recordToolUse increments for Skill', async () => {
    const { ToolUsageCounter } = await import('../dist/domains/cats/services/tool-usage/ToolUsageCounter.js');
    const counter = new ToolUsageCounter(fakeRedis);

    counter.recordToolUse('opus', 'Skill', { skill: 'tdd' });
    await new Promise((r) => setTimeout(r, 50));

    const keys = [...fakeRedis._store.keys()];
    assert.equal(keys.length, 1);
    assert.ok(keys[0].includes(':opus:skill:tdd'));
  });

  test('multiple increments accumulate', async () => {
    const { ToolUsageCounter } = await import('../dist/domains/cats/services/tool-usage/ToolUsageCounter.js');
    const counter = new ToolUsageCounter(fakeRedis);

    counter.recordToolUse('opus', 'Read');
    counter.recordToolUse('opus', 'Read');
    counter.recordToolUse('opus', 'Read');
    await new Promise((r) => setTimeout(r, 50));

    const keys = [...fakeRedis._store.keys()];
    assert.equal(keys.length, 1);
    assert.equal(fakeRedis._store.get(keys[0]), '3');
  });

  test('aggregate returns correct report shape', async () => {
    const { ToolUsageCounter } = await import('../dist/domains/cats/services/tool-usage/ToolUsageCounter.js');
    const counter = new ToolUsageCounter(fakeRedis);

    counter.recordToolUse('opus', 'Read');
    counter.recordToolUse('opus', 'Edit');
    counter.recordToolUse('opus', 'mcp__cat-cafe__post_message');
    counter.recordToolUse('codex', 'Skill', { skill: 'tdd' });
    await new Promise((r) => setTimeout(r, 50));

    const report = await counter.aggregate(1);

    assert.equal(report.summary.totalCalls, 4);
    assert.equal(report.summary.byCategory.native, 2);
    assert.equal(report.summary.byCategory.mcp, 1);
    assert.equal(report.summary.byCategory.skill, 1);
    assert.ok(report.topTools.length > 0);
    assert.ok(report.daily.length === 1);
    assert.ok('opus' in report.byCat);
    assert.ok('codex' in report.byCat);
  });

  test('aggregate filters by catId', async () => {
    const { ToolUsageCounter } = await import('../dist/domains/cats/services/tool-usage/ToolUsageCounter.js');
    const counter = new ToolUsageCounter(fakeRedis);

    counter.recordToolUse('opus', 'Read');
    counter.recordToolUse('codex', 'Write');
    await new Promise((r) => setTimeout(r, 50));

    const report = await counter.aggregate(1, { catId: 'opus' });

    assert.equal(report.summary.totalCalls, 1);
    assert.ok(!('codex' in report.byCat));
  });

  test('aggregate filters by category', async () => {
    const { ToolUsageCounter } = await import('../dist/domains/cats/services/tool-usage/ToolUsageCounter.js');
    const counter = new ToolUsageCounter(fakeRedis);

    counter.recordToolUse('opus', 'Read');
    counter.recordToolUse('opus', 'mcp__cat-cafe__post');
    await new Promise((r) => setTimeout(r, 50));

    const report = await counter.aggregate(1, { category: 'mcp' });

    assert.equal(report.summary.totalCalls, 1);
    assert.equal(report.summary.byCategory.mcp, 1);
    assert.equal(report.summary.byCategory.native, 0);
  });

  test('aggregate works correctly with ioredis keyPrefix', async () => {
    const { ToolUsageCounter } = await import('../dist/domains/cats/services/tool-usage/ToolUsageCounter.js');

    // Simulate ioredis keyPrefix behavior: write commands auto-prepend,
    // SCAN returns raw keys (with prefix), MGET auto-prepends.
    const PREFIX = 'cat-cafe:';
    const store = new Map();
    const prefixedRedis = {
      options: { keyPrefix: PREFIX },
      _store: store,
      async incr(key) {
        const realKey = PREFIX + key;
        const cur = parseInt(store.get(realKey) ?? '0', 10);
        const next = cur + 1;
        store.set(realKey, String(next));
        return next;
      },
      async expire() {},
      async scan(cursor, _mf, pattern, _cf, _c) {
        // SCAN sees raw keys; pattern already has prefix from our fix
        if (cursor !== '0') return ['0', []];
        const glob = pattern.replace('*', '');
        const matched = [];
        for (const k of store.keys()) {
          if (k.startsWith(glob)) matched.push(k);
        }
        return ['0', matched];
      },
      async mget(...keys) {
        // MGET auto-prepends prefix (like ioredis)
        return keys.map((k) => store.get(PREFIX + k) ?? null);
      },
    };

    const counter = new ToolUsageCounter(prefixedRedis);

    counter.recordToolUse('opus', 'Read');
    counter.recordToolUse('opus', 'mcp__cat-cafe__post');
    await new Promise((r) => setTimeout(r, 50));

    // Verify keys have prefix in store
    for (const k of store.keys()) {
      assert.ok(k.startsWith(PREFIX), `key "${k}" should have prefix "${PREFIX}"`);
    }

    const report = await counter.aggregate(1);

    assert.equal(report.summary.totalCalls, 2);
    assert.equal(report.summary.byCategory.native, 1);
    assert.equal(report.summary.byCategory.mcp, 1);
    assert.ok(report.topTools.length === 2);
  });
});
