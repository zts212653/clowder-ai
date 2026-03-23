import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { CAT_CONFIGS, catRegistry, createCatId } from '@cat-cafe/shared';

const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
const { _clearRuntimeOverrides, getRuntimeOverride, setRuntimeOverride } = await import(
  '../dist/config/session-strategy-overrides.js'
);

const tempDirs = [];
let savedTemplatePath;

function resetRegistryToBuiltins() {
  catRegistry.reset();
  for (const [id, config] of Object.entries(CAT_CONFIGS)) {
    catRegistry.register(id, config);
  }
}

function makeTemplate() {
  return {
    version: 2,
    breeds: [
      {
        id: 'ragdoll',
        catId: 'opus',
        name: '布偶猫',
        displayName: '布偶猫',
        avatar: '/avatars/opus.png',
        color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
        mentionPatterns: ['@opus', '@布偶猫'],
        roleDescription: '主架构师',
        defaultVariantId: 'opus-default',
        variants: [
          {
            id: 'opus-default',
            provider: 'anthropic',
            defaultModel: 'claude-sonnet-4-5-20250929',
            mcpSupport: true,
            cli: { command: 'claude', outputFormat: 'stream-json' },
          },
        ],
      },
    ],
    roster: {
      opus: {
        family: 'ragdoll',
        roles: ['architect'],
        lead: true,
        available: true,
        evaluation: 'primary',
      },
    },
    reviewPolicy: {
      requireDifferentFamily: true,
      preferActiveInThread: true,
      preferLead: true,
      excludeUnavailable: true,
    },
    coCreator: {
      name: 'Co-worker',
      aliases: ['共创伙伴'],
      mentionPatterns: ['@co-worker', '@owner'],
    },
  };
}

function createProjectRoot() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cats-route-crud-'));
  tempDirs.push(projectRoot);
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;
  writeFileSync(join(projectRoot, 'cat-template.json'), JSON.stringify(makeTemplate(), null, 2));
  return projectRoot;
}

