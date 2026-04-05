import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('account-resolver (4b unified runtime resolution)', () => {
  let projectRoot;
  let previousGlobalRoot;
  const ENV_KEYS_TO_ISOLATE = ['CAT_CAFE_GLOBAL_CONFIG_ROOT', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'];
  const savedEnv = {};

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'acct-resolve-'));
    // Snapshot and clear all env vars that could pollute resolver results
    for (const key of ENV_KEYS_TO_ISOLATE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
  });

  afterEach(async () => {
    // Restore all saved env vars
    for (const key of ENV_KEYS_TO_ISOLATE) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await rm(projectRoot, { recursive: true, force: true });
  });

  function writeCatalog(accounts) {
    const catalog = {
      version: 2,
      breeds: [],
      roster: {},
      reviewPolicy: {
        requireDifferentFamily: true,
        preferActiveInThread: true,
        preferLead: true,
        excludeUnavailable: true,
      },
      accounts,
    };
    return writeFile(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(catalog, null, 2), 'utf-8');
  }

  function writeCredentials(creds) {
    return writeFile(join(projectRoot, '.cat-cafe', 'credentials.json'), JSON.stringify(creds, null, 2), 'utf-8');
  }

  it('resolveByAccountRef returns RuntimeProviderProfile from accounts + credentials', async () => {
    const { resolveByAccountRef } = await import(`../dist/config/account-resolver.js?t=${Date.now()}`);
    await writeCatalog({
      'my-glm': {
        authType: 'api_key',
        protocol: 'openai',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        models: ['glm-5'],
        displayName: 'My GLM',
      },
    });
    await writeCredentials({ 'my-glm': { apiKey: 'glm-xxx' } });

    const profile = resolveByAccountRef(projectRoot, 'my-glm');
    assert.ok(profile);
    assert.equal(profile.id, 'my-glm');
    assert.equal(profile.authType, 'api_key');
    assert.equal(profile.kind, 'api_key');
    assert.equal(profile.protocol, 'openai');
    assert.equal(profile.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
    assert.equal(profile.apiKey, 'glm-xxx');
    assert.deepEqual(profile.models, ['glm-5']);
  });

  it('resolveByAccountRef returns builtin-style profile for oauth accounts', async () => {
    const { resolveByAccountRef } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-1`);
    await writeCatalog({
      claude: {
        authType: 'oauth',
        protocol: 'anthropic',
        models: ['claude-opus-4-6', 'claude-sonnet-4-6'],
      },
    });
    await writeCredentials({});

    const profile = resolveByAccountRef(projectRoot, 'claude');
    assert.ok(profile);
    assert.equal(profile.id, 'claude');
    assert.equal(profile.authType, 'oauth');
    assert.equal(profile.kind, 'builtin');
    assert.equal(profile.protocol, 'anthropic');
    assert.equal(profile.apiKey, undefined);
  });

  it('resolveByAccountRef returns null for unknown ref', async () => {
    const { resolveByAccountRef } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-2`);
    await writeCatalog({});

    const profile = resolveByAccountRef(projectRoot, 'nonexistent');
    assert.equal(profile, null);
  });

  it('resolveByAccountRef exposes synthetic builtin profile for kimi', async () => {
    const { resolveByAccountRef, resolveBuiltinClientForProvider } = await import(
      `../dist/config/account-resolver.js?t=${Date.now()}-2b`
    );
    await writeCatalog({});

    const kimi = resolveByAccountRef(projectRoot, 'kimi');
    assert.ok(kimi);
    assert.equal(kimi.id, 'kimi');
    assert.equal(kimi.authType, 'oauth');
    assert.equal(kimi.kind, 'builtin');
    assert.equal(kimi.client, 'kimi');
    assert.equal(kimi.protocol, 'kimi');

    assert.equal(resolveBuiltinClientForProvider('kimi'), 'kimi');
  });

  it('resolveByAccountRef injects apiKey from credentials', async () => {
    const { resolveByAccountRef } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-3`);
    await writeCatalog({
      custom: { authType: 'api_key', protocol: 'anthropic' },
    });
    await writeCredentials({ custom: { apiKey: 'sk-custom-key' } });

    const profile = resolveByAccountRef(projectRoot, 'custom');
    assert.ok(profile);
    assert.equal(profile.apiKey, 'sk-custom-key');
  });

  it('resolveByAccountRef maps client from protocol for builtin accounts', async () => {
    const { resolveByAccountRef } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-4`);
    await writeCatalog({
      codex: { authType: 'oauth', protocol: 'openai', models: ['gpt-5.3-codex'] },
    });
    await writeCredentials({});

    const profile = resolveByAccountRef(projectRoot, 'codex');
    assert.ok(profile);
    assert.equal(profile.client, 'openai');
  });

  it('resolveForClient resolves by protocol via accounts', async () => {
    const { resolveForClient } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-5`);
    await writeCatalog({
      claude: { authType: 'oauth', protocol: 'anthropic', models: ['claude-opus-4-6'] },
      codex: { authType: 'oauth', protocol: 'openai', models: ['gpt-5.3-codex'] },
    });
    await writeCredentials({});

    const profile = resolveForClient(projectRoot, 'anthropic');
    assert.ok(profile);
    assert.equal(profile.protocol, 'anthropic');
  });

  it('resolveForClient prefers preferredAccountRef when provided', async () => {
    const { resolveForClient } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-6`);
    await writeCatalog({
      claude: { authType: 'oauth', protocol: 'anthropic' },
      'my-ant': { authType: 'api_key', protocol: 'anthropic', baseUrl: 'https://custom.ant.com' },
    });
    await writeCredentials({ 'my-ant': { apiKey: 'sk-custom' } });

    const profile = resolveForClient(projectRoot, 'anthropic', 'my-ant');
    assert.ok(profile);
    assert.equal(profile.id, 'my-ant');
    assert.equal(profile.baseUrl, 'https://custom.ant.com');
    assert.equal(profile.apiKey, 'sk-custom');
  });

  it('resolveForClient returns null when multiple accounts match same protocol (ambiguous)', async () => {
    const { resolveForClient } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-8`);
    await writeCatalog({
      'claude-main': { authType: 'api_key', protocol: 'anthropic', displayName: 'Claude Main' },
      'claude-backup': { authType: 'api_key', protocol: 'anthropic', displayName: 'Claude Backup' },
    });
    await writeCredentials({});

    // With two anthropic accounts and no preference, result must be null (not arbitrary first match)
    const profile = resolveForClient(projectRoot, 'anthropic');
    assert.equal(profile, null);
  });

  it('resolveForClient does not fall back to builtin when multiple concrete matches exist', async () => {
    const { resolveForClient } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-8b`);
    await writeCatalog({
      'kimi-primary': { authType: 'api_key', protocol: 'kimi', displayName: 'Kimi Primary' },
      'kimi-secondary': { authType: 'api_key', protocol: 'kimi', displayName: 'Kimi Secondary' },
    });
    await writeCredentials({});

    const profile = resolveForClient(projectRoot, 'kimi', 'kimi');
    assert.equal(profile, null);
  });


  it('resolveForClient returns the account when only one matches protocol', async () => {
    const { resolveForClient } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-9`);
    await writeCatalog({
      'my-ant': { authType: 'api_key', protocol: 'anthropic' },
      codex: { authType: 'api_key', protocol: 'openai' },
    });
    await writeCredentials({});

    const profile = resolveForClient(projectRoot, 'anthropic');
    assert.ok(profile);
    assert.equal(profile.id, 'my-ant');
  });

  it('resolveForClient prefers protocol match over stale builtin ref when exactly one concrete account exists', async () => {
    const { resolveForClient } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-9b`);
    await writeCatalog({
      'moonshot-api': { authType: 'api_key', protocol: 'kimi', baseUrl: 'https://api.moonshot.ai/v1' },
    });
    await writeCredentials({ 'moonshot-api': { apiKey: 'sk-kimi' } });

    const profile = resolveForClient(projectRoot, 'kimi', 'kimi');
    assert.ok(profile);
    assert.equal(profile.id, 'moonshot-api');
    assert.equal(profile.kind, 'api_key');
    assert.equal(profile.protocol, 'kimi');
    assert.equal(profile.apiKey, 'sk-kimi');
  });

  it('resolveForClient returns baseUrl from custom account (game domain P2-1 pattern)', async () => {
    const { resolveForClient } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-10`);
    await writeCatalog({
      'custom-ant': {
        authType: 'api_key',
        protocol: 'anthropic',
        baseUrl: 'https://custom-proxy.example.com',
      },
    });
    await writeCredentials({ 'custom-ant': { apiKey: 'sk-custom-proxy' } });

    const profile = resolveForClient(projectRoot, 'anthropic');
    assert.ok(profile);
    assert.equal(profile.apiKey, 'sk-custom-proxy');
    assert.equal(profile.baseUrl, 'https://custom-proxy.example.com');
  });

  it('env fallback retired (#329): resolveByAccountRef returns undefined apiKey when credentials absent', async () => {
    const { resolveByAccountRef } = await import(`../dist/config/account-resolver.js?t=${Date.now()}-7`);
    await writeCatalog({
      custom: { authType: 'api_key', protocol: 'anthropic' },
    });
    // No credentials written — env fallback removed in #329 (protocol退場)
    const profile = resolveByAccountRef(projectRoot, 'custom');
    assert.ok(profile);
    assert.equal(profile.apiKey, undefined, 'env fallback retired: no apiKey without stored credential');
  });
});
