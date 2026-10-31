/**
 * F153 Phase E L1.5: MetricsSnapshotStore ring buffer tests.
 *
 * Covers:
 * - Snapshot add/query basics
 * - maxSnapshots cap eviction
 * - maxAgeMs TTL eviction
 * - Query with since filter
 * - Stats reporting
 * - parsePrometheusText parsing
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { MetricsSnapshotStore, parsePrometheusText } = await import(
  '../../dist/infrastructure/telemetry/metrics-snapshot-store.js'
);

test('MetricsSnapshotStore: add and query returns stored snapshot', () => {
  const store = new MetricsSnapshotStore({ maxSnapshots: 100 });
  store.add({ timestamp: Date.now(), metrics: { invocations_total: 5 } });

  const results = store.query();
  assert.equal(results.length, 1);
  assert.equal(results[0].metrics['invocations_total'], 5);
});

test('MetricsSnapshotStore: query returns latest N snapshots by default', () => {
  const store = new MetricsSnapshotStore({ maxSnapshots: 100 });
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    store.add({ timestamp: now + i * 1000, metrics: { count: i } });
  }

  const results = store.query(undefined, 3);
  assert.equal(results.length, 3);
  assert.equal(results[0].metrics.count, 7);
  assert.equal(results[2].metrics.count, 9);
});

test('MetricsSnapshotStore: query with since filter', () => {
  const store = new MetricsSnapshotStore({ maxSnapshots: 100 });
  const now = Date.now();
  store.add({ timestamp: now - 5000, metrics: { a: 1 } });
  store.add({ timestamp: now - 3000, metrics: { a: 2 } });
  store.add({ timestamp: now - 1000, metrics: { a: 3 } });

  const results = store.query(now - 3500);
  assert.equal(results.length, 2);
  assert.equal(results[0].metrics.a, 2);
  assert.equal(results[1].metrics.a, 3);
});

test('MetricsSnapshotStore: query with since + limit', () => {
  const store = new MetricsSnapshotStore({ maxSnapshots: 100 });
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    store.add({ timestamp: now + i * 1000, metrics: { i } });
  }

  const results = store.query(now + 3000, 2);
  assert.equal(results.length, 2);
  assert.equal(results[0].metrics.i, 3);
});

test('MetricsSnapshotStore: maxSnapshots eviction drops oldest', () => {
  const now = Date.now();
  const store = new MetricsSnapshotStore({ maxSnapshots: 3, maxAgeMs: 999_999_999 });
  store.add({ timestamp: now - 3000, metrics: { tag: 'first' } });
  store.add({ timestamp: now - 2000, metrics: { tag: 'second' } });
  store.add({ timestamp: now - 1000, metrics: { tag: 'third' } });
  store.add({ timestamp: now, metrics: { tag: 'fourth' } });

  const results = store.query();
  assert.equal(results.length, 3);
  assert.equal(results[0].metrics.tag, 'second');
  assert.equal(results[2].metrics.tag, 'fourth');
});

test('MetricsSnapshotStore: maxAgeMs eviction drops expired', () => {
  const store = new MetricsSnapshotStore({ maxSnapshots: 100, maxAgeMs: 50 });
  store.add({ timestamp: Date.now() - 100, metrics: { old: 1 } });
  store.add({ timestamp: Date.now(), metrics: { fresh: 1 } });

  const results = store.query();
  assert.equal(results.length, 1);
  assert.ok(results[0].metrics.fresh);
});

test('MetricsSnapshotStore: stats returns correct info', () => {
  const store = new MetricsSnapshotStore({ maxSnapshots: 720, maxAgeMs: 21600000 });
  const now = Date.now();
  store.add({ timestamp: now - 1000, metrics: {} });
  store.add({ timestamp: now, metrics: {} });

  const stats = store.stats();
  assert.equal(stats.snapshotCount, 2);
  assert.equal(stats.maxSnapshots, 720);
  assert.equal(stats.maxAgeMs, 21600000);
  assert.equal(stats.oldestTimestamp, now - 1000);
  assert.equal(stats.newestTimestamp, now);
});

test('MetricsSnapshotStore: stats on empty store', () => {
  const store = new MetricsSnapshotStore();
  const stats = store.stats();
  assert.equal(stats.snapshotCount, 0);
  assert.equal(stats.oldestTimestamp, null);
  assert.equal(stats.newestTimestamp, null);
});

test('MetricsSnapshotStore: default config (720 snapshots, 6h)', () => {
  const store = new MetricsSnapshotStore();
  const stats = store.stats();
  assert.equal(stats.maxSnapshots, 720);
  assert.equal(stats.maxAgeMs, 6 * 60 * 60 * 1000);
});

test('MetricsSnapshotStore: clear removes all', () => {
  const store = new MetricsSnapshotStore({ maxSnapshots: 100 });
  store.add({ timestamp: Date.now(), metrics: { x: 1 } });
  store.add({ timestamp: Date.now(), metrics: { y: 2 } });
  assert.equal(store.stats().snapshotCount, 2);

  store.clear();
  assert.equal(store.stats().snapshotCount, 0);
  assert.deepEqual(store.query(), []);
});

// ─── parsePrometheusText ───

test('parsePrometheusText: parses gauge/counter lines', () => {
  const text = [
    '# HELP cat_cafe_invocations_total Total invocations',
    '# TYPE cat_cafe_invocations_total counter',
    'cat_cafe_invocations_total{agent_id="ragdoll"} 42',
    'cat_cafe_invocations_total{agent_id="maine-coon"} 7',
    '# HELP process_uptime_seconds Process uptime',
    '# TYPE process_uptime_seconds gauge',
    'process_uptime_seconds 3600.5',
  ].join('\n');

  const metrics = parsePrometheusText(text);
  assert.equal(metrics['cat_cafe_invocations_total{agent_id="ragdoll"}'], 42);
  assert.equal(metrics['cat_cafe_invocations_total{agent_id="maine-coon"}'], 7);
  assert.equal(metrics['process_uptime_seconds'], 3600.5);
});

test('parsePrometheusText: skips _bucket, _count, _sum lines', () => {
  const text = [
    'cat_cafe_duration_bucket{le="0.5"} 10',
    'cat_cafe_duration_bucket{le="1"} 20',
    'cat_cafe_duration_count{} 30',
    'cat_cafe_duration_sum{} 45.5',
    'cat_cafe_active_sessions 5',
  ].join('\n');

  const metrics = parsePrometheusText(text);
  assert.equal(Object.keys(metrics).length, 1);
  assert.equal(metrics['cat_cafe_active_sessions'], 5);
});

test('parsePrometheusText: handles empty and comment-only input', () => {
  assert.deepEqual(parsePrometheusText(''), {});
  assert.deepEqual(parsePrometheusText('# just a comment\n# another'), {});
});

test('parsePrometheusText: handles scientific notation', () => {
  const text = 'metric_value 1.5e+3';
  const metrics = parsePrometheusText(text);
  assert.equal(metrics['metric_value'], 1500);
});
