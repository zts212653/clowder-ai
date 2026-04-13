/**
 * F153 Phase B: OTel end-to-end tracing structural tests.
 *
 * Verifies that span creation logic is correctly wired in:
 * - cli-spawn.ts (cat_cafe.cli_session child span)
 * - invoke-single-cat.ts (cat_cafe.llm_call + cat_cafe.tool_use spans)
 * - types.ts / ClaudeAgentService.ts (parentSpan threading)
 *
 * Uses source-level inspection (same pattern as cli-spawn-redaction.test.js)
 * since these tests don't require a compiled dist/ build.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_SPAWN_SRC = resolve(__dirname, '../../src/utils/cli-spawn.ts');
const CLI_TYPES_SRC = resolve(__dirname, '../../src/utils/cli-types.ts');
const TYPES_SRC = resolve(__dirname, '../../src/domains/cats/services/types.ts');
const CLAUDE_SERVICE_SRC = resolve(__dirname, '../../src/domains/cats/services/agents/providers/ClaudeAgentService.ts');
const INVOKE_SRC = resolve(__dirname, '../../src/domains/cats/services/agents/invocation/invoke-single-cat.ts');

test('F153 Phase B: cli_session span creation in cli-spawn.ts', async (t) => {
  const src = readFileSync(CLI_SPAWN_SRC, 'utf8');

  await t.test('creates cat_cafe.cli_session span when parentSpan is provided', () => {
    assert.ok(
      src.includes("startSpan('cat_cafe.cli_session'") || src.includes('startSpan(\n'),
      'Should create cat_cafe.cli_session span',
    );
    assert.ok(src.includes('options.parentSpan'), 'Should check for parentSpan option');
    assert.ok(
      src.includes('trace.setSpan(context.active(), options.parentSpan)'),
      'Should derive parent context from parentSpan',
    );
  });

  await t.test('sets span attributes for CLI process metadata', () => {
    assert.ok(src.includes("'cli.command'"), 'Should set cli.command attribute');
    assert.ok(src.includes("'cli.arg_count'"), 'Should set cli.arg_count attribute');
    assert.ok(src.includes("'cli.pid'"), 'Should set cli.pid attribute');
  });

  await t.test('uses redactor-safe keys for system identifiers', () => {
    // Must use camelCase keys that TelemetryRedactor CLASS_C handles,
    // not dotted snake_case which would bypass redaction.
    assert.ok(
      !src.includes("'cat_cafe.invocation_id'"),
      'Must not use dotted cat_cafe.invocation_id — bypasses redactor',
    );
    assert.ok(
      !src.includes("'cat_cafe.cli_session_id'"),
      'Must not use dotted cat_cafe.cli_session_id — bypasses redactor',
    );
    assert.ok(src.includes('invocationId: options.invocationId'), 'Should use camelCase invocationId');
    assert.ok(src.includes('sessionId: options.cliSessionId'), 'Should use camelCase sessionId');
  });

  await t.test('sets ERROR status on timeout', () => {
    assert.ok(
      src.includes('timedOut') && src.includes('SpanStatusCode.ERROR'),
      'Should set ERROR status when CLI times out',
    );
    assert.ok(src.includes('cli_session_timeout'), 'Should emit OTel log on timeout');
  });

  await t.test('sets ERROR status on non-zero exit', () => {
    assert.ok(src.includes('cli_session_error'), 'Should emit OTel log on CLI error exit');
  });

  await t.test('sets OK status on clean exit', () => {
    assert.ok(src.includes('SpanStatusCode.OK'), 'Should set OK status on clean exit');
  });

  await t.test('ends span in finally block', () => {
    assert.ok(src.includes('cliSpan.end()'), 'Should call cliSpan.end() in finally block');
  });
});

test('F153 Phase B: parentSpan threading through call chain', async (t) => {
  await t.test('CliSpawnOptions has parentSpan field', () => {
    const src = readFileSync(CLI_TYPES_SRC, 'utf8');
    assert.ok(src.includes('parentSpan?: Span'), 'CliSpawnOptions should have parentSpan field');
    assert.ok(src.includes("from '@opentelemetry/api'"), 'Should import Span from OTel');
  });

  await t.test('AgentServiceOptions has parentSpan field', () => {
    const src = readFileSync(TYPES_SRC, 'utf8');
    assert.ok(src.includes('parentSpan?: Span'), 'AgentServiceOptions should have parentSpan field');
  });

  await t.test('ClaudeAgentService forwards parentSpan to cliOpts', () => {
    const src = readFileSync(CLAUDE_SERVICE_SRC, 'utf8');
    assert.ok(
      src.includes('parentSpan') && src.includes('cliOpts'),
      'ClaudeAgentService should forward parentSpan in cliOpts',
    );
  });

  const PROVIDERS_DIR = resolve(__dirname, '../../src/domains/cats/services/agents/providers');
  const CLI_PROVIDERS = [
    'ClaudeAgentService.ts',
    'CodexAgentService.ts',
    'GeminiAgentService.ts',
    'OpenCodeAgentService.ts',
    'DareAgentService.ts',
    'KimiAgentService.ts',
  ];

  for (const file of CLI_PROVIDERS) {
    await t.test(`${file} forwards parentSpan to cliOpts`, () => {
      const src = readFileSync(resolve(PROVIDERS_DIR, file), 'utf8');
      assert.ok(src.includes('parentSpan'), `${file} must forward parentSpan in cliOpts`);
    });
  }

  await t.test('invoke-single-cat passes invocationSpan as parentSpan', () => {
    const src = readFileSync(INVOKE_SRC, 'utf8');
    assert.ok(src.includes('parentSpan: invocationSpan'), 'Should pass invocationSpan as parentSpan in baseOptions');
  });
});

test('F153 Phase B: llm_call retrospective span in invoke-single-cat.ts', async (t) => {
  const src = readFileSync(INVOKE_SRC, 'utf8');

  await t.test('creates cat_cafe.llm_call span from done event', () => {
    assert.ok(src.includes("'cat_cafe.llm_call'"), 'Should create cat_cafe.llm_call span');
  });

  await t.test('uses retrospective startTime from durationApiMs', () => {
    assert.ok(
      src.includes('durationApiMs') && src.includes('startTime'),
      'Should compute span startTime from durationApiMs',
    );
  });

  await t.test('only creates llm_call span when durationApiMs is available', () => {
    // The guard must check msg.metadata.usage.durationApiMs is truthy,
    // not fall back to 0 — providers without timing would produce misleading spans.
    assert.ok(
      src.includes('msg.metadata.usage.durationApiMs'),
      'Guard must check durationApiMs before creating llm_call span',
    );
    assert.ok(
      !src.includes('durationApiMs ?? 0'),
      'Must NOT fallback durationApiMs to 0 — would produce fake 0-duration spans',
    );
  });

  await t.test('records token usage attributes on llm_call span', () => {
    assert.ok(src.includes("'gen_ai.usage.input_tokens'"), 'Should set input token count');
    assert.ok(src.includes("'gen_ai.usage.output_tokens'"), 'Should set output token count');
    assert.ok(src.includes("'gen_ai.usage.cache_read_tokens'"), 'Should set cache read token count');
  });

  await t.test('llm_call span is child of invocationSpan', () => {
    // The span is created using invocationSpan as parent context
    assert.ok(
      src.includes('trace.setSpan(context.active(), invocationSpan)'),
      'Should derive parent context from invocationSpan',
    );
  });
});

test('F153 Phase B: tool_use event in invoke-single-cat.ts', async (t) => {
  const src = readFileSync(INVOKE_SRC, 'utf8');

  await t.test('records tool_use as span event, not a zero-duration span', () => {
    // OTel best practice: point-in-time markers use addEvent, not startSpan→end.
    assert.ok(src.includes("addEvent('tool_use'"), 'Should use invocationSpan.addEvent for tool_use');
    assert.ok(!src.includes("startSpan('cat_cafe.tool_use'"), 'Must NOT create a zero-duration tool_use span');
  });

  await t.test('sets tool.name attribute on event', () => {
    assert.ok(src.includes("'tool.name': msg.toolName"), 'Should set tool.name on event');
  });
});
