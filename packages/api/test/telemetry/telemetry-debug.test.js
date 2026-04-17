/**
 * F153: TELEMETRY_DEBUG feature tests (#456).
 *
 * Verifies:
 * 1. Runtime: shouldEnableDebugMode() guardrail under all env combinations
 * 2. Runtime: debug exporter ordering vs redactor (unredacted before mutation)
 * 3. Structural: init.ts plumbing + env registry
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
const { shouldEnableDebugMode } = await import('../../dist/infrastructure/telemetry/init.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const INIT_SRC = resolve(__dirname, '../../src/infrastructure/telemetry/init.ts');
const ENV_REGISTRY_SRC = resolve(__dirname, '../../src/config/env-registry.ts');

/** Exporter that snapshots span attributes at export() time (not refs). */
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
}

// Helper: run callback with env vars, then restore
function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
  }
  try {
    for (const [key, val] of Object.entries(overrides)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    return fn();
  } finally {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
}

// ── Runtime: shouldEnableDebugMode() guardrail ─────────────────────

test('shouldEnableDebugMode: returns false when not requested', () => {
  withEnv({ NODE_ENV: 'test' }, () => {
    assert.equal(shouldEnableDebugMode(false), false);
  });
});

test('shouldEnableDebugMode: allowed in NODE_ENV=test', () => {
  withEnv({ NODE_ENV: 'test', TELEMETRY_DEBUG_FORCE: undefined }, () => {
    assert.equal(shouldEnableDebugMode(true), true);
  });
});

test('shouldEnableDebugMode: allowed in NODE_ENV=development', () => {
  withEnv({ NODE_ENV: 'development', TELEMETRY_DEBUG_FORCE: undefined }, () => {
    assert.equal(shouldEnableDebugMode(true), true);
  });
});

test('shouldEnableDebugMode: blocked in NODE_ENV=production', () => {
  withEnv({ NODE_ENV: 'production', TELEMETRY_DEBUG_FORCE: undefined }, () => {
    assert.equal(shouldEnableDebugMode(true), false);
  });
});

test('shouldEnableDebugMode: blocked when NODE_ENV unset (profile-driven startup)', () => {
  withEnv({ NODE_ENV: undefined, TELEMETRY_DEBUG_FORCE: undefined }, () => {
    assert.equal(shouldEnableDebugMode(true), false, 'Unset NODE_ENV must be treated as production-like');
  });
});

test('shouldEnableDebugMode: FORCE overrides in production', () => {
  withEnv({ NODE_ENV: 'production', TELEMETRY_DEBUG_FORCE: 'true' }, () => {
    assert.equal(shouldEnableDebugMode(true), true);
  });
});

test('shouldEnableDebugMode: FORCE overrides when NODE_ENV unset', () => {
  withEnv({ NODE_ENV: undefined, TELEMETRY_DEBUG_FORCE: 'true' }, () => {
    assert.equal(shouldEnableDebugMode(true), true);
  });
});

// ── Structural: init.ts plumbing ───────────────────────────────────

test('F153 TELEMETRY_DEBUG: debug exporter appears BEFORE redactor in source', () => {
  const src = readFileSync(INIT_SRC, 'utf8');
  const debugIdx = src.indexOf('new SimpleSpanProcessor(new ConsoleSpanExporter())');
  const redactIdx = src.indexOf('new RedactingSpanProcessor(');
  assert.ok(debugIdx > 0, 'Should have debug exporter');
  assert.ok(redactIdx > 0, 'Should have redacting processor');
  assert.ok(debugIdx < redactIdx, 'Debug exporter must come BEFORE RedactingSpanProcessor');
});

test('F153 TELEMETRY_DEBUG: guardrail call-site is after config merge', () => {
  const src = readFileSync(INIT_SRC, 'utf8');
  const mergeIdx = src.indexOf('...DEFAULT_CONFIG, ...config');
  // Match the call site (cfg.debugMode = shouldEnableDebugMode(...)), not the declaration
  const callIdx = src.indexOf('= shouldEnableDebugMode(cfg.');
  assert.ok(mergeIdx > 0, 'Should merge config');
  assert.ok(callIdx > 0, 'Should call shouldEnableDebugMode on merged cfg');
  assert.ok(callIdx > mergeIdx, 'shouldEnableDebugMode call must be AFTER config merge');
});

// ── Env registry ───────────────────────────────────────────────────

test('F153 TELEMETRY_DEBUG: both vars registered and locked in env-registry', () => {
  const src = readFileSync(ENV_REGISTRY_SRC, 'utf8');
  assert.ok(src.includes("name: 'TELEMETRY_DEBUG'"), 'TELEMETRY_DEBUG in registry');
  assert.ok(src.includes("name: 'TELEMETRY_DEBUG_FORCE'"), 'TELEMETRY_DEBUG_FORCE in registry');

  // Verify both are locked from Hub UI
  for (const varName of ['TELEMETRY_DEBUG', 'TELEMETRY_DEBUG_FORCE']) {
    const idx = src.indexOf(`name: '${varName}'`);
    const block = src.slice(idx, src.indexOf('},', idx) + 2);
    assert.ok(block.includes('hubVisible: false'), `${varName} must be hubVisible: false`);
    assert.ok(block.includes('runtimeEditable: false'), `${varName} must be runtimeEditable: false`);
  }
});

// ── Runtime: debug exporter ordering vs redactor ───────────────────

test('F153 runtime: debug snapshot captures UNREDACTED attrs before redactor mutates', async () => {
  const debugSnapshot = new SnapshotExporter();
  const redactedSnapshot = new SnapshotExporter();

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

  const debugAttrs = debugSnapshot.spans[0].attributes;
  assert.equal(debugAttrs.authorization, 'Bearer sk-secret-key', 'Debug: Class A UNREDACTED');
  assert.equal(debugAttrs.prompt, 'Hello, this is a secret prompt', 'Debug: Class B UNREDACTED');
  assert.equal(debugAttrs.invocationId, 'inv-12345', 'Debug: Class C UNREDACTED');

  const redactedAttrs = redactedSnapshot.spans[0].attributes;
  assert.equal(redactedAttrs.authorization, '[REDACTED]', 'Redacted: Class A [REDACTED]');
  assert.match(String(redactedAttrs.prompt), /^\[hash:[0-9a-f]{16} len:\d+\]$/, 'Redacted: Class B hashed');
  assert.notEqual(redactedAttrs.invocationId, 'inv-12345', 'Redacted: Class C pseudonymized');

  await provider.shutdown();
});

test('F153 runtime: debug-only mode (no OTLP) sees unredacted attrs', async () => {
  const debugSnapshot = new SnapshotExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(debugSnapshot)],
  });

  const tracer = provider.getTracer('debug-only-test');
  const span = tracer.startSpan('test.span', {
    attributes: { authorization: 'Bearer sk-xyz', prompt: 'secret stuff' },
  });
  span.end();

  const attrs = debugSnapshot.spans[0].attributes;
  assert.equal(attrs.authorization, 'Bearer sk-xyz', 'Debug-only: raw auth');
  assert.equal(attrs.prompt, 'secret stuff', 'Debug-only: raw prompt');

  await provider.shutdown();
});
