/**
 * F153 Phase F: Trace persistence via pointer association.
 *
 * Covers:
 * - AC-F1: invocationId on all span types
 * - AC-F2: extra.tracing pointer writing
 * - AC-F3: LocalTraceStore.hydrate() from message data
 * - AC-F6: pointer size ≤ 100 bytes
 * - AC-F7: safeParseExtra round-trip for tracing field
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── AC-F7: safeParseExtra round-trip for tracing field ─────────────

test('F153-F: safeParseExtra preserves tracing pointers (AC-F7)', async () => {
  const { safeParseExtra } = await import('../../dist/domains/cats/services/stores/redis/redis-message-parsers.js');

  const input = JSON.stringify({
    stream: { invocationId: 'inv-123' },
    tracing: {
      traceId: 'aaaa1111bbbb2222cccc3333dddd4444',
      spanId: '1122334455667788',
      parentSpanId: 'aabbccdd11223344',
    },
  });

  const parsed = safeParseExtra(input);
  assert.ok(parsed, 'Should parse successfully');
  assert.ok(parsed.tracing, 'Should preserve tracing field');
  assert.equal(parsed.tracing.traceId, 'aaaa1111bbbb2222cccc3333dddd4444');
  assert.equal(parsed.tracing.spanId, '1122334455667788');
  assert.equal(parsed.tracing.parentSpanId, 'aabbccdd11223344');
});

test('F153-F: safeParseExtra handles tracing without parentSpanId', async () => {
  const { safeParseExtra } = await import('../../dist/domains/cats/services/stores/redis/redis-message-parsers.js');

  const input = JSON.stringify({
    tracing: {
      traceId: 'aaaa1111bbbb2222cccc3333dddd4444',
      spanId: '1122334455667788',
    },
  });

  const parsed = safeParseExtra(input);
  assert.ok(parsed?.tracing);
  assert.equal(parsed.tracing.parentSpanId, undefined);
});

test('F153-F: safeParseExtra rejects invalid tracing shape', async () => {
  const { safeParseExtra } = await import('../../dist/domains/cats/services/stores/redis/redis-message-parsers.js');

  const input = JSON.stringify({
    tracing: { traceId: 123, spanId: null },
  });

  const parsed = safeParseExtra(input);
  assert.equal(parsed, undefined, 'Invalid tracing should not produce result');
});

// ── AC-F3: LocalTraceStore.hydrate() ────────────────────────────────

test('F153-F: LocalTraceStore.hydrate() loads DTOs into buffer (AC-F3)', async () => {
  const { LocalTraceStore } = await import('../../dist/infrastructure/telemetry/local-trace-store.js');

  const store = new LocalTraceStore({ maxSpans: 100 });
  const now = Date.now();

  const dtos = [
    makeDTO({ traceId: 'trace-1', spanId: 'span-1', storedAt: now - 2000 }),
    makeDTO({ traceId: 'trace-1', spanId: 'span-2', storedAt: now - 1000 }),
  ];

  store.hydrate(dtos);

  const results = store.query({});
  assert.equal(results.length, 2);
  assert.equal(results[0].spanId, 'span-2', 'Should return newest first');
});

test('F153-F: hydrate() respects maxSpans cap', async () => {
  const { LocalTraceStore } = await import('../../dist/infrastructure/telemetry/local-trace-store.js');

  const store = new LocalTraceStore({ maxSpans: 3 });
  const now = Date.now();

  const dtos = Array.from({ length: 5 }, (_, i) => makeDTO({ spanId: `span-${i}`, storedAt: now - (5 - i) * 1000 }));

  store.hydrate(dtos);

  const stats = store.stats();
  assert.equal(stats.spanCount, 3, 'Should not exceed maxSpans');
});

test('F153-F: hydrate() skips expired DTOs based on maxAgeMs', async () => {
  const { LocalTraceStore } = await import('../../dist/infrastructure/telemetry/local-trace-store.js');

  const store = new LocalTraceStore({ maxSpans: 100, maxAgeMs: 1000 });
  const now = Date.now();

  const dtos = [makeDTO({ spanId: 'old', storedAt: now - 5000 }), makeDTO({ spanId: 'fresh', storedAt: now })];

  store.hydrate(dtos);

  const results = store.query({});
  assert.equal(results.length, 1);
  assert.equal(results[0].spanId, 'fresh');
});

test('F153-F: hydrate() merges with existing buffer data', async () => {
  const { LocalTraceStore } = await import('../../dist/infrastructure/telemetry/local-trace-store.js');

  const store = new LocalTraceStore({ maxSpans: 100 });
  const now = Date.now();

  // Add a live span first
  store.add(makeDTO({ spanId: 'live', storedAt: now }));

  // Hydrate with historical spans
  store.hydrate([makeDTO({ spanId: 'historical', storedAt: now - 5000 })]);

  const results = store.query({});
  assert.equal(results.length, 2);
  assert.equal(results[0].spanId, 'live', 'Live span should be newest');
  assert.equal(results[1].spanId, 'historical');
});

// ── AC-F6: pointer size ≤ 100 bytes ────────────────────────────────

test('F153-F: tracing pointer serialized with compact keys ≤ 100 bytes (AC-F6)', async () => {
  const { serializeExtra } = await import('../../dist/domains/cats/services/stores/redis/redis-message-parsers.js');
  const extra = {
    tracing: {
      traceId: 'aaaa1111bbbb2222cccc3333dddd4444',
      spanId: '1122334455667788',
      parentSpanId: 'aabbccdd11223344',
    },
  };
  const serialized = serializeExtra(extra);
  const parsed = JSON.parse(serialized);
  // Compact keys: t, s, p
  assert.ok(parsed.tracing.t, 'Should use compact key t for traceId');
  assert.ok(parsed.tracing.s, 'Should use compact key s for spanId');
  assert.ok(parsed.tracing.p, 'Should use compact key p for parentSpanId');
  const tracingBytes = Buffer.byteLength(JSON.stringify(parsed.tracing), 'utf8');
  assert.ok(tracingBytes <= 100, `Compact pointer is ${tracingBytes} bytes, must be ≤ 100`);
});

// ── AC-F1: invocationId on all span types (source-level) ───────────

test('F153-F: invoke-single-cat sets invocationId on invocationSpan (AC-F1)', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('invocationId') && src.includes('invocationSpan'),
    'invocationSpan should carry invocationId attribute',
  );
});

// ── AC-F2: tracing pointer writing (source-level) ──────────────────

test('F153-F: invoke-single-cat writes extra.tracing to message (AC-F2)', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('extra') && src.includes('tracing') && src.includes('traceId'),
    'Should write tracing pointers to message extra',
  );
});

// ── AC-F2: tracing pointer in parallel routing ────────────────────

test('F153-F: route-parallel writes extra.tracing to messages (AC-F2)', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-parallel.ts'),
    'utf8',
  );
  const tracingMatches = src.match(/msg\.tracing/g) || [];
  assert.ok(
    tracingMatches.length >= 3,
    `Parallel routing should write tracing in all 3 append branches (found ${tracingMatches.length})`,
  );
});

// ── AC-F1: route span invocationId ────────────────────────────────

test('F153-F: routeExecution sets invocationId on route span (AC-F1)', () => {
  const src = readFileSync(resolve(__dirname, '../../src/domains/cats/services/agents/routing/AgentRouter.ts'), 'utf8');
  assert.ok(
    src.includes("'cat_cafe.route'") && src.includes('invocationId') && src.includes('parentInvocationId'),
    'Route span should carry invocationId from parentInvocationId',
  );
});

// ── AC-F2: parentSpanId in done messages ──────────────────────────

test('F153-F: done messages include parentSpanId from routeSpan (AC-F2)', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );
  const parentSidMatches = src.match(/parentSid.*routeSpan.*spanContext/g) || [];
  assert.ok(parentSidMatches.length >= 1, 'Should extract parentSpanId from routeSpan.spanContext()');
  const parentSpanIdInTracing = src.match(/parentSpanId.*parentSid/g) || [];
  assert.ok(
    parentSpanIdInTracing.length >= 2,
    `Should write parentSpanId in at least 2 done yield paths (found ${parentSpanIdInTracing.length})`,
  );
});

// ── KD-22: route tracing backfill to user message ─────────────────

test('F153-F: routeExecution backfills route tracing to user message in finally (KD-22)', () => {
  const src = readFileSync(resolve(__dirname, '../../src/domains/cats/services/agents/routing/AgentRouter.ts'), 'utf8');
  assert.ok(
    src.includes('updateExtra') && src.includes('userMessageId') && src.includes('routeSpan.spanContext'),
    'Should call updateExtra with route span tracing on user message',
  );
  const finallyIdx = src.indexOf('} finally {');
  const updateExtraIdx = src.indexOf('updateExtra(userMessageId');
  assert.ok(
    finallyIdx > 0 && updateExtraIdx > finallyIdx,
    'updateExtra must be inside finally block so error paths also persist the route root',
  );
});

// ── AC-F4: cold start auto-hydrate (source-level) ─────────────────

test('F153-F: hydrateTraceStoreFromRedis uses msg:timeline range query (AC-F4/F5)', () => {
  const src = readFileSync(resolve(__dirname, '../../src/infrastructure/telemetry/hydrate-traces.ts'), 'utf8');
  assert.ok(
    src.includes('zrevrangebyscore') && src.includes('MessageKeys.TIMELINE'),
    'Should query msg:timeline sorted set for recent messages',
  );
  assert.ok(
    src.includes('safeParseExtra') && src.includes('tracing'),
    'Should parse extra field and extract tracing pointers',
  );
  assert.ok(src.includes('traceStore.hydrate'), 'Should call traceStore.hydrate with synthesized DTOs');
});

test('F153-F: hydrate reads catId/metadata for enriched stubs (AC-F3/KD-23)', () => {
  const src = readFileSync(resolve(__dirname, '../../src/infrastructure/telemetry/hydrate-traces.ts'), 'utf8');
  assert.ok(src.includes("'catId'") && src.includes("'metadata'"), 'Should read catId and metadata from hash');
  assert.ok(src.includes('agent.id'), 'Should set agent.id attribute from catId');
  assert.ok(src.includes('durationMs'), 'Should compute duration from metadata');
  assert.ok(
    src.includes('ts - durationMs') || src.includes('ts -'),
    'Should derive startTime = timestamp - durationMs (KD-23)',
  );
});

test('F153-F: index.ts wires hydrate on cold start (AC-F4)', () => {
  const src = readFileSync(resolve(__dirname, '../../src/index.ts'), 'utf8');
  assert.ok(
    src.includes('hydrateTraceStoreFromRedis') && src.includes('telemetryHandle.traceStore'),
    'Should call hydrateTraceStoreFromRedis with traceStore at startup',
  );
});

// ── P1-1: updateExtra merge semantics (behavior-level) ──────────────

test('F153-F: updateExtra merges tracing into existing extra fields (P1-1)', async () => {
  const { serializeExtra, safeParseExtra } = await import(
    '../../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
  );

  const original = {
    rich: { v: 1, blocks: [{ kind: 'text', id: 'b1', data: { text: 'hello' } }] },
    targetCats: ['opus'],
    stream: { invocationId: 'inv-001' },
  };

  const tracingPatch = {
    tracing: {
      traceId: 'aaaa1111bbbb2222cccc3333dddd4444',
      spanId: '1122334455667788',
    },
  };

  const merged = { ...original, ...tracingPatch };
  const serialized = serializeExtra(merged);
  const parsed = safeParseExtra(serialized);

  assert.ok(parsed, 'Should parse merged extra');
  assert.ok(parsed.tracing, 'Should have tracing field');
  assert.equal(parsed.tracing.traceId, 'aaaa1111bbbb2222cccc3333dddd4444');
  assert.ok(parsed.rich, 'Should preserve existing rich field');
  assert.ok(parsed.stream, 'Should preserve existing stream field');
  assert.equal(parsed.stream.invocationId, 'inv-001', 'Should preserve stream.invocationId');
});

// ── P1-2: pointer-only hydrate scope (behavior-level) ────────────────

test('F153-F: hydrated DTOs are pointer-only restored stubs, not full hierarchy', async () => {
  const { LocalTraceStore } = await import('../../dist/infrastructure/telemetry/local-trace-store.js');

  const store = new LocalTraceStore({ maxSpans: 100 });
  const now = Date.now();

  const dtos = [
    makeDTO({
      traceId: 'trace-abc',
      spanId: 'span-1',
      name: 'cat_cafe.invocation.restored',
      attributes: { 'agent.id': 'opus', invocationId: 'inv-001' },
      storedAt: now,
    }),
    makeDTO({
      traceId: 'trace-abc',
      spanId: 'span-2',
      parentSpanId: 'span-1',
      name: 'cat_cafe.invocation.restored',
      attributes: { 'agent.id': 'sonnet' },
      storedAt: now - 1000,
    }),
  ];

  store.hydrate(dtos);
  const results = store.query({ traceId: 'trace-abc' });
  assert.equal(results.length, 2, 'Both stubs should be queryable');
  assert.ok(
    results.every((r) => r.name === 'cat_cafe.invocation.restored'),
    'All restored spans should be flat stubs (no route/cli_session/llm_call hierarchy)',
  );
});

// ── Helper ──────────────────────────────────────────────────────────

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
