/**
 * ToolUsageArchiver + days=0 merge + sweep-path Tests — F150 Phase B (#339)
 * Covers JSONL archive persistence, all-time (days=0) Redis+archive merge,
 * and the sweep building blocks (fetchAllEntries, getArchivedDates, dedup).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

/** Create isolated temp dir for each test. */
function makeTempDir() {
  const dir = join(tmpdir(), `tool-usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Minimal fake Redis (same as counter tests). */
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
    async expire() {},
    async scan(cursor, _mf, pattern, _cf, _c) {
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

// ── ToolUsageArchiver tests ──

describe('ToolUsageArchiver', () => {
  let tempDir;
  let archivePath;

  beforeEach(() => {
    tempDir = makeTempDir();
    archivePath = join(tempDir, 'archive.jsonl');
  });

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
  });

  test('archiveEntries writes JSONL lines and loadArchive reads them back', async () => {
    const { ToolUsageArchiver } = await import('../dist/domains/cats/services/tool-usage/ToolUsageArchiver.js');
    const archiver = new ToolUsageArchiver(archivePath);

    const entries = [
      { date: '2026-03-20', catId: 'opus', category: 'native', toolName: 'Read', count: 42 },
      { date: '2026-03-20', catId: 'opus', category: 'mcp', toolName: 'mcp__cat-cafe__post', count: 5 },
    ];

    const written = await archiver.archiveEntries(entries);
    assert.equal(written, 2);

    const loaded = await archiver.loadArchive();
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].toolName, 'Read');
    assert.equal(loaded[0].count, 42);
    assert.equal(loaded[1].toolName, 'mcp__cat-cafe__post');
  });

  test('archiveEntries with empty array is no-op', async () => {
    const { ToolUsageArchiver } = await import('../dist/domains/cats/services/tool-usage/ToolUsageArchiver.js');
    const archiver = new ToolUsageArchiver(archivePath);

    const written = await archiver.archiveEntries([]);
    assert.equal(written, 0);
    assert.equal(existsSync(archivePath), false);
  });

  test('loadArchive returns empty for non-existent file', async () => {
    const { ToolUsageArchiver } = await import('../dist/domains/cats/services/tool-usage/ToolUsageArchiver.js');
    const archiver = new ToolUsageArchiver(join(tempDir, 'does-not-exist.jsonl'));

    const loaded = await archiver.loadArchive();
    assert.deepEqual(loaded, []);
  });

  test('loadArchive skips malformed lines', async () => {
    const { ToolUsageArchiver } = await import('../dist/domains/cats/services/tool-usage/ToolUsageArchiver.js');
    const archiver = new ToolUsageArchiver(archivePath);

    writeFileSync(
      archivePath,
      [
        '{"date":"2026-03-20","catId":"opus","category":"native","toolName":"Read","count":10}',
        'NOT JSON',
        '{"date":"2026-03-21","catId":"codex","category":"mcp","toolName":"post","count":3}',
        '',
      ].join('\n'),
      'utf-8',
    );

    const loaded = await archiver.loadArchive();
    assert.equal(loaded.length, 2);
  });

  test('getArchivedDates returns unique dates', async () => {
    const { ToolUsageArchiver } = await import('../dist/domains/cats/services/tool-usage/ToolUsageArchiver.js');
    const archiver = new ToolUsageArchiver(archivePath);

    await archiver.archiveEntries([
      { date: '2026-03-20', catId: 'opus', category: 'native', toolName: 'Read', count: 10 },
      { date: '2026-03-20', catId: 'codex', category: 'mcp', toolName: 'post', count: 5 },
      { date: '2026-03-21', catId: 'opus', category: 'skill', toolName: 'tdd', count: 2 },
    ]);

    const dates = await archiver.getArchivedDates();
    assert.equal(dates.size, 2);
    assert.ok(dates.has('2026-03-20'));
    assert.ok(dates.has('2026-03-21'));
  });

  test('multiple archiveEntries calls append without overwriting', async () => {
    const { ToolUsageArchiver } = await import('../dist/domains/cats/services/tool-usage/ToolUsageArchiver.js');
    const archiver = new ToolUsageArchiver(archivePath);

    await archiver.archiveEntries([
      { date: '2026-03-20', catId: 'opus', category: 'native', toolName: 'Read', count: 10 },
    ]);
    await archiver.archiveEntries([
      { date: '2026-03-21', catId: 'codex', category: 'mcp', toolName: 'post', count: 7 },
    ]);

    const loaded = await archiver.loadArchive();
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].date, '2026-03-20');
    assert.equal(loaded[1].date, '2026-03-21');
  });
});

// ── days=0 all-time merge tests ──

describe('days=0 all-time merge (Redis + archive)', () => {
  let fakeRedis;

  beforeEach(() => {
    fakeRedis = createFakeRedis();
  });

  test('days=0 merges Redis and archive data', async () => {
    const { ToolUsageCounter } = await import('../dist/domains/cats/services/tool-usage/ToolUsageCounter.js');

    const archiveEntries = [
      { date: '2026-01-15', catId: 'opus', category: 'native', toolName: 'Read', count: 100 },
      { date: '2026-01-15', catId: 'opus', category: 'mcp', toolName: 'post', count: 20 },
    ];

    const fakeArchiver = {
      async loadArchive() {
        return archiveEntries;
      },
    };

    const counter = new ToolUsageCounter(fakeRedis, fakeArchiver);

    // Add fresh Redis data (today)
    counter.recordToolUse('opus', 'Read');
    counter.recordToolUse('opus', 'Read');
    await new Promise((r) => setTimeout(r, 50));

    const report = await counter.aggregate(0);

    // Should have archive (100 + 20) + Redis (2) = 122 total
    assert.equal(report.summary.totalCalls, 122);
    assert.ok(report.period.from <= '2026-01-15', 'period.from should include archive dates');
  });

  test('days=0 deduplicates at entry-level (date+catId+category+toolName)', async () => {
    const { ToolUsageCounter } = await import('../dist/domains/cats/services/tool-usage/ToolUsageCounter.js');

    const today = new Date().toISOString().slice(0, 10);

    const fakeArchiver = {
      async loadArchive() {
        // Stale archive entry for today's Read — Redis should win
        return [
          { date: today, catId: 'opus', category: 'native', toolName: 'Read', count: 5 },
          // Archive entry for a different tool — should be kept
          { date: '2026-01-10', catId: 'opus', category: 'skill', toolName: 'tdd', count: 3 },
        ];
      },
    };

    const counter = new ToolUsageCounter(fakeRedis, fakeArchiver);

    // Redis has today's Read with count=2
    counter.recordToolUse('opus', 'Read');
    counter.recordToolUse('opus', 'Read');
    await new Promise((r) => setTimeout(r, 50));

    const report = await counter.aggregate(0);

    // Redis: Read=2, Archive kept: tdd=3 (stale Read=5 deduped out)
    assert.equal(report.summary.totalCalls, 5);
    assert.equal(report.summary.byCategory.native, 2, 'Redis Read should win over stale archive');
    assert.equal(report.summary.byCategory.skill, 3, 'Non-overlapping archive entry kept');
  });

  test('days=0 without archiver works (Redis only)', async () => {
    const { ToolUsageCounter } = await import('../dist/domains/cats/services/tool-usage/ToolUsageCounter.js');
    const counter = new ToolUsageCounter(fakeRedis);

    counter.recordToolUse('opus', 'Read');
    await new Promise((r) => setTimeout(r, 50));

    const report = await counter.aggregate(0);
    assert.equal(report.summary.totalCalls, 1);
  });
});

// ── Sweep building blocks ──

describe('Sweep path components', () => {
  let fakeRedis;

  beforeEach(() => {
    fakeRedis = createFakeRedis();
  });

  test('fetchAllEntries returns all Redis entries without date filter', async () => {
    const { ToolUsageCounter } = await import('../dist/domains/cats/services/tool-usage/ToolUsageCounter.js');
    const counter = new ToolUsageCounter(fakeRedis);

    // Manually seed Redis with entries for multiple dates
    fakeRedis._store.set('tool-stats:2026-03-01:opus:native:Read', '10');
    fakeRedis._store.set('tool-stats:2026-03-15:codex:mcp:post', '5');
    fakeRedis._store.set('tool-stats:2026-03-28:opus:skill:tdd', '3');

    const entries = await counter.fetchAllEntries();
    assert.equal(entries.length, 3);

    const dates = entries.map((e) => e.date).sort();
    assert.deepEqual(dates, ['2026-03-01', '2026-03-15', '2026-03-28']);
  });

  test('sweep flow: fetchAllEntries → filter by date → archive → verify dedup', async () => {
    const { ToolUsageCounter } = await import('../dist/domains/cats/services/tool-usage/ToolUsageCounter.js');
    const { ToolUsageArchiver } = await import('../dist/domains/cats/services/tool-usage/ToolUsageArchiver.js');

    const tempDir = makeTempDir();
    const archivePath = join(tempDir, 'sweep-test.jsonl');

    try {
      const archiver = new ToolUsageArchiver(archivePath);
      const counter = new ToolUsageCounter(fakeRedis, archiver);

      // Seed Redis with "old" entries that a sweep would target
      fakeRedis._store.set('tool-stats:2026-02-01:opus:native:Read', '50');
      fakeRedis._store.set('tool-stats:2026-02-01:opus:mcp:post', '10');
      fakeRedis._store.set('tool-stats:2026-03-29:opus:native:Read', '5');

      // Simulate sweep: fetch all → filter target dates → archive
      const allEntries = await counter.fetchAllEntries();
      const targetDate = '2026-02-01';
      const toArchive = allEntries.filter((e) => e.date === targetDate);
      assert.equal(toArchive.length, 2);

      await archiver.archiveEntries(toArchive);

      // Verify archived dates
      const archivedDates = await archiver.getArchivedDates();
      assert.ok(archivedDates.has('2026-02-01'));
      assert.ok(!archivedDates.has('2026-03-29'), 'Recent date should not be archived');

      // Verify sweep idempotence: second sweep skips already-archived dates
      const archivedDates2 = await archiver.getArchivedDates();
      const remainingTargets = [targetDate].filter((d) => !archivedDates2.has(d));
      assert.equal(remainingTargets.length, 0, 'Already archived date should be skipped');
    } finally {
      if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
    }
  });
});
