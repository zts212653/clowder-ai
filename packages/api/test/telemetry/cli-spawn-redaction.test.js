/**
 * F152: cli-spawn debug log redaction regression test.
 *
 * Ensures that Windows shim debug logging never leaks CLI args
 * (which may contain user prompts). Prevents future regression
 * of the fix applied in commit 4c8f7873.
 */

// Ensure NODE_ENV=test so HMAC salt fallback works in CI
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SPAWN_SRC = resolve(__dirname, '../../src/utils/cli-spawn.ts');

test('F152: cli-spawn Windows shim debug log must not contain args field', async (t) => {
  // Read the source file and find the Windows shim debug log line
  const source = readFileSync(CLI_SPAWN_SRC, 'utf8');

  await t.test('Windows shim resolved log uses argCount, not args', () => {
    // Find the log.debug call block that contains 'Windows shim resolved'.
    // The Pino call spans multiple lines, so we match the full block.
    const shimBlockRe = /log\.debug\(\s*\{[^}]*\}\s*,\s*'Windows shim resolved'/gs;
    const blocks = source.match(shimBlockRe);

    assert.ok(blocks && blocks.length > 0, 'Should find the Windows shim resolved log.debug block');

    for (const block of blocks) {
      assert.ok(
        !block.includes('args: shimSpawn.args') && !block.includes('args: args'),
        `Debug log must not contain raw args field. Found: ${block.trim()}`,
      );
      assert.ok(block.includes('argCount'), `Debug log should use argCount instead of args. Found: ${block.trim()}`);
    }
  });

  await t.test('No log.debug call in cli-spawn prints raw args array', () => {
    // Check that no debug log in the Windows spawn path prints full args
    const debugLogLines = source.split('\n').filter((line) => line.includes('log.debug(') && line.includes('args'));

    for (const line of debugLogLines) {
      // argCount is fine; args: <something>.args is not
      const hasRawArgs = /args:\s*(?:shimSpawn\.args|args\b)/.test(line) && !line.includes('argCount');
      assert.ok(!hasRawArgs, `Found debug log that may leak raw args: ${line.trim()}`);
    }
  });
});

test('F152: TelemetryRedactor classification', async () => {
  const { isClassA, isClassB, isClassC, redactValue } = await import('../../dist/infrastructure/telemetry/redactor.js');

  // Class A: credentials
  assert.ok(isClassA('authorization'));
  assert.ok(isClassA('callbackToken'));
  assert.ok(isClassA('CAT_CAFE_CALLBACK_TOKEN'));
  assert.equal(redactValue('authorization', 'Bearer xxx'), '[REDACTED]');

  // Class B: business content
  assert.ok(isClassB('prompt'));
  assert.ok(isClassB('message.content'));
  assert.ok(isClassB('toolInput'));
  const redacted = redactValue('prompt', 'Hello world');
  assert.ok(typeof redacted === 'string');
  assert.ok(redacted.startsWith('[hash:'));
  assert.ok(redacted.includes('len:11'));
  assert.ok(!redacted.includes('Hello world'));

  // Class C: system identifiers
  assert.ok(isClassC('threadId'));
  assert.ok(isClassC('invocationId'));
  assert.ok(isClassC('userId'));
  const hmaced = redactValue('threadId', 'thread_abc123');
  assert.ok(typeof hmaced === 'string');
  assert.ok(!String(hmaced).includes('thread_abc123'));

  // Class D: safe values — pass through
  assert.equal(redactValue('durationMs', 1234), 1234);
  assert.equal(redactValue('status', 'success'), 'success');
});

test('F152: model normalizer', async () => {
  const { normalizeModel } = await import('../../dist/infrastructure/telemetry/model-normalizer.js');

  assert.equal(normalizeModel('claude-opus-4-6'), 'claude-opus');
  assert.equal(normalizeModel('claude-sonnet-4-6'), 'claude-sonnet');
  assert.equal(normalizeModel('gpt-4o-2025-01-01'), 'gpt-4o');
  assert.equal(normalizeModel('gemini-2.5-pro'), 'gemini-2.5');
  assert.equal(normalizeModel('some-unknown-model'), 'other');
});

test('F152: emitOtelLog accepts span for trace-log correlation', async () => {
  // Verify that emitOtelLog signature accepts a Span parameter
  // and that LogRecord.context is used (not manual traceId/spanId attributes).
  const { emitOtelLog } = await import('../../dist/infrastructure/telemetry/otel-logger.js');

  // emitOtelLog must accept 4 params: severity, body, attributes, span
  assert.ok(emitOtelLog.length >= 2, 'emitOtelLog should accept at least severity + body params');

  // Source code check: ensure LogRecord uses context field, not manual traceId
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(__dir, '../../src/infrastructure/telemetry/otel-logger.ts'), 'utf8');

  // Must use trace.setSpan + context field on LogRecord
  assert.ok(src.includes('trace.setSpan('), 'Should derive context from span via trace.setSpan()');
  assert.ok(src.includes('context: logContext'), 'Should pass context to logger.emit() via LogRecord.context');
  // Must NOT have manual traceId/spanId in attributes
  assert.ok(!src.includes('traceId: spanContext'), 'Should not manually inject traceId into attributes');
  assert.ok(!src.includes('spanId: spanContext'), 'Should not manually inject spanId into attributes');
});

test('F152: metric attribute allowlist', async () => {
  const { ALLOWED_METRIC_ATTRIBUTES } = await import('../../dist/infrastructure/telemetry/metric-allowlist.js');

  // Allowed attributes
  assert.ok(ALLOWED_METRIC_ATTRIBUTES.has('agent.id'));
  assert.ok(ALLOWED_METRIC_ATTRIBUTES.has('gen_ai.system'));
  assert.ok(ALLOWED_METRIC_ATTRIBUTES.has('status'));

  // Forbidden attributes must NOT be in the allowlist
  assert.ok(!ALLOWED_METRIC_ATTRIBUTES.has('threadId'));
  assert.ok(!ALLOWED_METRIC_ATTRIBUTES.has('invocationId'));
  assert.ok(!ALLOWED_METRIC_ATTRIBUTES.has('sessionId'));
  assert.ok(!ALLOWED_METRIC_ATTRIBUTES.has('userId'));
  assert.ok(!ALLOWED_METRIC_ATTRIBUTES.has('path'));
  assert.ok(!ALLOWED_METRIC_ATTRIBUTES.has('command'));
});
