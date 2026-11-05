import { claudeSdkRuntimeFixture } from './helpers/claude-sdk-runtime-fixture.js';
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry, createCatId, sanitizedRequestedRuntimeConfigSchema } from '@cat-cafe/shared';
import { prepareClaudeSdkLaunch } from '../src/domains/cats/services/agents/providers/claude-sdk-launch.js';

test('native SDK inheritance records absent model and effort without invalid empty strings', async () => {
  const base = catRegistry.tryGet('opus');
  assert.ok(base);
  const id = createCatId('native-sdk-inherit');
  catRegistry.register(id, {
    ...base.config,
    id,
    configurationSource: 'native_tool',
    defaultModel: '',
    cli: { command: 'claude', outputFormat: 'stream-json' },
  });
  let requested: unknown;
  const result = await prepareClaudeSdkLaunch({
    runtime: claudeSdkRuntimeFixture(),
    catId: id,
    model: '',
    prompt: 'small goal',
    l0CompilerFn: async () => 'identity',
    abortController: new AbortController(),
    options: {
      beforeProviderLaunch: async (request) => {
        requested = request.runtime;
      },
    },
  });
  assert.equal(sanitizedRequestedRuntimeConfigSchema.safeParse(requested).success, true);
  assert.equal(result.sdkOptions.model, undefined);
  assert.equal(result.sdkOptions.effort, undefined);
});
