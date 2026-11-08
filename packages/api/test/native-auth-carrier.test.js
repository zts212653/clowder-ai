import '../../../scripts/native-auth-boundary.test.mjs';
import '../../../scripts/native-auth-providers.test.mjs';
import { test } from 'node:test';
import { prepareClaudeSdkLaunch } from '../dist/domains/cats/services/agents/providers/claude-sdk-launch.js';
import { claudeSdkRuntimeFixture } from './helpers/claude-sdk-runtime-fixture.js';
import { assertNativeAuthHookContract } from './helpers/native-auth-hook-contract.js';

test('Claude SDK final settings enforce auth policy despite operator hook disable settings', async () => {
  const launch = await prepareClaudeSdkLaunch({
    runtime: claudeSdkRuntimeFixture(),
    catId: 'opus55',
    model: 'fixture',
    prompt: 'fixture only',
    l0CompilerFn: async () => 'fixture instructions',
    abortController: new AbortController(),
    options: { cliConfigArgs: ['--settings', '{"disableAllHooks":true,"hooks":{"PreToolUse":[]}}'] },
  });
  assertNativeAuthHookContract(String(launch.sdkOptions.settings));
});
