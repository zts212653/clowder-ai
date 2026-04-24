/**
 * F153 Phase E: LocalTraceStore ring buffer tests.
 *
 * Covers:
 * - DTO add/query basics
 * - maxSpans cap eviction
 * - maxAgeMs TTL eviction
 * - Query filtering (traceId, invocationId, catId)
 * - Stats reporting
 * - Clear
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { LocalTraceStore } = await import('../../dist/infrastructure/telemetry/local-trace-store.js');

/** Create a minimal valid DTO for testing. */
function makeDTO(overrides = {}) {
  return {
    traceId: 'aaaa',
    spanId: 'bbbb',
    parentSpanId: undefined,
    name: 'test.span',
    kind: 0,
    startTimeMs: Date.now() - 100,
    endTimeMs: Date.now(),
    durationMs: 100,
    status: { code: 0 },
    attributes: {},
    events: [],
    storedAt: Date.now(),
    ...overrides,
  };
}

test('LocalTraceStore: add and query returns stored span', () => {
  const store = new LocalTraceStore({ maxSpans: 100 });
  const dto = makeDTO({ traceId: 'trace-1' });
  store.add(dto);

  const results = store.query({});
  assert.equal(results.length, 1);
  assert.equal(results[0].traceId, 'trace-1');
});

test('LocalTraceStore: query by traceId filters correctly', () => {
  const store = new LocalTraceStore({ maxSpans: 100 });
  store.add(makeDTO({ traceId: 'aaa' }));
  store.add(makeDTO({ traceId: 'bbb' }));
  store.add(makeDTO({ traceId: 'aaa', spanId: 'second' }));

  const results = store.query({ traceId: 'aaa' });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.traceId === 'aaa'));
});

test('LocalTraceStore: query by invocationId matches attribute', () => {
  const store = new LocalTraceStore({ maxSpans: 100 });
  store.add(makeDTO({ attributes: { invocationId: 'hmac-inv-1' } }));
  store.add(makeDTO({ attributes: { invocationId: 'hmac-inv-2' } }));

  const results = store.query({ invocationId: 'hmac-inv-1' });
  assert.equal(results.length, 1);
  assert.equal(results[0].attributes.invocationId, 'hmac-inv-1');
});

test('LocalTraceStore: query by catId matches agent.id attribute', () => {
  const store = new LocalTraceStore({ maxSpans: 100 });
  store.add(makeDTO({ attributes: { 'agent.id': 'ragdoll' } }));
  store.add(makeDTO({ attributes: { 'agent.id': 'maine-coon' } }));
  store.add(makeDTO({ attributes: { 'agent.id': 'ragdoll' } }));

  const results = store.query({ catId: 'ragdoll' });
  assert.equal(results.length, 2);
});

test('LocalTraceStore: query respects limit', () => {
  const store = new LocalTraceStore({ maxSpans: 100 });
  for (let i = 0; i < 20; i++) {
    store.add(makeDTO({ spanId: `span-${i}` }));
  }

  const results = store.query({ limit: 5 });
  assert.equal(results.length, 5);
});

test('LocalTraceStore: maxSpans eviction drops oldest', () => {
  const now = Date.now();
  const store = new LocalTraceStore({ maxSpans: 3, maxAgeMs: 999_999_999 });
  store.add(makeDTO({ spanId: 'first', storedAt: now - 3000 }));
  store.add(makeDTO({ spanId: 'second', storedAt: now - 2000 }));
  store.add(makeDTO({ spanId: 'third', storedAt: now - 1000 }));
  // This should evict 'first'
  store.add(makeDTO({ spanId: 'fourth', storedAt: now }));

  const results = store.query({});
  assert.equal(results.length, 3);
  assert.equal(results[0].spanId, 'fourth');
  assert.equal(results[2].spanId, 'second');
});

test('LocalTraceStore: maxAgeMs eviction drops expired spans', async () => {
  const store = new LocalTraceStore({ maxSpans: 100, maxAgeMs: 50 });
  store.add(makeDTO({ spanId: 'old', storedAt: Date.now() - 100 }));
  store.add(makeDTO({ spanId: 'fresh', storedAt: Date.now() }));

  // The old span should be evicted on next query
  const results = store.query({});
  assert.equal(results.length, 1);
  assert.equal(results[0].spanId, 'fresh');
});

test('LocalTraceStore: stats returns correct info', () => {
  const store = new LocalTraceStore({ maxSpans: 500, maxAgeMs: 3600000 });
  const now = Date.now();
  store.add(makeDTO({ storedAt: now - 1000 }));
  store.add(makeDTO({ storedAt: now }));

  const stats = store.stats();
  assert.equal(stats.spanCount, 2);
  assert.equal(stats.maxSpans, 500);
  assert.equal(stats.maxAgeMs, 3600000);
  assert.equal(stats.oldestStoredAt, now - 1000);
  assert.equal(stats.newestStoredAt, now);
});

test('LocalTraceStore: stats on empty store', () => {
  const store = new LocalTraceStore();
  const stats = store.stats();
  assert.equal(stats.spanCount, 0);
  assert.equal(stats.oldestStoredAt, null);
  assert.equal(stats.newestStoredAt, null);
});

test('LocalTraceStore: clear removes all spans', () => {
  const store = new LocalTraceStore({ maxSpans: 100 });
  store.add(makeDTO());
  store.add(makeDTO());
  assert.equal(store.stats().spanCount, 2);

  store.clear();
  assert.equal(store.stats().spanCount, 0);
  assert.deepEqual(store.query({}), []);
});

test('LocalTraceStore: combined filter (traceId + catId)', () => {
  const store = new LocalTraceStore({ maxSpans: 100 });
  store.add(makeDTO({ traceId: 't1', attributes: { 'agent.id': 'ragdoll' } }));
  store.add(makeDTO({ traceId: 't1', attributes: { 'agent.id': 'maine-coon' } }));
  store.add(makeDTO({ traceId: 't2', attributes: { 'agent.id': 'ragdoll' } }));

  const results = store.query({ traceId: 't1', catId: 'ragdoll' });
  assert.equal(results.length, 1);
  assert.equal(results[0].traceId, 't1');
  assert.equal(results[0].attributes['agent.id'], 'ragdoll');
});

test('LocalTraceStore: default config uses 10k maxSpans and 2h maxAge', () => {
  const store = new LocalTraceStore();
  const stats = store.stats();
  assert.equal(stats.maxSpans, 10000);
  assert.equal(stats.maxAgeMs, 2 * 60 * 60 * 1000);
});
