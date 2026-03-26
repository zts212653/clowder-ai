/**
 * AC-C3: proxy 不可达时 fallback 直连 upstream
 *
 * When ANTHROPIC_PROXY_ENABLED is on (default) but the proxy port has nothing
 * listening, invoke-single-cat should fall back to the direct upstream URL
 * instead of routing through the unreachable proxy.
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

describe('F115 AC-C3: proxy fallback to direct upstream', { concurrency: false }, () => {
  before(async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'proxy-fallback-audit-'));
    process.env.AUDIT_LOG_DIR = tempDir;
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    invokeSingleCat = mod.invokeSingleCat;
  });

  it('falls back to direct upstream when proxy port is unreachable', async () => {
    const { createProviderProfile } = await import('../dist/config/provider-profiles.js');
    const root = await mkdtemp(join(tmpdir(), 'f115-fallback-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');
    const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;

    try {
      await createProviderProfile(root, {
        provider: 'anthropic',
        name: 'test-gateway',
        mode: 'api_key',
        baseUrl: 'https://api.test-gateway.example',
        apiKey: 'sk-test-fallback',
        setActive: true,
      });

      const optionsSeen = [];
      const service = {
        async *invoke(_prompt, options) {
          optionsSeen.push(options ?? {});
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      };

      const deps = {
        registry: {
          create: () => ({ invocationId: 'inv-fallback', callbackToken: 'tok-fallback' }),
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
      const previousProxyPort = process.env.ANTHROPIC_PROXY_PORT;
      try {
        // Proxy is ENABLED but port 19871 has nothing listening
        delete process.env.ANTHROPIC_PROXY_ENABLED; // default = enabled
        process.env.ANTHROPIC_PROXY_PORT = '19871';
        process.chdir(apiDir);
        await collect(
          invokeSingleCat(deps, {
            catId: 'opus',
            service,
            prompt: 'test fallback',
            userId: 'user-f115-fallback',
            threadId: 'thread-f115-fallback',
            isLastCat: true,
          }),
        );
      } finally {
        process.chdir(previousCwd);
        if (previousProxyEnabled === undefined) delete process.env.ANTHROPIC_PROXY_ENABLED;
        else process.env.ANTHROPIC_PROXY_ENABLED = previousProxyEnabled;
        if (previousProxyPort === undefined) delete process.env.ANTHROPIC_PROXY_PORT;
        else process.env.ANTHROPIC_PROXY_PORT = previousProxyPort;
      }

      const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
      assert.equal(callbackEnv.CAT_CAFE_ANTHROPIC_PROFILE_MODE, 'api_key');
      // Should fall back to direct upstream, NOT http://127.0.0.1:19871/slug
      assert.equal(
        callbackEnv.CAT_CAFE_ANTHROPIC_BASE_URL,
        'https://api.test-gateway.example',
        'should fall back to direct upstream when proxy is unreachable',
      );
      assert.equal(callbackEnv.CAT_CAFE_ANTHROPIC_API_KEY, 'sk-test-fallback');
    } finally {
      if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to direct upstream when ANTHROPIC_PROXY_PORT is non-numeric (not subscription)', async () => {
    const { createProviderProfile } = await import('../dist/config/provider-profiles.js');
    const root = await mkdtemp(join(tmpdir(), 'f115-nan-port-'));
    const apiDir = join(root, 'packages', 'api');
    await mkdir(apiDir, { recursive: true });
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n', 'utf-8');
    const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;

    try {
      await createProviderProfile(root, {
        provider: 'anthropic',
        name: 'nan-port-gateway',
        mode: 'api_key',
        baseUrl: 'https://api.nan-port.example',
        apiKey: 'sk-nan-port',
        setActive: true,
      });

      const optionsSeen = [];
      const service = {
        async *invoke(_prompt, options) {
          optionsSeen.push(options ?? {});
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      };

      const deps = {
        registry: {
          create: () => ({ invocationId: 'inv-nan', callbackToken: 'tok-nan' }),
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
      const previousProxyPort = process.env.ANTHROPIC_PROXY_PORT;
      try {
        delete process.env.ANTHROPIC_PROXY_ENABLED;
        process.env.ANTHROPIC_PROXY_PORT = 'abc'; // non-numeric!
        process.chdir(apiDir);
        await collect(
          invokeSingleCat(deps, {
            catId: 'opus',
            service,
            prompt: 'test nan port',
            userId: 'user-f115-nan',
            threadId: 'thread-f115-nan',
            isLastCat: true,
          }),
        );
      } finally {
        process.chdir(previousCwd);
        if (previousProxyEnabled === undefined) delete process.env.ANTHROPIC_PROXY_ENABLED;
        else process.env.ANTHROPIC_PROXY_ENABLED = previousProxyEnabled;
        if (previousProxyPort === undefined) delete process.env.ANTHROPIC_PROXY_PORT;
        else process.env.ANTHROPIC_PROXY_PORT = previousProxyPort;
      }

      const callbackEnv = optionsSeen[0]?.callbackEnv ?? {};
      // Must stay api_key, NOT silently degrade to subscription
      assert.equal(
        callbackEnv.CAT_CAFE_ANTHROPIC_PROFILE_MODE,
        'api_key',
        'should keep api_key mode even with invalid proxy port',
      );
      // Should fall back to direct upstream
      assert.equal(
        callbackEnv.CAT_CAFE_ANTHROPIC_BASE_URL,
        'https://api.nan-port.example',
        'should fall back to direct upstream with invalid proxy port',
      );
    } finally {
      if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
});