function createMonorepoProjectRoot() {
  const projectRoot = createProjectRoot();
  writeFileSync(join(projectRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  return projectRoot;
}

function createProjectRootFromRepoTemplate() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cats-route-crud-seed-'));
  tempDirs.push(projectRoot);
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;
  const repoTemplate = JSON.parse(readFileSync(join(process.cwd(), '..', '..', 'cat-template.json'), 'utf-8'));
  writeFileSync(join(projectRoot, 'cat-template.json'), JSON.stringify(repoTemplate, null, 2));
  return projectRoot;
}

describe('cats routes runtime CRUD', { concurrency: false }, () => {
  /** @type {string | undefined} */ let savedGlobalRoot;

  beforeEach(() => {
    savedTemplatePath = process.env.CAT_TEMPLATE_PATH;
    savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    resetRegistryToBuiltins();
    _clearRuntimeOverrides();
  });

  afterEach(() => {
    if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
    if (savedTemplatePath === undefined) {
      delete process.env.CAT_TEMPLATE_PATH;
    } else {
      process.env.CAT_TEMPLATE_PATH = savedTemplatePath;
    }
    resetRegistryToBuiltins();
    _clearRuntimeOverrides();
  });

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST /api/cats creates a normal runtime member and PATCH updates aliases immediately', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        catId: 'runtime-spark',
        name: '火花猫',
        displayName: '火花猫',
        nickname: '小火花',
        avatar: '/avatars/spark.png',
        color: { primary: '#f97316', secondary: '#fed7aa' },
        mentionPatterns: ['@runtime-spark', '@火花猫'],
        roleDescription: '快速执行',
        personality: '利落',
        teamStrengths: '精确点改',
        caution: '不会自动跑测试',
        strengths: ['precision', 'speed'],
        sessionChain: true,
        client: 'openai',
        accountRef: 'codex',
        defaultModel: 'gpt-5.4',
        contextBudget: {
          maxPromptTokens: 24000,
          maxContextTokens: 16000,
          maxMessages: 24,
          maxContentLengthPerMsg: 6000,
        },
        mcpSupport: false,
        cli: { command: 'codex', outputFormat: 'json' },
      }),
    });
    assert.equal(createRes.statusCode, 201);
    const createdBody = JSON.parse(createRes.body);
    assert.equal(createdBody.cat.id, 'runtime-spark');
    assert.equal(createdBody.cat.provider, 'openai');

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/runtime-spark',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        displayName: '运行时火花猫',
        nickname: '火花',
        mentionPatterns: ['@runtime-spark', '@运行时火花'],
        teamStrengths: '精确点改 + 快速修复',
        caution: '',
        strengths: ['precision', 'speed', 'surgical-edits'],
        sessionChain: false,
        contextBudget: {
          maxPromptTokens: 36000,
          maxContextTokens: 22000,
          maxMessages: 36,
          maxContentLengthPerMsg: 9000,
        },
      }),
    });
    assert.equal(patchRes.statusCode, 200);

    const listRes = await app.inject({ method: 'GET', url: '/api/cats' });
    assert.equal(listRes.statusCode, 200);
    const listBody = JSON.parse(listRes.body);
    const runtimeCat = listBody.cats.find((cat) => cat.id === 'runtime-spark');
    assert.ok(runtimeCat, 'runtime-spark should appear in /api/cats');
    assert.equal(runtimeCat.displayName, '运行时火花猫');
    assert.equal(runtimeCat.nickname, '火花');
    assert.deepEqual(runtimeCat.mentionPatterns, ['@runtime-spark', '@运行时火花']);
    assert.equal(runtimeCat.teamStrengths, '精确点改 + 快速修复');
    assert.equal(runtimeCat.caution, null);
    assert.deepEqual(runtimeCat.strengths, ['precision', 'speed', 'surgical-edits']);
    assert.equal(runtimeCat.sessionChain, false);
    assert.deepEqual(runtimeCat.contextBudget, {
      maxPromptTokens: 36000,
      maxContextTokens: 22000,
      maxMessages: 36,
      maxContentLengthPerMsg: 9000,
    });

    const bindProviderRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/runtime-spark',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        providerProfileId: 'codex',
      }),
    });
    assert.equal(bindProviderRes.statusCode, 200);

    const clearProviderRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/runtime-spark',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        providerProfileId: null,
      }),
    });
    assert.equal(clearProviderRes.statusCode, 400);
    assert.match(JSON.parse(clearProviderRes.body).error, /requires a provider binding/i);

    const clearBudgetRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/runtime-spark',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        contextBudget: null,
      }),
    });
    assert.equal(clearBudgetRes.statusCode, 200);

    const listAfterClearRes = await app.inject({ method: 'GET', url: '/api/cats' });
    assert.equal(listAfterClearRes.statusCode, 200);
    const listAfterClearBody = JSON.parse(listAfterClearRes.body);
    const runtimeCatAfterClear = listAfterClearBody.cats.find((cat) => cat.id === 'runtime-spark');
    assert.ok(runtimeCatAfterClear, 'runtime-spark should still exist');
    assert.equal(runtimeCatAfterClear.contextBudget, undefined);
    assert.equal(runtimeCatAfterClear.accountRef, 'codex');

    const mentions = parseA2AMentions('@运行时火花 请跟进这个分支', createCatId('opus'));
    assert.ok(mentions.includes('runtime-spark'), 'new alias should route immediately');
  });

  it('POST /api/cats falls back to the readable active project root when CAT_TEMPLATE_PATH is stale', async () => {
    const projectRoot = createMonorepoProjectRoot();
    const staleRoot = mkdtempSync(join(tmpdir(), 'cats-route-crud-stale-'));
    tempDirs.push(staleRoot);
    const previousCwd = process.cwd();
    process.chdir(projectRoot);
    process.env.CAT_TEMPLATE_PATH = join(staleRoot, 'missing-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    try {
      await app.register(catsRoutes);

      const createRes = await app.inject({
        method: 'POST',
        url: '/api/cats',
        headers: {
          'content-type': 'application/json',
          'x-cat-cafe-user': 'codex',
        },
        body: JSON.stringify({
          catId: 'runtime-fallback',
          name: '回退猫',
          displayName: '回退猫',
          avatar: '/avatars/fallback.png',
          color: { primary: '#2563eb', secondary: '#bfdbfe' },
          mentionPatterns: ['@runtime-fallback'],
          roleDescription: '验证 project root fallback',
          client: 'openai',
          accountRef: 'codex',
          defaultModel: 'gpt-5.4',
        }),
      });

      assert.equal(createRes.statusCode, 201);
      assert.equal(existsSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json')), true);
      assert.equal(existsSync(join(staleRoot, '.cat-cafe', 'cat-catalog.json')), false);
    } finally {
      process.chdir(previousCwd);
      await app.close();
    }
  });

  it('POST /api/cats creates Antigravity members without requiring provider selection', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        catId: 'runtime-antigravity',
        name: '运行时桥接猫',
        displayName: '运行时桥接猫',
        avatar: '/avatars/antigravity.png',
        color: { primary: '#0f766e', secondary: '#99f6e4' },
        mentionPatterns: ['@runtime-antigravity'],
        roleDescription: '桥接通道',
        personality: '稳定',
        client: 'antigravity',
        defaultModel: 'gemini-bridge',
        commandArgs: ['chat', '--mode', 'agent'],
      }),
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.cat.id, 'runtime-antigravity');
    assert.equal(body.cat.provider, 'antigravity');
    assert.equal(body.cat.defaultModel, 'gemini-bridge');

    const statusRes = await app.inject({ method: 'GET', url: '/api/cats/runtime-antigravity/status' });
    assert.equal(statusRes.statusCode, 200);
    const statusBody = JSON.parse(statusRes.body);
    assert.equal(statusBody.id, 'runtime-antigravity');
  });

  it('PATCH /api/cats/:id allows clearing antigravity commandArgs with an empty array', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        catId: 'runtime-antigravity-clear',
        name: '运行时桥接猫',
        displayName: '运行时桥接猫',
        avatar: '/avatars/antigravity.png',
        color: { primary: '#0f766e', secondary: '#99f6e4' },
        mentionPatterns: ['@runtime-antigravity-clear'],
        roleDescription: '桥接通道',
        personality: '稳定',
        client: 'antigravity',
        defaultModel: 'gemini-bridge',
        commandArgs: ['chat', '--mode', 'agent'],
      }),
    });
    assert.equal(createRes.statusCode, 201);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/runtime-antigravity-clear',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        commandArgs: [],
      }),
    });
    assert.equal(patchRes.statusCode, 200);
    const patchBody = JSON.parse(patchRes.body);
    assert.equal(patchBody.cat.commandArgs, undefined);
  });

  it('POST /api/cats defaults mcpSupport=true for Codex/Gemini clients when omitted', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    for (const spec of [
      { catId: 'runtime-openai', client: 'openai', accountRef: 'codex', model: 'gpt-5.4' },
      { catId: 'runtime-gemini', client: 'google', accountRef: 'gemini', model: 'gemini-2.5-pro' },
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/cats',
        headers: {
          'content-type': 'application/json',
          'x-cat-cafe-user': 'codex',
        },
        body: JSON.stringify({
          catId: spec.catId,
          name: `${spec.catId}-name`,
          displayName: `${spec.catId}-display`,
          avatar: '/avatars/runtime.png',
          color: { primary: '#334155', secondary: '#cbd5e1' },
          mentionPatterns: [`@${spec.catId}`],
          roleDescription: 'runtime',
          client: spec.client,
          accountRef: spec.accountRef,
          defaultModel: spec.model,
        }),
      });

      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.cat.id, spec.catId);
      assert.equal(body.cat.mcpSupport, true);
    }
  });

  it('PATCH /api/cats/:id rejects provider bindings that do not resolve to an existing account', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        catId: 'runtime-codex',
        name: '运行时缅因猫',
        displayName: '运行时缅因猫',
        avatar: '/avatars/codex.png',
        color: { primary: '#16a34a', secondary: '#bbf7d0' },
        mentionPatterns: ['@runtime-codex'],
        roleDescription: '审查',
        client: 'openai',
        accountRef: 'codex',
        defaultModel: 'gpt-5.4',
      }),
    });
    assert.equal(createRes.statusCode, 201);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/runtime-codex',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        providerProfileId: 'claude-oauth',
      }),
    });
    assert.equal(patchRes.statusCode, 400);
    const patchBody = JSON.parse(patchRes.body);
    assert.match(patchBody.error, /provider "claude-oauth" not found/i);
  });

  it('POST /api/cats allows api_key bindings with different protocol than client default', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('../dist/config/provider-profiles.js');
    const crossProtocolProfile = await createProviderProfile(projectRoot, {
      displayName: 'OpenAI Key Profile',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.bound.example',
      apiKey: 'sk-bound-openai',
      models: ['openai/claude-sonnet-4-6'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        catId: 'runtime-opencode-crossproto',
        name: '运行时金渐层',
        displayName: '运行时金渐层',
        avatar: '/avatars/opencode.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@runtime-opencode-crossproto'],
        roleDescription: '审查',
        client: 'opencode',
        providerProfileId: crossProtocolProfile.id,
        defaultModel: 'openai/claude-sonnet-4-6',
      }),
    });

    assert.equal(createRes.statusCode, 201, 'cross-protocol api_key binding should be allowed');
  });

  it('POST /api/cats allows opencode model without providerId/ prefix (soft hint only)', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('../dist/config/provider-profiles.js');
    const openaiProfile = await createProviderProfile(projectRoot, {
      displayName: 'OpenAI Key Profile',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.bound.example',
      apiKey: 'sk-bound-openai',
      models: ['gpt-5.4'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        catId: 'runtime-opencode-bare-model',
        name: '运行时金渐层',
        displayName: '运行时金渐层',
        avatar: '/avatars/opencode.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@runtime-opencode-bare-model'],
        roleDescription: '审查',
        client: 'opencode',
        providerProfileId: openaiProfile.id,
        defaultModel: 'gpt-5.4',
      }),
    });

    // Bare model is accepted with a soft hint (console.warn), not rejected.
    assert.equal(createRes.statusCode, 201);
  });

  it('POST /api/cats rejects catId values that are not lowercase-safe identifiers', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        catId: '__proto__',
        name: '危险 ID',
        displayName: '危险 ID',
        avatar: '/avatars/runtime.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@danger'],
        roleDescription: '审查',
        client: 'openai',
        providerProfileId: 'codex',
        defaultModel: 'gpt-5.4',
      }),
    });

    assert.equal(createRes.statusCode, 400);
    const createBody = JSON.parse(createRes.body);
    assert.equal(createBody.error, 'Invalid request');
    assert.ok(
      createBody.details.some(
        (issue) =>
          Array.isArray(issue.path) &&
          issue.path.includes('catId') &&
          /catId must use lowercase letters/i.test(String(issue.message)),
      ),
      'expected catId validation issue in details',
    );
  });

  it('POST /api/cats rejects builtin bindings from the wrong client family even when protocol matches', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const cases = [
      {
        catId: 'runtime-dare-wrong-builtin',
        client: 'dare',
        providerProfileId: 'codex',
        defaultModel: 'gpt-5.4',
      },
      {
        catId: 'runtime-opencode-wrong-builtin',
        client: 'opencode',
        providerProfileId: 'claude',
        defaultModel: 'claude-sonnet-4-6',
      },
    ];

    for (const spec of cases) {
      const createRes = await app.inject({
        method: 'POST',
        url: '/api/cats',
        headers: {
          'content-type': 'application/json',
          'x-cat-cafe-user': 'codex',
        },
        body: JSON.stringify({
          catId: spec.catId,
          name: spec.catId,
          displayName: spec.catId,
          avatar: '/avatars/runtime.png',
          color: { primary: '#0f172a', secondary: '#e2e8f0' },
          mentionPatterns: [`@${spec.catId}`],
          roleDescription: '审查',
          client: spec.client,
          providerProfileId: spec.providerProfileId,
          defaultModel: spec.defaultModel,
        }),
      });

      assert.equal(createRes.statusCode, 400);
      const createBody = JSON.parse(createRes.body);
      assert.match(createBody.error, new RegExp(`incompatible with client "${spec.client}"`, 'i'));
    }
  });

  it('POST /api/cats rejects non-builtin provider bindings for google client', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('../dist/config/provider-profiles.js');
    const apiKeyProfile = await createProviderProfile(projectRoot, {
      displayName: 'Gemini Proxy',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://proxy.example/openrouter',
      apiKey: 'sk-openrouter-proxy',
      models: ['openrouter/google/gemini-3-flash-preview'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        catId: 'runtime-gemini-non-builtin',
        name: 'runtime-gemini-non-builtin',
        displayName: 'runtime-gemini-non-builtin',
        avatar: '/avatars/runtime.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@runtime-gemini-non-builtin'],
        roleDescription: '审查',
        client: 'google',
        providerProfileId: apiKeyProfile.id,
        defaultModel: 'openrouter/google/gemini-3-flash-preview',
      }),
    });

    assert.equal(createRes.statusCode, 400);
    const createBody = JSON.parse(createRes.body);
    assert.match(createBody.error, /only supports builtin Gemini auth/i);
  });

  it('PATCH /api/cats/:id rejects models that are not available on the bound provider profile', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('../dist/config/provider-profiles.js');
    const boundProfile = await createProviderProfile(projectRoot, {
      displayName: 'Scoped OpenAI Profile',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.scoped.example',
      apiKey: 'sk-scoped-openai',
      models: ['gpt-5.4-mini'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        catId: 'runtime-codex-scoped-profile',
        name: '运行时缅因猫',
        displayName: '运行时缅因猫',
        avatar: '/avatars/codex.png',
        color: { primary: '#16a34a', secondary: '#bbf7d0' },
        mentionPatterns: ['@runtime-codex-scoped-profile'],
        roleDescription: '审查',
        client: 'openai',
        providerProfileId: boundProfile.id,
        defaultModel: 'gpt-5.4-mini',
      }),
    });
    assert.equal(createRes.statusCode, 201);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/runtime-codex-scoped-profile',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        defaultModel: 'gpt-5.4',
      }),
    });

    assert.equal(patchRes.statusCode, 400);
    const patchBody = JSON.parse(patchRes.body);
    assert.match(patchBody.error, /model "gpt-5\.4" is not available on provider "scoped-openai-profile"/i);
  });

  it('PATCH /api/cats/:id validates seed model edits against the active bootstrap account', async () => {
    const projectRoot = createProjectRootFromRepoTemplate();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { bootstrapCatCatalog } = await import('../dist/config/cat-catalog-store.js');
    const { activateProviderProfile, createProviderProfile } = await import('../dist/config/provider-profiles.js');
    bootstrapCatCatalog(projectRoot, process.env.CAT_TEMPLATE_PATH);
    const sponsorProfile = await createProviderProfile(projectRoot, {
      displayName: 'Codex Sponsor',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.codex-sponsor.example',
      apiKey: 'sk-codex-sponsor',
      models: ['gpt-5.4-mini'],
    });
    await activateProviderProfile(projectRoot, 'openai', sponsorProfile.id);

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/codex',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        defaultModel: 'gpt-5.4-mini',
      }),
    });

    assert.equal(patchRes.statusCode, 200);
    const patchBody = JSON.parse(patchRes.body);
    assert.equal(patchBody.cat.defaultModel, 'gpt-5.4-mini');
    assert.equal(patchBody.cat.accountRef, sponsorProfile.id);
  });

  it('PATCH /api/cats/:id allows non-provider edits for unbound opencode seed member', async () => {
    if (savedTemplatePath === undefined) {
      delete process.env.CAT_TEMPLATE_PATH;
    } else {
      process.env.CAT_TEMPLATE_PATH = savedTemplatePath;
    }

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/cats/opencode',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        nickname: '金渐层审计版',
      }),
    });
    assert.equal(res.statusCode, 200);
  });

  it('PATCH /api/cats/:id returns 400 when runtime catalog validation rejects the update', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        catId: 'runtime-review-bot',
        name: '运行时审查猫',
        displayName: '运行时审查猫',
        avatar: '/avatars/review.png',
        color: { primary: '#334155', secondary: '#cbd5e1' },
        mentionPatterns: ['@runtime-review-bot'],
        roleDescription: '审查',
        client: 'openai',
        accountRef: 'codex',
        defaultModel: 'gpt-5.4',
      }),
    });
    assert.equal(createRes.statusCode, 201);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/runtime-review-bot',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        mentionPatterns: ['@runtime-review-bot', '@opus'],
      }),
    });
    assert.equal(patchRes.statusCode, 400);
    const patchBody = JSON.parse(patchRes.body);
    assert.match(patchBody.error, /@opus.*opus/i);
  });

  it('POST /api/cats still requires a concrete provider binding for dare and opencode clients', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        catId: 'runtime-dare',
        name: '运行时审计猫',
        displayName: '运行时审计猫',
        avatar: '/avatars/dare.png',
        color: { primary: '#0f172a', secondary: '#cbd5e1' },
        mentionPatterns: ['@runtime-dare'],
        roleDescription: '审计',
        client: 'dare',
        defaultModel: 'dare-1',
      }),
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.match(body.error, /requires a provider binding/i);
  });

  it('PATCH /api/cats/:id persists roster availability toggles for existing members', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const disableRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/opus',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        available: false,
      }),
    });

    assert.equal(disableRes.statusCode, 200);
    const disableBody = JSON.parse(disableRes.body);
    assert.equal(disableBody.cat.roster.available, false);

    const enableRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/opus',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        available: true,
      }),
    });

    assert.equal(enableRes.statusCode, 200);
    const enableBody = JSON.parse(enableRes.body);
    assert.equal(enableBody.cat.roster.available, true);
  });

  it('DELETE /api/cats/:id removes runtime session-strategy override for deleted cat', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        catId: 'runtime-strategy-cat',
        name: '策略猫',
        displayName: '策略猫',
        avatar: '/avatars/strategy.png',
        color: { primary: '#155e75', secondary: '#a5f3fc' },
        mentionPatterns: ['@runtime-strategy-cat'],
        roleDescription: '策略验证',
        client: 'openai',
        accountRef: 'codex',
        defaultModel: 'gpt-5.4',
      }),
    });
    assert.equal(createRes.statusCode, 201);

    await setRuntimeOverride('runtime-strategy-cat', {
      strategy: 'compress',
      thresholds: { warn: 0.55, action: 0.8 },
    });
    assert.ok(getRuntimeOverride('runtime-strategy-cat'));

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/api/cats/runtime-strategy-cat',
      headers: { 'x-cat-cafe-user': 'codex' },
    });
    assert.equal(deleteRes.statusCode, 200);
    assert.equal(getRuntimeOverride('runtime-strategy-cat'), undefined);
  });

  it('DELETE /api/cats/:id removes runtime members from subsequent reads', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        catId: 'runtime-temp',
        name: '临时猫',
        displayName: '临时猫',
        avatar: '/avatars/temp.png',
        color: { primary: '#64748b', secondary: '#cbd5e1' },
        mentionPatterns: ['@runtime-temp'],
        roleDescription: '临时成员',
        personality: '临时',
        client: 'openai',
        accountRef: 'codex',
        defaultModel: 'gpt-5.4',
        mcpSupport: false,
        cli: { command: 'codex', outputFormat: 'json' },
      }),
    });
    assert.equal(createRes.statusCode, 201);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/api/cats/runtime-temp',
      headers: {
        'x-cat-cafe-user': 'codex',
      },
    });
    assert.equal(deleteRes.statusCode, 200);

    const listRes = await app.inject({ method: 'GET', url: '/api/cats' });
    const listBody = JSON.parse(listRes.body);
    assert.equal(
      listBody.cats.some((cat) => cat.id === 'runtime-temp'),
      false,
    );
  });

  it('DELETE /api/cats/:id blocks deletion for seed members', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/api/cats/opus',
      headers: {
        'x-cat-cafe-user': 'codex',
      },
    });
    assert.equal(deleteRes.statusCode, 409);
    const deleteBody = JSON.parse(deleteRes.body);
    assert.match(deleteBody.error, /cannot delete seed cat/i);

    const listRes = await app.inject({ method: 'GET', url: '/api/cats' });
    assert.equal(listRes.statusCode, 200);
    const listBody = JSON.parse(listRes.body);
    assert.equal(
      listBody.cats.some((cat) => cat.id === 'opus'),
      true,
    );
  });
});
