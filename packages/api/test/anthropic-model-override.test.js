/**
 * Regression coverage for anthropic protocol MODEL_OVERRIDE wiring.
 * ClaudeAgentService uses the override to remap runtime model names via
 * ANTHROPIC_DEFAULT_*_MODEL env vars.
 *
 * Regression (#1086): account.models is an allowed-model list, not an
 * implicit default; models[0] must not override the cat defaultModel.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

async function collect(iterable) {
  const msgs = [];
  for await (const msg of iterable) msgs.push(msg);
  return msgs;
}

let invokeSingleCat;

describe('anthropic protocol model override from cat defaultModel', () => {
  before(async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'anthro-model-audit-'));
    process.env.AUDIT_LOG_DIR = tempDir;
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    invokeSingleCat = mod.invokeSingleCat;
  });

  it('uses cat defaultModel for MODEL_OVERRIDE instead of account.models[0]', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anthro-model-override-'));
    const apiDir = join(root, 'packages', 'api');
    const catCafeDir = join(root, '.cat-cafe');
    const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    const previousHome = process.env.HOME;
    await mkdir(apiDir, { recursive: true });
    await mkdir(catCafeDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
    process.env.HOME = root;
    const registrySnapshot = catRegistry.getAllConfigs();
    const originalConfig = catRegistry.tryGet('opus')?.config;
    assert.ok(originalConfig, 'opus config should exist in registry');
    const boundCatId = 'opus-clowder-1086-default-model';
    catRegistry.register(boundCatId, {
      ...originalConfig,
      id: boundCatId,
      mentionPatterns: [`@${boundCatId}`],
      accountRef: 'claude',
      defaultModel: 'claude-sonnet-5',
    });

    // Canonical stores: accounts.json + credentials.json (not legacy cat-catalog.json.accounts)
    await writeFile(join(catCafeDir, 'cat-catalog.json'), JSON.stringify({ version: 2, breeds: [] }, null, 2), 'utf-8');
    await writeFile(
      join(catCafeDir, 'accounts.json'),
      JSON.stringify(
        {
          claude: {
            authType: 'api_key',
            baseUrl: 'https://dd999-proxy.example/v1',
            displayName: 'dd999-proxy',
            models: ['claude-fable-5', 'claude-sonnet-5'],
            envVars: {
              // biome-ignore lint/suspicious/noTemplateCurlyInString: stored account input is expanded by resolveEnvMap.
              ANTHROPIC_AUTH_TOKEN: '${api_key}',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
    await writeFile(
      join(catCafeDir, 'credentials.json'),
      JSON.stringify({ claude: { apiKey: 'sk-test-dd999' } }, null, 2),
      'utf-8',
    );

    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = {
      registry: {
        create: () => ({ invocationId: 'inv-model-override', callbackToken: 'tok-model' }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    };

    const previousCwd = process.cwd();
    const previousProxyEnabled = process.env.ANTHROPIC_PROXY_ENABLED;
    try {
      process.env.ANTHROPIC_PROXY_ENABLED = '0';
      process.chdir(apiDir);
      await collect(
        invokeSingleCat(deps, {
          catId: boundCatId,
          service,
          prompt: 'test model override',
          userId: 'user-model-override',
          threadId: 'thread-model-override',
          isLastCat: true,
        }),
      );
    } finally {
      process.chdir(previousCwd);
      if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousProxyEnabled === undefined) delete process.env.ANTHROPIC_PROXY_ENABLED;
      else process.env.ANTHROPIC_PROXY_ENABLED = previousProxyEnabled;
      catRegistry.reset();
      for (const [id, config] of Object.entries(registrySnapshot)) {
        catRegistry.register(id, config);
      }
      await rm(root, { recursive: true, force: true });
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.CAT_CAFE_ANTHROPIC_PROFILE_MODE, 'api_key');
    assert.equal(callbackEnv.CAT_CAFE_ANTHROPIC_API_KEY, 'sk-test-dd999');
    const { buildClaudeEnvOverrides } = await import(
      '../dist/domains/cats/services/agents/providers/ClaudeAgentService.js'
    );
    const { buildChildEnv } = await import('../dist/utils/cli-spawn.js');
    const childEnv = buildChildEnv(buildClaudeEnvOverrides(callbackEnv));
    assert.equal(childEnv.ANTHROPIC_AUTH_TOKEN, 'sk-test-dd999', 'account token templates must survive launch');
    assert.equal(childEnv.ANTHROPIC_BASE_URL, 'https://dd999-proxy.example');
    assert.equal(
      callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE,
      'claude-sonnet-5',
      'anthropic api_key accounts must not treat account.models[0] as the default model',
    );
  });

  for (const { destinationName, accountEnvVars, expectedBaseUrl } of [
    { destinationName: 'official', accountEnvVars: undefined, expectedBaseUrl: 'https://api.anthropic.com' },
    {
      destinationName: 'account template',
      accountEnvVars: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: stored account input is expanded by resolveEnvMap.
        ANTHROPIC_BASE_URL: 'https://template-gateway.invalid/${base_url}',
      },
      expectedBaseUrl: 'https://template-gateway.invalid/',
    },
  ])
    it(`uses the cat model for a key-only Anthropic account (${destinationName} destination)`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'anthro-no-model-'));
      const apiDir = join(root, 'packages', 'api');
      const catCafeDir = join(root, '.cat-cafe');
      const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      const previousHome2 = process.env.HOME;
      await mkdir(apiDir, { recursive: true });
      await mkdir(catCafeDir, { recursive: true });
      await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
      process.env.HOME = root;

      // Canonical stores: accounts.json + credentials.json (no models array)
      await writeFile(
        join(catCafeDir, 'cat-catalog.json'),
        JSON.stringify({ version: 2, breeds: [] }, null, 2),
        'utf-8',
      );
      await writeFile(
        join(catCafeDir, 'accounts.json'),
        JSON.stringify(
          {
            claude: {
              authType: 'api_key',
              clientId: 'anthropic',
              displayName: 'direct-anthropic',
              envVars: accountEnvVars,
            },
          },
          null,
          2,
        ),
        'utf-8',
      );
      await writeFile(
        join(catCafeDir, 'credentials.json'),
        JSON.stringify({ claude: { apiKey: 'sk-ant-direct' } }, null, 2),
        'utf-8',
      );

      const { buildClaudeEnvOverrides } = await import(
        '../dist/domains/cats/services/agents/providers/ClaudeAgentService.js'
      );
      const { buildChildEnv } = await import('../dist/utils/cli-spawn.js');
      const launchEnvs = [];
      const optionsSeen = [];
      const service = {
        async *invoke(_prompt, options) {
          optionsSeen.push(options ?? {});
          const env = buildChildEnv(buildClaudeEnvOverrides(options?.callbackEnv));
          launchEnvs.push({
            baseUrl: env.ANTHROPIC_BASE_URL,
            apiKey: env.ANTHROPIC_API_KEY,
            authToken: env.ANTHROPIC_AUTH_TOKEN,
          });
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      };

      const deps = {
        registry: {
          create: () => ({ invocationId: 'inv-no-model', callbackToken: 'tok-no-model' }),
          verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
        },
        sessionManager: {
          get: async () => undefined,
          getOrCreate: async () => ({}),
          store: async () => {},
          delete: async () => {},
          resolveWorkingDirectory: () => '/tmp/test',
        },
        threadStore: null,
        apiUrl: 'http://127.0.0.1:3004',
      };

      const previousCwd = process.cwd();
      const previousProxyEnabled = process.env.ANTHROPIC_PROXY_ENABLED;
      const previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
      const previousAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
      try {
        process.env.ANTHROPIC_PROXY_ENABLED = '0';
        process.env.ANTHROPIC_BASE_URL = 'https://ambient-gateway.invalid';
        process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-bearer';
        process.chdir(apiDir);
        await collect(
          invokeSingleCat(deps, {
            catId: 'opus',
            service,
            prompt: 'test no model override',
            userId: 'user-no-model',
            threadId: 'thread-no-model',
            isLastCat: true,
          }),
        );
      } finally {
        process.chdir(previousCwd);
        if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
        else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
        if (previousHome2 === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome2;
        if (previousProxyEnabled === undefined) delete process.env.ANTHROPIC_PROXY_ENABLED;
        else process.env.ANTHROPIC_PROXY_ENABLED = previousProxyEnabled;
        if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
        else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
        if (previousAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
        else process.env.ANTHROPIC_AUTH_TOKEN = previousAuthToken;
        await rm(root, { recursive: true, force: true });
      }

      assert.deepEqual(
        launchEnvs,
        [
          {
            baseUrl: expectedBaseUrl,
            apiKey: 'sk-ant-direct',
            authToken: undefined,
          },
        ],
        'selected account destination must be used without inheriting an ambient bearer token',
      );
      const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
      assert.equal(callbackEnv.CAT_CAFE_ANTHROPIC_PROFILE_MODE, 'api_key');
      assert.equal(
        callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE,
        'claude-opus-4-6',
        'the member model must not depend on account.models being populated',
      );
    });
});
