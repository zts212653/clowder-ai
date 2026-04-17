/**
 * F153: TELEMETRY_DEBUG feature tests (#456).
 *
 * Verifies:
 * 1. Structural plumbing: ConsoleSpanExporter wired in init.ts
 * 2. Env registry: TELEMETRY_DEBUG registered
 * 3. Runtime: debug exporter ordering vs redactor (P2 fix)
 * 4. Runtime: production guardrail blocks config-param bypass (P2 fix)
 */

// Ensure HMAC fallback salt is available (CI test:public may not set NODE_ENV)
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { ExportResultCode } = await import('@opentelemetry/core');
const { NodeTracerProvider, SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-node');
const { RedactingSpanProcessor } = await import('../../dist/infrastructure/telemetry/redactor.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const INIT_SRC = resolve(__dirname, '../../src/infrastructure/telemetry/init.ts');
const ENV_REGISTRY_SRC = resolve(__dirname, '../../src/config/env-registry.ts');

/**
 * Exporter that snapshots span attributes at export() time.
 * Unlike InMemorySpanExporter (which stores refs and sees later mutations),
 * this captures a frozen copy — the only way to prove ordering correctness.
 */
class SnapshotExporter {
  spans = [];
  export(spans, cb) {
    for (const s of spans) {
      this.spans.push({ name: s.name, attributes: { ...s.attributes } });
    }
    cb({ code: ExportResultCode.SUCCESS });
  }
  shutdown() {
    return Promise.resolve();
  }
  forceFlush() {
    return Promise.resolve();
  }
  reset() {
    this.spans = [];
  }
}

// ── Structural: init.ts plumbing ───────────────────────────────────

test('F153 TELEMETRY_DEBUG: init.ts imports ConsoleSpanExporter', () => {
  const src = readFileSync(INIT_SRC, 'utf8');
  assert.ok(src.includes('ConsoleSpanExporter'), 'Should import ConsoleSpanExporter');
  assert.ok(src.includes('SimpleSpanProcessor'), 'Should import SimpleSpanProcessor for debug path');
});

test('F153 TELEMETRY_DEBUG: init.ts wires ConsoleSpanExporter on debugMode', () => {
  const src = readFileSync(INIT_SRC, 'utf8');
  assert.ok(src.includes('cfg.debugMode') || src.includes('config.debugMode'), 'Should check debugMode config flag');
  assert.ok(
    src.includes('new SimpleSpanProcessor(new ConsoleSpanExporter())'),
    'Should create SimpleSpanProcessor wrapping ConsoleSpanExporter',
  );
});

test('F153 TELEMETRY_DEBUG: init.ts uses spanProcessors array (not single)', () => {
  const src = readFileSync(INIT_SRC, 'utf8');
  assert.ok(
    src.includes('spanProcessors:') && !src.includes('spanProcessor ?'),
    'Should use spanProcessors array pattern, not ternary single processor',
  );
});

test('F153 TELEMETRY_DEBUG: init.ts emits warning when debug enabled', () => {
  const src = readFileSync(INIT_SRC, 'utf8');
  assert.ok(src.includes('UNREDACTED') && src.includes('log.warn'), 'Should warn about unredacted export');
});

// ── Structural: debug exporter ordering ────────────────────────────

test('F153 TELEMETRY_DEBUG: debug exporter appears BEFORE redactor in source', () => {
  const src = readFileSync(INIT_SRC, 'utf8');
  const debugIdx = src.indexOf('new SimpleSpanProcessor(new ConsoleSpanExporter())');
  const redactIdx = src.indexOf('new RedactingSpanProcessor(');
  assert.ok(debugIdx > 0, 'Should have debug exporter');
  assert.ok(redactIdx > 0, 'Should have redacting processor');
  assert.ok(debugIdx < redactIdx, 'Debug exporter must come BEFORE RedactingSpanProcessor');
});

test('F153 TELEMETRY_DEBUG: production guardrail enforced after config merge', () => {
  const src = readFileSync(INIT_SRC, 'utf8');
  const mergeIdx = src.indexOf('...DEFAULT_CONFIG, ...config');
  const guardrailIdx = src.indexOf('debugMode blocked in production');
  assert.ok(mergeIdx > 0, 'Should merge config');
  assert.ok(guardrailIdx > 0, 'Should have post-merge guardrail');
  assert.ok(guardrailIdx > mergeIdx, 'Guardrail must come AFTER config merge to catch param bypass');
});

// ── Env registry ───────────────────────────────────────────────────

test('F153 TELEMETRY_DEBUG: registered in env-registry.ts', () => {
  const src = readFileSync(ENV_REGISTRY_SRC, 'utf8');
  assert.ok(src.includes("name: 'TELEMETRY_DEBUG'"), 'TELEMETRY_DEBUG should be in env registry');
  assert.ok(src.includes("name: 'TELEMETRY_DEBUG_FORCE'"), 'TELEMETRY_DEBUG_FORCE should be in env registry');
});

// ── Runtime: debug exporter sees unredacted spans when both modes active ──

test('F153 runtime: debug exporter snapshot captures UNREDACTED attrs before redactor mutates', async () => {
  const debugSnapshot = new SnapshotExporter();
  const redactedSnapshot = new SnapshotExporter();

  // Mirror init.ts pipeline: debug FIRST, redactor SECOND
  const provider = new NodeTracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor(debugSnapshot),
      new RedactingSpanProcessor(new SimpleSpanProcessor(redactedSnapshot)),
    ],
  });

  const tracer = provider.getTracer('debug-ordering-test');
  const span = tracer.startSpan('test.span', {
    attributes: {
      authorization: 'Bearer sk-secret-key',
      prompt: 'Hello, this is a secret prompt',
      invocationId: 'inv-12345',
      'cli.command': 'claude',
    },
  });
  span.end();

  // Debug exporter (first): should see original values
  assert.equal(debugSnapshot.spans.length, 1, 'Debug exporter should capture 1 span');
  const debugAttrs = debugSnapshot.spans[0].attributes;
  assert.equal(debugAttrs.authorization, 'Bearer sk-secret-key', 'Debug: Class A should be UNREDACTED');
  assert.equal(debugAttrs.prompt, 'Hello, this is a secret prompt', 'Debug: Class B should be UNREDACTED');
  assert.equal(debugAttrs.invocationId, 'inv-12345', 'Debug: Class C should be UNREDACTED');
  assert.equal(debugAttrs['cli.command'], 'claude', 'Debug: Class D should pass through');

  // Redacted exporter (second): should see redacted values
  assert.equal(redactedSnapshot.spans.length, 1, 'Redacted exporter should capture 1 span');
  const redactedAttrs = redactedSnapshot.spans[0].attributes;
  assert.equal(redactedAttrs.authorization, '[REDACTED]', 'Redacted: Class A should be [REDACTED]');
  assert.match(String(redactedAttrs.prompt), /^\[hash:[0-9a-f]{16} len:\d+\]$/, 'Redacted: Class B should be hashed');
  assert.notEqual(redactedAttrs.invocationId, 'inv-12345', 'Redacted: Class C should be pseudonymized');

  await provider.shutdown();
});

test('F153 runtime: debug-only mode (no OTLP) sees unredacted attrs', async () => {
  const debugSnapshot = new SnapshotExporter();

  // Debug only, no redactor — simplest case
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(debugSnapshot)],
  });

  const tracer = provider.getTracer('debug-only-test');
  const span = tracer.startSpan('test.span', {
    attributes: { authorization: 'Bearer sk-xyz', prompt: 'secret stuff' },
  });
  span.end();

  const attrs = debugSnapshot.spans[0].attributes;
  assert.equal(attrs.authorization, 'Bearer sk-xyz', 'Debug-only: should see raw auth');
  assert.equal(attrs.prompt, 'secret stuff', 'Debug-only: should see raw prompt');

  await provider.shutdown();
});

test('F153 TELEMETRY_DEBUG: debug field included in SDK init log', () => {
  const src = readFileSync(INIT_SRC, 'utf8');
  assert.ok(src.includes('debug: cfg.debugMode'), 'OTel SDK init log should include debug mode status');
});
