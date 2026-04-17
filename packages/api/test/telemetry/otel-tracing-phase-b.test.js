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
const SPAN_HELPERS_SRC = resolve(__dirname, '../../src/infrastructure/telemetry/span-helpers.ts');

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

test('F153 Phase B: llm_call retrospective span via span-helpers.ts', async (t) => {
  const invokeSrc = readFileSync(INVOKE_SRC, 'utf8');
  const helperSrc = readFileSync(SPAN_HELPERS_SRC, 'utf8');

  await t.test('invoke-single-cat delegates to recordLlmCallSpan', () => {
    assert.ok(invokeSrc.includes('recordLlmCallSpan'), 'Should call recordLlmCallSpan helper');
  });

  await t.test('creates cat_cafe.llm_call span in helper', () => {
    assert.ok(helperSrc.includes("'cat_cafe.llm_call'"), 'Helper should create cat_cafe.llm_call span');
  });

  await t.test('uses retrospective startTime from durationApiMs', () => {
    assert.ok(
      helperSrc.includes('durationApiMs') && helperSrc.includes('startTime'),
      'Helper should compute span startTime from durationApiMs',
    );
  });

  await t.test('only creates llm_call span when durationApiMs is available', () => {
    assert.ok(
      invokeSrc.includes('msg.metadata.usage.durationApiMs'),
      'Guard must check durationApiMs before calling recordLlmCallSpan',
    );
  });

  await t.test('records token usage attributes on llm_call span', () => {
    assert.ok(helperSrc.includes("'gen_ai.usage.input_tokens'"), 'Should set input token count');
    assert.ok(helperSrc.includes("'gen_ai.usage.output_tokens'"), 'Should set output token count');
    assert.ok(helperSrc.includes("'gen_ai.usage.cache_read_tokens'"), 'Should set cache read token count');
  });
});

test('F153 Phase B: tool_use event via span-helpers.ts', async (t) => {
  const invokeSrc = readFileSync(INVOKE_SRC, 'utf8');
  const helperSrc = readFileSync(SPAN_HELPERS_SRC, 'utf8');

  await t.test('invoke-single-cat delegates to recordToolUseEvent', () => {
    assert.ok(invokeSrc.includes('recordToolUseEvent'), 'Should call recordToolUseEvent helper');
  });

  await t.test('records tool_use as span event, not a zero-duration span', () => {
    assert.ok(helperSrc.includes("addEvent('tool_use'"), 'Helper should use addEvent for tool_use');
    assert.ok(!helperSrc.includes("startSpan('cat_cafe.tool_use'"), 'Must NOT create a zero-duration tool_use span');
  });

  await t.test('sets tool.name attribute on event', () => {
    assert.ok(helperSrc.includes("'tool.name'"), 'Helper should set tool.name on event');
  });
});
