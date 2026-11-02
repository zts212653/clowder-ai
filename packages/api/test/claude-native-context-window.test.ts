import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { buildClaudeEnvOverrides } from '../src/domains/cats/services/agents/providers/ClaudeAgentService.js';
import { ClaudeInteractivePtyCarrierService } from '../src/domains/cats/services/agents/providers/ClaudeInteractivePtyCarrierService.js';
import { prepareClaudeSdkLaunch } from '../src/domains/cats/services/agents/providers/claude-sdk-launch.js';
import type { AgentServiceOptions } from '../src/domains/cats/services/types.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

const callbackEnv = {
  CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'api_key',
  CAT_CAFE_ANTHROPIC_API_KEY: 'fixture-not-a-real-key',
  CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE: 'glm-5.3-flash',
};

test('only valid native token counts and plain custom model IDs receive the window override', () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
    assert.equal(
      buildClaudeEnvOverrides(callbackEnv, {
        contextNativeWindowTokens: value,
      }).CLAUDE_CODE_MAX_CONTEXT_TOKENS,
      undefined,
      String(value),
    );
  }
  for (const model of [
    'claude-sonnet-4-6',
    'CLAUDE-SONNET-4-6',
    'sonnet',
    'opus',
    'anthropic/claude-opus-4-8',
    'glm-5[1m]',
  ]) {
    assert.equal(
      buildClaudeEnvOverrides(
        { ...callbackEnv, CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE: model },
        {
          contextNativeWindowTokens: 1_000_000,
        },
      ).CLAUDE_CODE_MAX_CONTEXT_TOKENS,
      undefined,
      model,
    );
  }
  assert.equal(
    buildClaudeEnvOverrides(callbackEnv, {
      contextNativeWindowTokens: 1_000_000,
    }).CLAUDE_CODE_MAX_CONTEXT_TOKENS,
    '1000000',
  );
  assert.equal(
    buildClaudeEnvOverrides(
      { ...callbackEnv, CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'subscription' },
      {
        contextNativeWindowTokens: 1_000_000,
      },
    ).CLAUDE_CODE_MAX_CONTEXT_TOKENS,
    undefined,
  );
});

test('SDK launch and resume carry native capacity without recycling the effective session window', async () => {
  for (const native of [1_000_000, null, undefined]) {
    const options: AgentServiceOptions = {
      callbackEnv,
      sessionId: '11111111-1111-4111-8111-111111111111',
      contextNativeWindowTokens: native,
      contextCapacity: {
        windowTokens: 258_400,
        inputCeilingTokens: 250_000,
        source: 'manual',
        provenance: 'effective session capacity fixture',
        actionable: true,
      },
    };
    const prepared = await prepareClaudeSdkLaunch({
      catId: createCatId('opus'),
      model: 'glm-5.3-flash',
      prompt: 'fixture',
      l0CompilerFn: fakeL0Compiler,
      abortController: new AbortController(),
      options,
    });
    assert.equal(prepared.sdkOptions.resume, options.sessionId);
    assert.equal(prepared.sdkOptions.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS, native ? '1000000' : undefined);
  }
  const prepared = await prepareClaudeSdkLaunch({
    catId: createCatId('opus'),
    model: 'glm-5.3-flash',
    prompt: 'fixture',
    l0CompilerFn: fakeL0Compiler,
    abortController: new AbortController(),
    options: {
      callbackEnv,
      contextNativeWindowTokens: 1_000_000,
      accountEnv: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '640000' },
    },
  });
  assert.equal(prepared.sdkOptions.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '640000');
});

test('interactive PTY forwards the native window to its driver environment', async () => {
  let captured: Record<string, string | null> | undefined;
  const service = new ClaudeInteractivePtyCarrierService({
    hookSidecarPathOverride: '/tmp/claude-window-fixture-no-events.jsonl',
    mcpServerPath: '/tmp/claude-window-fixture-no-mcp.js',
    driverFactory: (options) => {
      captured = options.env;
      throw new Error('fixture captured before any PTY was started');
    },
  });
  await assert.rejects(async () => {
    for await (const _ of service.invoke('fixture', { callbackEnv, contextNativeWindowTokens: 1_000_000 })) {
      // The factory is the final environment handoff before tmux starts.
    }
  }, /fixture captured/);
  assert.equal(captured?.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
});
