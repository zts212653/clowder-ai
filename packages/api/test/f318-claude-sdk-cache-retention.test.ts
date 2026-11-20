import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { applyStudyHostEnvironment } from '../../../docs/research/2026-11-18-f338-haiku-sdk/study-environment.mjs';
import { ClaudeSdkAgentService } from '../src/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import { freezeClaudeCacheRetentionMemory } from '../src/domains/cats/services/agents/providers/claude-cache-retention-replay.js';
import { prepareClaudeSdkLaunch } from '../src/domains/cats/services/agents/providers/claude-sdk-launch.js';
import type { AgentServiceOptions } from '../src/domains/cats/services/types.js';
import { claudeSdkRuntimeFixture } from './helpers/claude-sdk-runtime-fixture.js';

function retentionOptions(workingDirectory: string): AgentServiceOptions {
  return {
    invocationId: 'maintenance-invocation',
    sessionId: 'unchanged-native-parent',
    workingDirectory,
    callbackEnv: {
      CAT_CAFE_INVOCATION_ID: 'maintenance-invocation',
      CAT_CAFE_CALLBACK_TOKEN: randomUUID(),
    },
    toolExecutionPolicy: { mode: 'callback_allowlist', allowedCallbackRoutes: [] },
    cacheRetentionReplay: {
      sourceInvocationId: 'source-invocation',
      nativeSystemPrompt: 'FROZEN PARENT L0',
      appendSystemPrompt: 'FROZEN PARENT APPEND',
    },
  };
}

test('F338: maintenance never imposes a small output cap that can retrigger adaptive thinking', () => {
  for (const previous of [undefined, '8192']) {
    const env: Record<string, string | null> = previous ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: previous } : {};
    freezeClaudeCacheRetentionMemory(env);
    assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, previous);
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
    assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  }
});

for (const stage of ['source', 'maintenance'] as const)
  test(`F338: private study Host removes inherited output caps before the real SDK ${stage} launch`, async (t) => {
    const previous = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    t.after(() => {
      if (previous === undefined) delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
      else process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = previous;
    });
    const environment = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256' };
    applyStudyHostEnvironment(environment, {});
    if (environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS === undefined) delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    else process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    const prepared = await prepareClaudeSdkLaunch({
      runtime: claudeSdkRuntimeFixture(),
      catId: createCatId('opus'),
      model: 'claude-haiku-5-5',
      prompt: 'Reply OK.',
      l0CompilerFn: async () => 'SOURCE L0',
      abortController: new AbortController(),
      options:
        stage === 'maintenance'
          ? retentionOptions(tmpdir())
          : { workingDirectory: tmpdir(), cliConfigArgs: ['--max-turns', '1', '--max-budget-usd', '2'] },
    });
    assert.equal(prepared.sdkOptions.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
    if (stage === 'maintenance') {
      assert.equal(prepared.sdkOptions.maxBudgetUsd, 2);
      assert.equal(prepared.sdkOptions.maxTurns, 1);
    } else {
      assert.equal(prepared.sdkOptions.extraArgs?.['max-budget-usd'], '2');
      assert.equal(prepared.sdkOptions.extraArgs?.['max-turns'], '1');
    }
  });

// Observe the options handed to the installed SDK without a model or server call.
test('F338: SDK maintenance forks the frozen parent without fresh instructions or tool execution', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'f338-sdk-retention-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let compiled = 0;
  const prepared = await prepareClaudeSdkLaunch({
    runtime: claudeSdkRuntimeFixture(),
    catId: createCatId('opus'),
    model: 'claude-haiku-5-5',
    prompt: 'Reply OK.',
    l0CompilerFn: async () => {
      compiled++;
      return 'MUTABLE CURRENT L0';
    },
    abortController: new AbortController(),
    options: retentionOptions(root),
  });

  assert.equal(compiled, 0, 'maintenance must reuse the successful parent prefix');
  assert.equal(prepared.sdkOptions.resume, 'unchanged-native-parent');
  assert.equal(prepared.sdkOptions.forkSession, true, 'the main session must remain unchanged');
  assert.deepEqual(prepared.sdkOptions.systemPrompt, {
    type: 'custom',
    prompt: 'FROZEN PARENT L0\n\nFROZEN PARENT APPEND',
    snapshot: false,
  });
  assert.equal(prepared.sdkOptions.maxTurns, 1);
  assert.equal(prepared.sdkOptions.maxBudgetUsd, 2);
  assert.equal(prepared.sdkOptions.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
  assert.equal(prepared.sdkOptions.env?.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  const settings = JSON.parse(prepared.sdkOptions.settings as string);
  assert.ok(settings.hooks.PreToolUse.some((group: { matcher: string }) => group.matcher === '*'));
  assert.equal(prepared.sdkOptions.tools, undefined, 'keep native schemas while denying execution');
});

for (const invalid of ['source-credential', 'callback-grant'] as const)
  test(`F338: SDK maintenance rejects ${invalid} before compiling or launching`, async () => {
    const options = retentionOptions(tmpdir());
    if (invalid === 'source-credential') options.invocationId = 'source-invocation';
    else
      options.toolExecutionPolicy = {
        mode: 'callback_allowlist',
        allowedCallbackRoutes: ['POST /api/callbacks/post-message'],
      };
    let compiled = false;
    await assert.rejects(
      prepareClaudeSdkLaunch({
        runtime: claudeSdkRuntimeFixture(),
        catId: createCatId('opus'),
        model: 'claude-haiku-5-5',
        prompt: 'Reply OK.',
        l0CompilerFn: async () => {
          compiled = true;
          return 'CURRENT';
        },
        abortController: new AbortController(),
        options,
      }),
      /cache_retention_independent_denied_principal_required/,
    );
    assert.equal(compiled, false);
  });

test('F338: SDK rechecks maintenance after preparation and never constructs an expired query', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'f338-sdk-dispatch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = retentionOptions(root);
  const replay = options.cacheRetentionReplay;
  assert.ok(replay);
  let checks = 0,
    queries = 0;
  options.cacheRetentionReplay = {
    ...replay,
    assertSendCurrent: async () => {
      checks++;
      throw new Error('cache_retention_expired_at_send');
    },
  };
  const service = new ClaudeSdkAgentService({
    catId: createCatId('opus'),
    model: 'claude-haiku-5-5',
    mcpServerPath: '',
    runtimeResolver: claudeSdkRuntimeFixture,
    queryFn: () => {
      queries++;
      throw new Error('must not query');
    },
  });
  for await (const _event of service.invoke('Reply OK.', options)) {
    /* drain owned teardown */
  }
  assert.equal(queries, 0, 'the actual SDK query must not be constructed after expiry');
  assert.equal(checks, 1);
});
