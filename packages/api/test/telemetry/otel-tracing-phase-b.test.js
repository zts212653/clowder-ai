/**
 * F153 Phase B: OTel wiring that the runtime tests cannot reach.
 *
 * otel-tracing-runtime.test.js and otel-tracing-llm-runtime.test.js assert the span
 * behaviour itself (cli_session parent, attributes, OK / ERROR on exit, the llm_call
 * and tool_use helpers), but they call spawnCli and the span helpers directly.
 * What they never exercise stays here as source-level checks:
 * - every CLI provider forwards parentSpan into cliOpts, and invoke-single-cat passes
 *   its invocationSpan down (the chain that links CLI spans to the invocation)
 * - invoke-single-cat calls recordLlmCallSpan / recordToolUseSpan, and records
 *   llm_call only when durationApiMs is present
 * - cli-spawn.ts marks a timeout as ERROR and emits the timeout / error OTel logs
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
    'agy-native/agy-native-launch.ts',
    'OpenCodeAgentService.ts',
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

  await t.test('invoke-single-cat delegates to recordLlmCallSpan', () => {
    assert.ok(invokeSrc.includes('recordLlmCallSpan'), 'Should call recordLlmCallSpan helper');
  });

  await t.test('only creates llm_call span when durationApiMs is available', () => {
    assert.ok(
      invokeSrc.includes('msg.metadata.usage.durationApiMs'),
      'Guard must check durationApiMs before calling recordLlmCallSpan',
    );
  });
});

test('F153 Phase B: tool_use spans via span-helpers.ts', async (t) => {
  const invokeSrc = readFileSync(INVOKE_SRC, 'utf8');

  await t.test('invoke-single-cat delegates to recordToolUseSpan', () => {
    assert.ok(invokeSrc.includes('recordToolUseSpan'), 'Should call recordToolUseSpan helper');
  });
});
