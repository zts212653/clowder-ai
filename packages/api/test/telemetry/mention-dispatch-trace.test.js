/**
 * F172: Cross-cat trace propagation via mention_dispatch spans.
 *
 * Covers:
 * - Text-scan A2A path: mention_dispatch span created as child of mentioner's invocation
 * - invocationSpanRef: caller can capture invocation span reference
 * - Callback A2A path: NOT covered (InvocationQueue creates separate routeExecution — tracked as follow-up)
 */

if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── invocationSpanRef param exists on InvocationParams ─────────────

test('F172: InvocationParams declares invocationSpanRef field', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('invocationSpanRef') && src.includes('{ current?:'),
    'InvocationParams should declare invocationSpanRef with { current?: Span } shape',
  );
});

test('F172: invokeSingleCat writes span to invocationSpanRef', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('params.invocationSpanRef') && src.includes('.current = invocationSpan'),
    'Should write invocationSpan to spanRef.current after creation',
  );
});

// ── route-serial: mention_dispatch span creation ───────────────────

test('F172: route-serial creates cat_cafe.mention_dispatch span on A2A push', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(
    src.includes("'cat_cafe.mention_dispatch'") && src.includes('mention.targets'),
    'Should create mention_dispatch span with mention.targets attribute',
  );
});

test('F172: route-serial uses effectiveParentSpan (mention_dispatch or routeSpan) for invocation', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('effectiveParentSpan') && src.includes('mentionParentSpan.get(index)'),
    'Should resolve parent span from mentionParentSpan map or fall back to routeSpan',
  );
  assert.ok(
    src.includes('effectiveParentSpan ? { routeSpan: effectiveParentSpan }'),
    'Should pass effectiveParentSpan as routeSpan to invokeSingleCat',
  );
});

test('F172: route-serial tracks catInvocationSpans per worklist index', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('catInvocationSpans.set(index, spanRef.current)'),
    'Should store invocation span by worklist index after cat completes',
  );
});

// ── Dedup path: mentionParentSpan sync with a2aFrom ───────────────

test('F172: dedup path updates mentionParentSpan when a2aFrom changes', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('dedupIndex') && src.includes('mentionParentSpan.set(dedupIndex'),
    'Dedup path should update mentionParentSpan when a2aFrom is overwritten',
  );
});

// ── Dispatch span lifecycle ────────────────────────────────────────

test('F172: dispatch spans ended after last child completes', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  assert.ok(
    src.includes('pendingDispatchSpans') && src.includes('entry.lastChildIndex') && src.includes('entry.span.end()'),
    'Should end dispatch span when index reaches lastChildIndex',
  );
});

test('F172: finally block ends orphaned dispatch spans on early abort', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/routing/route-serial.ts'),
    'utf8',
  );
  const finallyIdx = src.indexOf('} finally {');
  const cleanupIdx = src.indexOf('index <= entry.lastChildIndex');
  assert.ok(
    finallyIdx > 0 && cleanupIdx > finallyIdx,
    'Finally block should end dispatch spans not yet completed (abort safety)',
  );
});

// ── Known gap: callback InvocationQueue path ──────────────────────

test('F172: QueueProcessor does NOT propagate trace context (known gap — follow-up)', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/domains/cats/services/agents/invocation/QueueProcessor.ts'),
    'utf8',
  );
  const hasTraceContext = src.includes('traceId') || src.includes('mention_dispatch') || src.includes('routeSpan');
  assert.ok(
    !hasTraceContext,
    'QueueProcessor does not yet carry trace context — callback A2A creates independent roots (documented gap)',
  );
});
