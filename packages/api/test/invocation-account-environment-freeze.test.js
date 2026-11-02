import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import {
  invokeSingleCat,
  prepareInvocationExecutionBinding,
} from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { ContextEpochOwner } from '../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../dist/domains/cats/services/stores/ports/ContextEpochStore.js';

test('provider configuration capture and invocation use the same frozen account environment', async (t) => {
  const artifacts = join(process.cwd(), 'artifacts', 'role-agent-refactor', 'account-environment-freeze');
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, 'fixture-'));
  mkdirSync(join(root, '.cat-cafe'));
  const keys = ['CAT_CAFE_CONFIG_ROOT', 'CAT_CAFE_GLOBAL_CONFIG_ROOT'];
  const old = new Map(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => {
    process.env[key] = root;
  });
  const all = catRegistry.getAllConfigs();
  t.after(() => {
    old.forEach((value, key) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    catRegistry.reset();
    Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
  });
  const id = 'account-environment-freeze';
  catRegistry.register(id, {
    ...all.kimi,
    id,
    mcpSupport: false,
    configurationSource: 'managed_account',
    accountRef: 'owned-kimi',
  });
  const writeAccount = (marker) =>
    writeFileSync(
      join(root, '.cat-cafe', 'accounts.json'),
      JSON.stringify({
        'owned-kimi': {
          authType: 'oauth',
          clientId: 'kimi',
          envVars: {
            KIMI_CODE_HOME: join(root, marker),
            CUSTOM_EMPTY: '',
            CAT_CAFE_CALLBACK_TOKEN: 'must-not-cross-account-boundary',
            FROM_TEMPLATE: '${api_key}',
            lowercase: 'invalid-key',
          },
        },
      }),
    );
  writeAccount('before');
  let captured;
  let invoked;
  const service = {
    captureInvocationOptions: async (input) => {
      captured = input;
      return {};
    },
    supportsToolExecutionPolicy: () => true,
    async *invoke(_prompt, options) {
      invoked = options;
      yield { type: 'done', catId: id, timestamp: Date.now() };
    },
  };
  const deps = {
    threadStore: null,
    registry: {
      create: () => ({ invocationId: 'account-freeze-invocation', callbackToken: 'owned-fixture' }),
      verify: async () => ({ ok: false }),
    },
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => undefined,
    },
    apiUrl: 'http://127.0.0.1:1',
    contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
  };
  const binding = await prepareInvocationExecutionBinding(deps, {
    catId: id,
    threadId: 'thread',
    userId: 'owner',
    service,
  });
  writeAccount('after');
  const expected = { KIMI_CODE_HOME: join(root, 'before'), CUSTOM_EMPTY: '' };
  assert.deepEqual(captured.accountEnv, expected, 'MCP discovery needs the selected invocation account HOME');
  assert.equal(captured.mcpSupport, false);
  assert.deepEqual(binding.accountEnv, expected);
  assert.ok(Object.isFrozen(binding.accountEnv));
  assert.equal(binding.resolvedAccount.envVars.KIMI_CODE_HOME, expected.KIMI_CODE_HOME);
  assert.equal(
    binding.resolvedAccount.envVars.CAT_CAFE_CALLBACK_TOKEN,
    'must-not-cross-account-boundary',
    'filtering must not alter the account store projection',
  );
  const messages = await Array.fromAsync(
    invokeSingleCat(deps, {
      catId: id,
      threadId: 'thread',
      userId: 'owner',
      service,
      executionBinding: binding,
      prompt: 'isolated task',
      isLastCat: true,
      toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    }),
  );
  assert.deepEqual(
    messages.filter((message) => message.type === 'error'),
    [],
  );
  assert.deepEqual(invoked.accountEnv, expected, 'actual invocation must consume the discovery environment');
});
