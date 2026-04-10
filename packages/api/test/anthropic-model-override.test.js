/**
 * Bug fix: anthropic protocol cats should pass account.models to
 * CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE so ClaudeAgentService can remap
 * non-Anthropic model names via ANTHROPIC_DEFAULT_*_MODEL env vars.
 *
 * Root cause: invoke-single-cat.ts only set MODEL_OVERRIDE in the
 * opencode branch, not in the anthropic protocol branch.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

async function collect(iterable) {
  const msgs = [];
  for await (const msg of iterable) msgs.push(msg);
  return msgs;
}

let invokeSingleCat;

describe('anthropic protocol model override from account.models', () => {
  before(async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'anthro-model-audit-'));
    process.env.AUDIT_LOG_DIR = tempDir;
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    invokeSingleCat = mod.invokeSingleCat;
  });

  it('sets CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE when account has models array', async () => {
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
            models: ['gpt-5.4'],
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
        verify: () => null,
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
          catId: 'opus',
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
      await rm(root, { recursive: true, force: true });
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.CAT_CAFE_ANTHROPIC_PROFILE_MODE, 'api_key');
    assert.equal(callbackEnv.CAT_CAFE_ANTHROPIC_API_KEY, 'sk-test-dd999');
    assert.equal(
      callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE,
      'gpt-5.4',
      'anthropic protocol cats with account.models should set MODEL_OVERRIDE',
    );
  });

  it('does NOT set MODEL_OVERRIDE when account has no models array', async () => {
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
    await writeFile(join(catCafeDir, 'cat-catalog.json'), JSON.stringify({ version: 2, breeds: [] }, null, 2), 'utf-8');
    await writeFile(
      join(catCafeDir, 'accounts.json'),
      JSON.stringify(
        {
          claude: {
            authType: 'api_key',
            baseUrl: 'https://api.anthropic.com',
            displayName: 'direct-anthropic',
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

    const optionsSeen = [];
    const service = {
      async *invoke(_prompt, options) {
        optionsSeen.push(options ?? {});
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = {
      registry: {
        create: () => ({ invocationId: 'inv-no-model', callbackToken: 'tok-no-model' }),
        verify: () => null,
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
      await rm(root, { recursive: true, force: true });
    }

    const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
    assert.equal(callbackEnv.CAT_CAFE_ANTHROPIC_PROFILE_MODE, 'api_key');
    assert.equal(
      callbackEnv.CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE,
      undefined,
      'should NOT set MODEL_OVERRIDE when account has no models',
    );
  });
});
