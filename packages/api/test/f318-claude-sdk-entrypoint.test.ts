import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Options, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { createCatId } from '@cat-cafe/shared';
import { prepareClaudeSdkLaunch } from '../src/domains/cats/services/agents/providers/claude-sdk-launch.js';

const settingKey = 'CAT_CAFE_CLAUDE_SDK_ENTRYPOINT';

async function captureSdkSpawn(options: Options): Promise<SpawnOptions> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const intercepted = new Error('offline SDK spawn intercepted');
  let captured: SpawnOptions | undefined;
  // Intercept the real SDK before it can start Claude or make a model request.
  await assert.rejects(
    async () => {
      const session = query({
        prompt: 'offline fixture',
        options: {
          ...options,
          spawnClaudeCodeProcess: (spawnOptions) => {
            captured = spawnOptions;
            throw intercepted;
          },
        },
      });
      try {
        await session.next();
      } finally {
        session.close();
      }
    },
    (error) => error === intercepted,
  );
  assert.ok(captured, 'the installed SDK reached its process launch boundary');
  return captured;
}

for (const [setting, expected] of [
  [undefined, 'sdk-ts'],
  ['cat-cafe', 'cat-cafe'],
  ['sdk-ts', 'sdk-ts'],
] as const) {
  test(`SDK entrypoint ${setting ?? 'unset'} preserves model, resume, identity and credential isolation at spawn`, async (t) => {
    const saved = [settingKey, 'CLAUDE_CODE_ENTRYPOINT'].map((key) => [key, process.env[key]] as const);
    if (setting === undefined) delete process.env[settingKey];
    else process.env[settingKey] = setting;
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    t.after(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const controller = new AbortController();
    t.after(() => controller.abort());
    const prepared = await prepareClaudeSdkLaunch({
      runtime: claudeSdkRuntimeFixture(),
      catId: createCatId('opus'),
      model: 'claude-opus-4-6',
      prompt: 'normal task',
      l0CompilerFn: async () => 'native identity',
      abortController: controller,
      options: {
        sessionId: '11111111-1111-4111-8111-111111111111',
        callbackEnv: { CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'subscription' },
        accountEnv: {
          ANTHROPIC_API_KEY: 'must-not-leak',
          ANTHROPIC_BASE_URL: 'https://must-not-leak.example',
          CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
        },
      },
    });
    const spawn = await captureSdkSpawn(prepared.sdkOptions);
    assert.equal(spawn.env.CLAUDE_CODE_ENTRYPOINT, expected);
    assert.equal(spawn.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(spawn.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(prepared.sdkOptions.model, 'claude-opus-4-6');
    assert.equal(prepared.sdkOptions.resume, '11111111-1111-4111-8111-111111111111');
    assert.equal(prepared.sdkOptions.systemPrompt, 'native identity');
    assert.equal(spawn.args[spawn.args.indexOf('--input-format') + 1], 'stream-json');
  });
}

test('SDK entrypoint rejects unsupported labels before starting the provider', async (t) => {
  const saved = process.env[settingKey];
  t.after(() => {
    if (saved === undefined) delete process.env[settingKey];
    else process.env[settingKey] = saved;
  });
  for (const label of ['cli', 'claude-vscode', 'cat-cafe\nother']) {
    process.env[settingKey] = label;
    await assert.rejects(
      prepareClaudeSdkLaunch({
        runtime: claudeSdkRuntimeFixture(),
        catId: createCatId('opus'),
        model: 'claude-opus-4-6',
        prompt: 'normal task',
        l0CompilerFn: async () => 'native identity',
        abortController: new AbortController(),
      }),
      /claude_sdk_entrypoint_invalid/,
    );
  }
});

import { claudeSdkRuntimeFixture } from './helpers/claude-sdk-runtime-fixture.js';
