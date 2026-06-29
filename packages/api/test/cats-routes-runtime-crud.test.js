import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { catRegistry, createCatId } from '@cat-cafe/shared';
import './helpers/setup-cat-registry.js';

const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
const { _clearRuntimeOverrides, getRuntimeOverride, setRuntimeOverride } = await import(
  '../dist/config/session-strategy-overrides.js'
);
const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

const tempDirs = [];
let savedTemplatePath;

function resetRegistryToBuiltins() {
  catRegistry.reset();
  const allConfigs = toAllCatConfigs(loadCatConfig());
  for (const [id, config] of Object.entries(allConfigs)) {
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
            clientId: 'anthropic',
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

/**
 * F171: bootstrapCatCatalog() now creates empty catalogs (first-run quest).
 * Pre-write a catalog with breeds from the template so tests that operate on
 * template cats still find them. Stamps default accountRef.
 */
const BUILTIN_ACCOUNT_IDS = {
  anthropic: 'claude',
  openai: 'codex',
  google: 'gemini',
  kimi: 'kimi',
  opencode: 'opencode',
};

function seedCatalogFromTemplate(projectRoot, templatePath) {
  const tpl = templatePath || join(projectRoot, 'cat-template.json');
  const template = JSON.parse(readFileSync(tpl, 'utf-8'));
  for (const breed of template.breeds || []) {
    for (const variant of breed.variants || []) {
      if (!variant.accountRef && variant.clientId && BUILTIN_ACCOUNT_IDS[variant.clientId]) {
        variant.accountRef = BUILTIN_ACCOUNT_IDS[variant.clientId];
      }
    }
  }
  const catCafeDir = join(projectRoot, '.cat-cafe');
  mkdirSync(catCafeDir, { recursive: true });
  writeFileSync(join(catCafeDir, 'cat-catalog.json'), `${JSON.stringify(template, null, 2)}\n`, 'utf-8');
}

function createProjectRoot() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cats-route-crud-'));
  tempDirs.push(projectRoot);
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;
  writeFileSync(join(projectRoot, 'cat-template.json'), JSON.stringify(makeTemplate(), null, 2));
  seedCatalogFromTemplate(projectRoot);
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
  const templateDest = join(projectRoot, 'cat-template.json');
  const repoTemplate = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'cat-template.json'), 'utf-8'));
  writeFileSync(templateDest, JSON.stringify(repoTemplate, null, 2));
  seedCatalogFromTemplate(projectRoot, templateDest);
  process.env.CAT_TEMPLATE_PATH = templateDest;
  return projectRoot;
}

describe('cats routes runtime CRUD', { concurrency: false }, () => {
  /** @type {string | undefined} */ let savedGlobalRoot;
  /** @type {string | undefined} */ let savedConfigRoot;

  beforeEach(() => {
    savedTemplatePath = process.env.CAT_TEMPLATE_PATH;
    savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    savedConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    resetRegistryToBuiltins();
    _clearRuntimeOverrides();
  });

  afterEach(() => {
    if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
    if (savedConfigRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
    else process.env.CAT_CAFE_CONFIG_ROOT = savedConfigRoot;
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
        clientId: 'openai',
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
    assert.equal(createdBody.cat.clientId, 'openai');

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
        accountRef: 'codex',
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
        accountRef: null,
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

  it('POST /api/cats persists structured cli.effort for Codex members', async () => {
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
        catId: 'runtime-codex-effort',
        name: '运行时缅因猫',
        displayName: '运行时缅因猫',
        avatar: '/avatars/codex.png',
        color: { primary: '#16a34a', secondary: '#bbf7d0' },
        mentionPatterns: ['@runtime-codex-effort'],
        roleDescription: '审查',
        clientId: 'openai',
        accountRef: 'codex',
        defaultModel: 'gpt-5.4',
        cli: { command: 'codex', outputFormat: 'json', effort: 'xhigh' },
      }),
    });
    assert.equal(createRes.statusCode, 201);
    const createdBody = JSON.parse(createRes.body);
    assert.equal(createdBody.cat.cli?.effort, 'xhigh');

    const listRes = await app.inject({ method: 'GET', url: '/api/cats' });
    assert.equal(listRes.statusCode, 200);
    const listBody = JSON.parse(listRes.body);
    const runtimeCat = listBody.cats.find((cat) => cat.id === 'runtime-codex-effort');
    assert.ok(runtimeCat, 'runtime-codex-effort should appear in /api/cats');
    assert.equal(runtimeCat.cli?.effort, 'xhigh');

    const catalogPath = join(projectRoot, '.cat-cafe', 'cat-catalog.json');
    const persisted = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    const variant = persisted.breeds.find((breed) => breed.catId === 'runtime-codex-effort')?.variants?.[0];
    assert.equal(variant?.cli?.effort, 'xhigh');
  });

  it('POST /api/cats rejects illegal provider/effort combinations', async () => {
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
        catId: 'runtime-invalid-effort',
        name: '非法缅因猫',
        displayName: '非法缅因猫',
        avatar: '/avatars/codex.png',
        color: { primary: '#16a34a', secondary: '#bbf7d0' },
        mentionPatterns: ['@runtime-invalid-effort'],
        roleDescription: '审查',
        clientId: 'openai',
        accountRef: 'codex',
        defaultModel: 'gpt-5.4',
        cli: { command: 'codex', outputFormat: 'json', effort: 'max' },
      }),
    });

    assert.equal(createRes.statusCode, 400);
    assert.match(JSON.parse(createRes.body).error, /effort/i);
  });

  it('POST /api/cats accepts kimi client with first-class default CLI commands', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    try {
      const kimiRes = await app.inject({
        method: 'POST',
        url: '/api/cats',
        headers: {
          'content-type': 'application/json',
          'x-cat-cafe-user': 'codex',
        },
        body: JSON.stringify({
          catId: 'runtime-kimi',
          name: 'Kimi 猫',
          displayName: 'Kimi 猫',
          avatar: '/avatars/kimi.png',
          color: { primary: '#7c3aed', secondary: '#ede9fe' },
          mentionPatterns: ['@runtime-kimi'],
          roleDescription: '中文代码助手',
          clientId: 'kimi',
          accountRef: 'kimi',
          defaultModel: 'kimi-k2.5',
        }),
      });
      assert.equal(kimiRes.statusCode, 201);

      const catalog = JSON.parse(readFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), 'utf-8'));
      const breeds = catalog.breeds;
      const kimiVariant = breeds.find((breed) => breed.catId === 'runtime-kimi')?.variants?.[0];

      assert.equal(kimiVariant.clientId, 'kimi');
      assert.deepEqual(kimiVariant.cli, { command: 'kimi', outputFormat: 'stream-json' });
      assert.equal(kimiVariant.accountRef, 'kimi');
    } finally {
      await app.close();
    }
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
          clientId: 'openai',
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
        clientId: 'antigravity',
        defaultModel: 'gemini-bridge',
        commandArgs: ['chat', '--mode', 'agent'],
      }),
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.cat.id, 'runtime-antigravity');
    assert.equal(body.cat.clientId, 'antigravity');
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
        clientId: 'antigravity',
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

  it('POST /api/cats defaults mcpSupport=true for Codex/Gemini/ACP clients when omitted', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const acpProfile = await createProviderProfile(projectRoot, {
      displayName: 'Default ACP',
      authType: 'api_key',
      protocol: 'openai',
      apiKey: 'sk-default-acp',
      models: ['test-model'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    for (const spec of [
      { catId: 'runtime-openai', clientId: 'openai', accountRef: 'codex', model: 'gpt-5.4' },
      { catId: 'runtime-gemini', clientId: 'google', accountRef: 'gemini', model: 'gemini-2.5-pro' },
      {
        catId: 'runtime-acp',
        clientId: 'acp',
        accountRef: acpProfile.id,
        model: 'test-model',
        acp: { command: 'test-cli', startupArgs: ['--acp'] },
      },
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
          clientId: spec.clientId,
          accountRef: spec.accountRef,
          defaultModel: spec.model,
          ...(spec.acp ? { acp: spec.acp } : {}),
        }),
      });

      assert.equal(res.statusCode, 201);
      const body = JSON.parse(res.body);
      assert.equal(body.cat.id, spec.catId);
      assert.equal(body.cat.mcpSupport, true);
    }
  });

  it('POST /api/cats extends MCP blockedCats when a tool is disabled for all existing members', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');
    const { readCapabilitiesConfig, writeCapabilitiesConfig } = await import(
      '../dist/config/capabilities/capability-orchestrator.js'
    );
    await writeCapabilitiesConfig(projectRoot, {
      version: 2,
      capabilities: [
        {
          id: 'project-disabled-tool',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'external',
          mcpServer: { command: 'echo', args: [] },
          blockedCats: ['opus'],
        },
        {
          id: 'enabled-tool',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          source: 'external',
          mcpServer: { command: 'echo', args: [] },
          blockedCats: [],
        },
      ],
    });

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
        catId: 'runtime-codex-blocked',
        name: 'Runtime Codex Blocked',
        displayName: 'Runtime Codex Blocked',
        avatar: '/avatars/runtime.png',
        color: { primary: '#334155', secondary: '#cbd5e1' },
        mentionPatterns: ['@runtime-codex-blocked'],
        roleDescription: 'runtime',
        clientId: 'openai',
        accountRef: 'codex',
        defaultModel: 'gpt-5.4',
      }),
    });

    assert.equal(res.statusCode, 201, `create failed: ${res.body}`);
    const config = await readCapabilitiesConfig(projectRoot);
    const projectDisabledTool = config?.capabilities.find((cap) => cap.id === 'project-disabled-tool');
    const enabledTool = config?.capabilities.find((cap) => cap.id === 'enabled-tool');
    assert.deepEqual(projectDisabledTool?.blockedCats, ['opus', 'runtime-codex-blocked']);
    assert.deepEqual(enabledTool?.blockedCats, []);
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
        clientId: 'openai',
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
        accountRef: 'claude-oauth',
      }),
    });
    assert.equal(patchRes.statusCode, 400);
    const patchBody = JSON.parse(patchRes.body);
    assert.match(patchBody.error, /provider "claude-oauth" not found/i);
  });

  it('POST /api/cats allows api_key bindings with different protocol than client default', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
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
        clientId: 'opencode',
        accountRef: crossProtocolProfile.id,
        defaultModel: 'openai/claude-sonnet-4-6',
        provider: 'openai',
      }),
    });

    assert.equal(createRes.statusCode, 201, 'cross-protocol api_key binding should be allowed');
  });

  it('POST /api/cats allows cross-protocol binding after protocol retirement (#329)', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const openaiAccount = await createProviderProfile(projectRoot, {
      displayName: 'MiniMax OpenAI',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.minimaxi.com/v1',
      apiKey: 'sk-test-minimax',
      models: ['MiniMax-M2.7'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    // Protocol validation removed (#329): protocol is provider-determined,
    // not an account attribute. Cross-protocol binding is now allowed.
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        catId: 'runtime-minimax-cross-protocol',
        name: '跨协议绑定猫',
        displayName: '跨协议绑定猫',
        avatar: '/avatars/test.png',
        color: { primary: '#ff0000', secondary: '#ffcccc' },
        mentionPatterns: ['@cross-protocol-test'],
        roleDescription: '测试用',
        clientId: 'anthropic',
        accountRef: openaiAccount.id,
        defaultModel: 'MiniMax-M2.7',
      }),
    });

    assert.equal(createRes.statusCode, 201, 'cross-protocol binding should be allowed after protocol retirement');
  });

  it('POST /api/cats strips trailing slash from model name', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    await createProviderProfile(projectRoot, {
      displayName: 'Anthropic Key',
      authType: 'api_key',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-test-anthropic',
      models: ['claude-opus-4-6'],
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
        catId: 'runtime-trailing-slash',
        name: '尾斜杠测试猫',
        displayName: '尾斜杠测试猫',
        avatar: '/avatars/test.png',
        color: { primary: '#00ff00', secondary: '#ccffcc' },
        mentionPatterns: ['@slash-test'],
        roleDescription: '测试用',
        clientId: 'anthropic',
        accountRef: 'anthropic-key',
        defaultModel: 'claude-opus-4-6/',
      }),
    });

    assert.equal(createRes.statusCode, 201, 'should accept model with trailing slash (stripped)');
    const body = JSON.parse(createRes.body);
    assert.equal(body.cat.defaultModel, 'claude-opus-4-6', 'trailing slash should be stripped');
  });

  it('POST /api/cats rejects pure-slash model name', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    await createProviderProfile(projectRoot, {
      displayName: 'Anthropic Key',
      authType: 'api_key',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-test-anthropic',
      models: ['claude-opus-4-6'],
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
        catId: 'runtime-pure-slash',
        name: '纯斜杠测试猫',
        displayName: '纯斜杠测试猫',
        avatar: '/avatars/test.png',
        color: { primary: '#ff0000', secondary: '#ffcccc' },
        mentionPatterns: ['@pure-slash'],
        roleDescription: '测试用',
        clientId: 'anthropic',
        accountRef: 'anthropic-key',
        defaultModel: '/',
      }),
    });

    assert.equal(createRes.statusCode, 400, 'pure slash model should be rejected');
  });

  it('POST /api/cats opencode+api_key: provider/model is primary, provider is legacy fallback', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;
    const { createProviderProfile } = await import('./helpers/create-test-account.js');
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

    // Case 1a: bare model with recognizable prefix (gpt-*) → 201 (provider inferred)
    const bareInferred = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'oc-bare-inferred',
        name: '金渐层A',
        displayName: '金渐层A',
        avatar: '/avatars/opencode.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@oc-bare-inferred'],
        roleDescription: '审查',
        clientId: 'opencode',
        accountRef: openaiProfile.id,
        defaultModel: 'gpt-5.4',
      }),
    });
    assert.equal(bareInferred.statusCode, 201, 'bare gpt-* model → provider inferred as openai → 201');

    // Case 1b: bare model with unrecognizable name → 400 (cannot infer provider)
    const bareReject = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'oc-bare-unknown',
        name: '金渐层A2',
        displayName: '金渐层A2',
        avatar: '/avatars/opencode.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@oc-bare-unknown'],
        roleDescription: '审查',
        clientId: 'opencode',
        accountRef: openaiProfile.id,
        defaultModel: 'custom-llm-v3',
      }),
    });
    assert.equal(bareReject.statusCode, 400, 'bare unrecognizable model → 400');
    assert.match(JSON.parse(bareReject.body).error, /provider/i);

    // Case 2: provider/model format WITHOUT provider → 201 (provider inferred from model)
    const slashAccept = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'oc-slash-no-provider',
        name: '金渐层B',
        displayName: '金渐层B',
        avatar: '/avatars/opencode.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@oc-slash-no-provider'],
        roleDescription: '审查',
        clientId: 'opencode',
        accountRef: openaiProfile.id,
        defaultModel: 'openai/gpt-5.4',
      }),
    });
    assert.equal(slashAccept.statusCode, 201, 'provider/model without provider → 201');

    // Case 3: bare model WITH provider → 201 (legacy fallback path)
    const bareAccept = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'oc-bare-with-provider',
        name: '金渐层C',
        displayName: '金渐层C',
        avatar: '/avatars/opencode.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@oc-bare-with-provider'],
        roleDescription: '审查',
        clientId: 'opencode',
        accountRef: openaiProfile.id,
        defaultModel: 'gpt-5.4',
        provider: 'openai',
      }),
    });
    assert.equal(bareAccept.statusCode, 201, 'bare model + provider → 201');

    // Case 4: trailing-slash model (normalized to bare by schema) → 201 if
    // the bare name is recognizable, 400 if not.
    // 'minimax/' → 'minimax' → inferred as minimax provider → 201
    const trailingSlashInferred = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'oc-trailing-slash',
        name: '金渐层D',
        displayName: '金渐层D',
        avatar: '/avatars/opencode.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@oc-trailing-slash'],
        roleDescription: '审查',
        clientId: 'opencode',
        accountRef: openaiProfile.id,
        defaultModel: 'minimax/',
      }),
    });
    assert.equal(
      trailingSlashInferred.statusCode,
      201,
      'trailing-slash → normalized bare model → provider inferred → 201',
    );

    // Case 4b: unrecognizable trailing-slash model → still 400
    const trailingSlashReject = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'oc-trailing-slash-unk',
        name: '金渐层D2',
        displayName: '金渐层D2',
        avatar: '/avatars/opencode.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@oc-trailing-slash-unk'],
        roleDescription: '审查',
        clientId: 'opencode',
        accountRef: openaiProfile.id,
        defaultModel: 'mystery-llm/',
      }),
    });
    assert.equal(trailingSlashReject.statusCode, 400, 'trailing-slash unrecognizable model → 400');

    // Case 5: namespaced model from account's model list WITHOUT provider → 400
    // "z-ai/glm-4.7" exists in account models → it's a model namespace, not provider/model
    const { createProviderProfile: createProfile2 } = await import('./helpers/create-test-account.js');
    const orProfile = await createProfile2(projectRoot, {
      displayName: 'OpenRouter Key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://openrouter.ai/api',
      apiKey: 'sk-or',
      models: ['z-ai/glm-4.7', 'z-ai/glm-4.6'],
    });
    const namespacedReject = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'oc-namespaced-no-provider',
        name: '金渐层E',
        displayName: '金渐层E',
        avatar: '/avatars/opencode.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@oc-namespaced-no-provider'],
        roleDescription: '审查',
        clientId: 'opencode',
        accountRef: orProfile.id,
        defaultModel: 'z-ai/glm-4.7',
      }),
    });
    assert.equal(namespacedReject.statusCode, 400, 'namespaced model from account model list without provider → 400');

    // Case 6: canonical provider/model that ALSO appears in account models → 201
    // minimax account stores both bare "MiniMax-M2.7" and canonical "minimax/MiniMax-M2.7"
    const { createProviderProfile: createProfile3 } = await import('./helpers/create-test-account.js');
    const mmProfile = await createProfile3(projectRoot, {
      displayName: 'MiniMax Key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.minimax.io/v1',
      apiKey: 'sk-mm',
      models: ['MiniMax-M2.7', 'minimax/MiniMax-M2.7'],
    });
    const canonicalAccept = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'oc-canonical-in-list',
        name: '金渐层F',
        displayName: '金渐层F',
        avatar: '/avatars/opencode.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@oc-canonical-in-list'],
        roleDescription: '审查',
        clientId: 'opencode',
        accountRef: mmProfile.id,
        defaultModel: 'minimax/MiniMax-M2.7',
      }),
    });
    assert.equal(
      canonicalAccept.statusCode,
      201,
      'canonical provider/model in account list (bare form also present) → 201',
    );

    // Case 7: canonical-only model list (no bare alias) WITHOUT provider → 201
    // Account stores only "openai/gpt-5.4" (no bare "gpt-5.4") — still canonical, not namespaced.
    // Distinguished from Case 5 by absence of sibling models sharing the same prefix.
    const { createProviderProfile: createProfile4 } = await import('./helpers/create-test-account.js');
    const canonicalOnlyProfile = await createProfile4(projectRoot, {
      displayName: 'Canonical-Only Key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.canonical.example',
      apiKey: 'sk-co',
      models: ['openai/gpt-5.4'],
    });
    const canonicalOnlyAccept = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'oc-canonical-only',
        name: '金渐层G',
        displayName: '金渐层G',
        avatar: '/avatars/opencode.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@oc-canonical-only'],
        roleDescription: '审查',
        clientId: 'opencode',
        accountRef: canonicalOnlyProfile.id,
        defaultModel: 'openai/gpt-5.4',
      }),
    });
    assert.equal(canonicalOnlyAccept.statusCode, 201, 'canonical-only model list (no bare alias, singleton) → 201');

    // Case 8: multi-model canonical provider list WITHOUT provider → 201
    // Account stores multiple models under the same known provider prefix.
    // Must NOT be confused with openrouter-style namespace siblings.
    const { createProviderProfile: createProfile5 } = await import('./helpers/create-test-account.js');
    const multiCanonicalProfile = await createProfile5(projectRoot, {
      displayName: 'Multi-Canonical Key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.openai.example',
      apiKey: 'sk-mc',
      models: ['openai/gpt-5.4', 'openai/gpt-4.1'],
    });
    const multiCanonicalAccept = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'oc-multi-canonical',
        name: '金渐层H',
        displayName: '金渐层H',
        avatar: '/avatars/opencode.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@oc-multi-canonical'],
        roleDescription: '审查',
        clientId: 'opencode',
        accountRef: multiCanonicalProfile.id,
        defaultModel: 'openai/gpt-5.4',
      }),
    });
    assert.equal(
      multiCanonicalAccept.statusCode,
      201,
      'multi-model canonical provider list (known prefix, siblings) → 201',
    );
  });

  it('clowder-ai#223 P1 regression: openrouter + foreign-prefix model preserves full model namespace', async () => {
    // Regression test for: provider=openrouter + defaultModel=z-ai/glm-4.7
    // The model's first segment "z-ai" is NOT the provider prefix — it is the
    // model's namespace within OpenRouter. stripOwnProviderPrefix must keep it.
    const { deriveOpenCodeApiType, generateOpenCodeRuntimeConfig } = await import(
      '../dist/domains/cats/services/agents/providers/opencode-config-template.js'
    );

    // Replicate invoke-single-cat.ts logic: stripOwnProviderPrefix + ensureModelInList
    const ocProviderName = 'openrouter';
    const defaultModel = 'z-ai/glm-4.7';
    const bareModel = defaultModel.startsWith(`${ocProviderName}/`)
      ? defaultModel.slice(ocProviderName.length + 1)
      : defaultModel;
    const assembledModel = `${ocProviderName}/${bareModel}`;

    // bareModel should be the full "z-ai/glm-4.7" (not stripped to "glm-4.7")
    assert.equal(bareModel, 'z-ai/glm-4.7', 'foreign-prefix model should not be stripped');
    assert.equal(assembledModel, 'openrouter/z-ai/glm-4.7', 'assembled model preserves full namespace');

    // ensureModelInList: bare model should be in the list
    const accountModels = ['z-ai/glm-4.7'];
    const hasModel = accountModels.includes(bareModel) || accountModels.includes(defaultModel);
    assert.ok(hasModel, 'models list should include the bare model');

    // Generate config and verify model key matches
    const config = generateOpenCodeRuntimeConfig({
      providerName: ocProviderName,
      models: accountModels,
      defaultModel: assembledModel,
      apiType: 'openai',
    });
    assert.equal(config.model, 'openrouter/z-ai/glm-4.7');
    assert.ok(config.provider.openrouter.models['z-ai/glm-4.7'], 'config models key matches the model namespace');

    // Also test: same-provider prefix IS stripped (no double-prefix)
    const sameProviderModel = 'openrouter/google/gemini-3-flash';
    const sameBare = sameProviderModel.startsWith(`${ocProviderName}/`)
      ? sameProviderModel.slice(ocProviderName.length + 1)
      : sameProviderModel;
    assert.equal(sameBare, 'google/gemini-3-flash', 'same-provider prefix is correctly stripped');
    assert.equal(`${ocProviderName}/${sameBare}`, 'openrouter/google/gemini-3-flash', 'no double-prefix');

    // P1 regression: ensureModelInList must replace prefixed form with bare, not early-return
    const prefixedModels = ['openrouter/google/gemini-3-flash', 'other-model'];
    const ensuredBare = sameBare; // google/gemini-3-flash
    // Simulate ensureModelInList logic: bare not in list, but prefixed IS → replace
    const hasBare = prefixedModels.includes(ensuredBare);
    assert.equal(hasBare, false, 'bare model is NOT in prefixed list');
    assert.ok(prefixedModels.includes(sameProviderModel), 'prefixed form IS in list');
    const corrected = prefixedModels.map((m) => (m === sameProviderModel ? ensuredBare : m));
    assert.deepEqual(corrected, ['google/gemini-3-flash', 'other-model'], 'prefixed form replaced with bare');

    // Verify config uses corrected models
    const correctedConfig = generateOpenCodeRuntimeConfig({
      providerName: ocProviderName,
      models: corrected,
      defaultModel: `${ocProviderName}/${ensuredBare}`,
      apiType: 'openai',
    });
    assert.ok(correctedConfig.provider.openrouter.models['google/gemini-3-flash'], 'bare key in config');
    assert.equal(
      correctedConfig.provider.openrouter.models['openrouter/google/gemini-3-flash'],
      undefined,
      'prefixed key NOT in config',
    );
  });

  it('clowder-ai#223 P1 regression: apiType derived solely from providerName (protocol retired)', async () => {
    // deriveOpenCodeApiType now only uses providerName; account-level protocol
    // is no longer consulted. This test verifies the new single-source behavior.
    const { deriveOpenCodeApiType } = await import(
      '../dist/domains/cats/services/agents/providers/opencode-config-template.js'
    );

    const scenarios = [
      { ocProviderName: 'maas', expected: 'openai' },
      { ocProviderName: 'deepseek', expected: 'openai' },
      { ocProviderName: 'anthropic', expected: 'anthropic' },
      { ocProviderName: 'google', expected: 'google' },
      { ocProviderName: 'openrouter', expected: 'openai' },
      { ocProviderName: 'openai-responses', expected: 'openai-responses' },
      { ocProviderName: undefined, expected: 'openai' },
    ];

    for (const { ocProviderName, expected } of scenarios) {
      const apiType = deriveOpenCodeApiType(ocProviderName);
      assert.equal(apiType, expected, `ocProviderName=${ocProviderName} → ${expected}`);
    }
  });

  it('clowder-ai#223 legacy compat: PATCH allows editing an opencode+api_key member without provider', async () => {
    // Regression: legacy opencode+api_key configs created before clowder-ai#223 have no
    // provider. Editing these members (e.g. changing defaultModel) must not
    // fail validation. The invoke path skips the clowder-ai#223 config block when absent.
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const legacyProfile = await createProviderProfile(projectRoot, {
      displayName: 'Legacy MaaS Key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.legacy-maas.example',
      apiKey: 'sk-legacy-maas',
      models: ['glm-5', 'glm-4-plus'],
    });

    // Create the cat directly via createRuntimeCat (bypasses POST validation)
    // to simulate a legacy config without provider.
    const { createRuntimeCat } = await import('../dist/config/runtime-cat-catalog.js');
    createRuntimeCat(projectRoot, {
      catId: 'legacy-oc-member',
      name: '旧金渐层',
      displayName: '旧金渐层',
      avatar: '/avatars/opencode.png',
      color: { primary: '#0f172a', secondary: '#e2e8f0' },
      mentionPatterns: ['@legacy-oc'],
      roleDescription: '测试',
      clientId: 'opencode',
      accountRef: legacyProfile.id,
      defaultModel: 'glm-5',
      mcpSupport: false,
      cli: { command: 'opencode', outputFormat: 'text' },
      // No provider (model provider name) — this is the legacy state
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    // PATCH with defaultModel change — triggers providerConfigTouched
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/legacy-oc-member',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({ defaultModel: 'glm-4-plus' }),
    });
    assert.equal(patchRes.statusCode, 200, 'legacy member model edit should succeed without provider');

    // Editor always sends accountRef even when unchanged — must still succeed
    const editorPatchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/legacy-oc-member',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({ defaultModel: 'glm-4-plus', accountRef: legacyProfile.id }),
    });
    assert.equal(editorPatchRes.statusCode, 200, 'unchanged accountRef in PATCH should not defeat legacy compat');

    // But switching accountRef on a legacy member WITHOUT provider must be rejected —
    // a new binding requires provider.
    const { createProviderProfile: createProfile2 } = await import('./helpers/create-test-account.js');
    const newProfile = await createProfile2(projectRoot, {
      displayName: 'New DeepSeek Key',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.example',
      apiKey: 'sk-deepseek',
      models: ['deepseek-r2'],
    });

    const switchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/legacy-oc-member',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({ accountRef: newProfile.id }),
    });
    assert.equal(switchRes.statusCode, 400, 'switching account on legacy member without provider should be rejected');
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
        clientId: 'openai',
        accountRef: 'codex',
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
        catId: 'runtime-opencode-wrong-builtin',
        clientId: 'opencode',
        accountRef: 'claude',
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
          clientId: spec.clientId,
          accountRef: spec.accountRef,
          defaultModel: spec.defaultModel,
        }),
      });

      assert.equal(createRes.statusCode, 400);
      const createBody = JSON.parse(createRes.body);
      assert.match(createBody.error, new RegExp(`incompatible with client "${spec.clientId}"`, 'i'));
    }
  });

  it('POST /api/cats allows third-party gateway bindings for google client', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
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
        clientId: 'google',
        accountRef: apiKeyProfile.id,
        defaultModel: 'openrouter/google/gemini-3-flash-preview',
      }),
    });

    assert.equal(createRes.statusCode, 201);
  });

  it('POST /api/cats rejects official Google endpoints for google api_key bindings', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const apiKeyProfile = await createProviderProfile(projectRoot, {
      displayName: 'Gemini Official API',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'sk-google-official',
      models: ['gemini-2.5-pro'],
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
        catId: 'runtime-gemini-official-api',
        name: 'runtime-gemini-official-api',
        displayName: 'runtime-gemini-official-api',
        avatar: '/avatars/runtime.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@runtime-gemini-official-api'],
        roleDescription: '审查',
        clientId: 'google',
        accountRef: apiKeyProfile.id,
        defaultModel: 'gemini-2.5-pro',
      }),
    });

    assert.equal(createRes.statusCode, 400);
    const createBody = JSON.parse(createRes.body);
    assert.match(createBody.error, /requires builtin OAuth for official Google endpoints/i);
  });

  it('POST /api/cats rejects malformed third-party gateway baseUrl for google client', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const apiKeyProfile = await createProviderProfile(projectRoot, {
      displayName: 'Gemini Broken Proxy',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'not-a-valid-url',
      apiKey: 'sk-broken-proxy',
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
        catId: 'runtime-gemini-broken-proxy',
        name: 'runtime-gemini-broken-proxy',
        displayName: 'runtime-gemini-broken-proxy',
        avatar: '/avatars/runtime.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@runtime-gemini-broken-proxy'],
        roleDescription: '审查',
        clientId: 'google',
        accountRef: apiKeyProfile.id,
        defaultModel: 'openrouter/google/gemini-3-flash-preview',
      }),
    });

    assert.equal(createRes.statusCode, 400);
    const createBody = JSON.parse(createRes.body);
    assert.match(createBody.error, /requires a valid baseUrl/i);
  });

  it('PATCH /api/cats/:id validates seed model edits against the active bootstrap account', async () => {
    const projectRoot = createProjectRootFromRepoTemplate();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { bootstrapCatCatalog } = await import('../dist/config/cat-catalog-store.js');
    const { writeCatalogAccount } = await import('../dist/config/catalog-accounts.js');
    const { writeCredential } = await import('../dist/config/credentials.js');
    bootstrapCatCatalog(projectRoot, process.env.CAT_TEMPLATE_PATH);
    // clowder-ai#340: Overwrite the 'codex' well-known account with an api_key sponsor
    writeCatalogAccount(projectRoot, 'codex', {
      authType: 'api_key',
      baseUrl: 'https://api.codex-sponsor.example',
      models: ['gpt-5.4-mini'],
      displayName: 'Codex Sponsor',
    });
    writeCredential('codex', { apiKey: 'sk-codex-sponsor' });

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
    assert.equal(patchBody.cat.accountRef, 'codex');
  });

  it('PATCH /api/cats/:id rebases inherited seed binding when switching client families', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    const beforeRes = await app.inject({ method: 'GET', url: '/api/cats' });
    assert.equal(beforeRes.statusCode, 200);
    const beforeBody = JSON.parse(beforeRes.body);
    const opusBefore = beforeBody.cats.find((cat) => cat.id === 'opus');
    assert.ok(opusBefore, 'seed opus member must exist');
    assert.equal(opusBefore.clientId, 'anthropic');
    assert.equal(opusBefore.accountRef, 'claude');
    assert.equal(opusBefore.mcpSupport, true, 'seed builtin client starts with MCP support enabled');

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/opus',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      // Simulate editor payload carrying the previous visible accountRef while switching client.
      body: JSON.stringify({
        clientId: 'openai',
        defaultModel: 'gpt-5.4',
        accountRef: opusBefore.accountRef,
      }),
    });

    assert.equal(patchRes.statusCode, 200);
    const patchBody = JSON.parse(patchRes.body);
    assert.equal(patchBody.cat.clientId, 'openai');
    assert.equal(patchBody.cat.defaultModel, 'gpt-5.4');
    assert.equal(patchBody.cat.accountRef, 'codex');
  });

  it('PATCH /api/cats/:id preserves builtin accountRef when switching to generic ACP', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    const beforeRes = await app.inject({ method: 'GET', url: '/api/cats' });
    assert.equal(beforeRes.statusCode, 200);
    const beforeBody = JSON.parse(beforeRes.body);
    const opusBefore = beforeBody.cats.find((cat) => cat.id === 'opus');
    assert.ok(opusBefore, 'seed opus member must exist');
    assert.equal(opusBefore.clientId, 'anthropic');
    assert.equal(opusBefore.accountRef, 'claude');

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/opus',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      // Generic ACP is a transport: switching to it must keep the selected account
      // instead of rebasing the old builtin accountRef to a nonexistent "acp" account.
      body: JSON.stringify({
        clientId: 'acp',
        defaultModel: 'acp-model',
        accountRef: opusBefore.accountRef,
        acp: { command: 'custom-acp-agent', startupArgs: ['--acp'] },
      }),
    });

    assert.equal(patchRes.statusCode, 200, `generic ACP switch should keep account binding: ${patchRes.body}`);
    const patchBody = JSON.parse(patchRes.body);
    assert.equal(patchBody.cat.clientId, 'acp');
    assert.equal(patchBody.cat.accountRef, 'claude');
    assert.equal(patchBody.cat.provider, undefined);
    assert.equal(
      patchBody.cat.mcpSupport,
      true,
      'generic ACP switch without explicit mcpSupport or whitelist must default MCP support on',
    );

    const afterRes = await app.inject({ method: 'GET', url: '/api/cats' });
    const afterBody = JSON.parse(afterRes.body);
    const opusAfter = afterBody.cats.find((cat) => cat.id === 'opus');
    assert.equal(opusAfter.mcpSupport, true, 'GET should confirm generic ACP migration is MCP-on by default');
  });

  it('PATCH /api/cats/:id resets stale CLI config when switching client families', async () => {
    const projectRoot = createProjectRootFromRepoTemplate();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    // First, set a non-default CLI config (including effort) on opus (anthropic)
    const firstPatchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/opus',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        cli: {
          command: 'claude',
          outputFormat: 'stream-json',
          effort: 'low', // Non-default for anthropic (default is 'max')
        },
      }),
    });

    assert.equal(firstPatchRes.statusCode, 200);

    // Verify the non-default effort was persisted
    let runtimeCatalog = JSON.parse(readFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), 'utf-8'));
    let opusBreed = runtimeCatalog.breeds.find((breed) => breed.catId === 'opus');
    let opusVariant = opusBreed.variants.find((variant) => variant.id === opusBreed.defaultVariantId);
    assert.equal(opusVariant.cli.effort, 'low', 'non-default effort should be persisted');

    // Now switch to openai provider
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/opus',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({
        clientId: 'openai',
        defaultModel: 'gpt-5.4',
      }),
    });

    assert.equal(patchRes.statusCode, 200);
    const patchBody = JSON.parse(patchRes.body);
    assert.equal(patchBody.cat.clientId, 'openai');
    assert.equal(patchBody.cat.defaultModel, 'gpt-5.4');

    // Verify CLI was reset to openai defaults (including effort)
    runtimeCatalog = JSON.parse(readFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), 'utf-8'));
    opusBreed = runtimeCatalog.breeds.find((breed) => breed.catId === 'opus');
    opusVariant = opusBreed.variants.find((variant) => variant.id === opusBreed.defaultVariantId);
    assert.ok(opusVariant, 'runtime opus default variant should exist');
    assert.deepEqual(
      opusVariant.cli,
      {
        command: 'codex',
        outputFormat: 'json',
        effort: 'xhigh', // Reset to openai's default
      },
      'CLI should be reset to openai defaults including effort',
    );
  });

  it('PATCH /api/cats/:id allows non-provider edits for unbound opencode seed member', async () => {
    const projectRoot = createProjectRootFromRepoTemplate();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

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
        clientId: 'openai',
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

  it('POST /api/cats still requires a concrete provider binding for opencode clients', async () => {
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
        catId: 'runtime-opencode',
        name: '运行时编码猫',
        displayName: '运行时编码猫',
        avatar: '/avatars/opencode.png',
        color: { primary: '#0f172a', secondary: '#cbd5e1' },
        mentionPatterns: ['@runtime-opencode'],
        roleDescription: '编码',
        clientId: 'opencode',
        defaultModel: 'claude-opus-4-6',
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
        clientId: 'openai',
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
        clientId: 'openai',
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

  it('POST and PATCH /api/cats preserve editable variant labels', async () => {
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
        catId: 'runtime-variant',
        name: '运行时缅因猫',
        displayName: '缅因猫',
        variantLabel: 'GPT-5.5',
        avatar: '/avatars/codex.png',
        color: { primary: '#16a34a', secondary: '#bbf7d0' },
        mentionPatterns: ['@runtime-variant'],
        roleDescription: '代码审查',
        personality: '严谨',
        clientId: 'openai',
        accountRef: 'codex',
        defaultModel: 'gpt-5.5',
        mcpSupport: true,
        cli: { command: 'codex', outputFormat: 'json' },
      }),
    });
    assert.equal(createRes.statusCode, 201);
    assert.equal(JSON.parse(createRes.body).cat.variantLabel, 'GPT-5.5');

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/runtime-variant',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({ variantLabel: 'GPT-5.6' }),
    });
    assert.equal(patchRes.statusCode, 200);
    assert.equal(JSON.parse(patchRes.body).cat.variantLabel, 'GPT-5.6');

    const clearRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/runtime-variant',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      body: JSON.stringify({ variantLabel: null }),
    });
    assert.equal(clearRes.statusCode, 200);
    assert.equal(JSON.parse(clearRes.body).cat.variantLabel, undefined);
  });

  it('DELETE /api/cats/:id allows deletion of any member', async () => {
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
    assert.equal(deleteRes.statusCode, 200);
    const deleteBody = JSON.parse(deleteRes.body);
    assert.equal(deleteBody.deleted, true);

    const listRes = await app.inject({ method: 'GET', url: '/api/cats' });
    assert.equal(listRes.statusCode, 200);
    const listBody = JSON.parse(listRes.body);
    assert.equal(
      listBody.cats.some((cat) => cat.id === 'opus'),
      false,
    );
  });

  // ── F161: Generic ACP client route tests ─────────────────────────────────

  it('POST /api/cats creates generic ACP member with acp config', async () => {
    const projectRoot = createMonorepoProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const acpProfile = await createProviderProfile(projectRoot, {
      displayName: 'DeepSeek ACP',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-deepseek-xxx',
      models: ['deepseek-chat'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    const acpConfig = {
      command: 'deepseek-cli',
      startupArgs: ['--acp'],
      mcpWhitelist: ['cat-cafe-memory'],
      pool: { maxLiveProcesses: 2, idleTtlMs: 1_800_000 },
    };

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'acp-deepseek',
        name: 'DeepSeek ACP',
        displayName: 'DeepSeek ACP',
        avatar: '/avatars/default.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@acp-deepseek'],
        roleDescription: 'ACP agent',
        clientId: 'acp',
        accountRef: acpProfile.id,
        defaultModel: 'deepseek-chat',
        acp: acpConfig,
      }),
    });

    assert.equal(createRes.statusCode, 201, `Expected 201 but got ${createRes.statusCode}: ${createRes.body}`);
    const body = JSON.parse(createRes.body);
    assert.equal(body.cat.adapterMode, 'acp', 'generic ACP member should have adapterMode=acp');
    assert.equal(
      body.cat.mcpSupport,
      true,
      'generic ACP member should enable MCP support when an explicit MCP whitelist is provided',
    );
    assert.deepEqual(body.cat.acp, acpConfig, 'ACP response should include editable non-secret transport config');

    const listRes = await app.inject({ method: 'GET', url: '/api/cats' });
    assert.equal(listRes.statusCode, 200, `Expected GET 200 but got ${listRes.statusCode}: ${listRes.body}`);
    const listBody = JSON.parse(listRes.body);
    const listed = listBody.cats.find((cat) => cat.id === 'acp-deepseek');
    assert.equal(listed.mcpSupport, true, 'GET /api/cats should preserve MCP support implied by the ACP whitelist');
    assert.deepEqual(listed.acp, acpConfig, 'GET /api/cats should include ACP config for Hub editing');
  });

  it('GET/PATCH /api/cats resolves ACP config from active project root, not CAT_TEMPLATE_PATH', async () => {
    const projectRoot = createMonorepoProjectRoot();
    process.env.CAT_CAFE_CONFIG_ROOT = projectRoot;
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const acpProfile = await createProviderProfile(projectRoot, {
      displayName: 'Active ACP',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.example.test',
      apiKey: 'sk-active',
      models: ['active-chat'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    const acpConfig = {
      command: 'active-acp',
      startupArgs: ['--serve'],
      mcpWhitelist: ['cat-cafe-memory'],
    };

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'acp-active-root',
        name: 'Active ACP',
        displayName: 'Active ACP',
        avatar: '/avatars/default.png',
        color: { primary: '#1f2937', secondary: '#f9fafb' },
        mentionPatterns: ['@acp-active-root'],
        roleDescription: 'ACP agent',
        clientId: 'acp',
        accountRef: acpProfile.id,
        defaultModel: 'active-chat',
        acp: acpConfig,
      }),
    });
    assert.equal(createRes.statusCode, 201, `Expected 201 but got ${createRes.statusCode}: ${createRes.body}`);

    const staleRoot = mkdtempSync(join(tmpdir(), 'cats-route-crud-stale-acp-'));
    tempDirs.push(staleRoot);
    writeFileSync(join(staleRoot, 'cat-template.json'), JSON.stringify(makeTemplate(), null, 2));
    process.env.CAT_TEMPLATE_PATH = join(staleRoot, 'cat-template.json');

    const listRes = await app.inject({ method: 'GET', url: '/api/cats' });
    assert.equal(listRes.statusCode, 200, `Expected GET 200 but got ${listRes.statusCode}: ${listRes.body}`);
    const listBody = JSON.parse(listRes.body);
    const listed = listBody.cats.find((cat) => cat.id === 'acp-active-root');
    assert.deepEqual(listed.acp, acpConfig, 'GET /api/cats should read ACP config from the active catalog');

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/acp-active-root',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({ displayName: 'Renamed ACP' }),
    });
    assert.equal(
      patchRes.statusCode,
      200,
      `PATCH without resending acp should use active catalog config: ${patchRes.body}`,
    );
    const patchBody = JSON.parse(patchRes.body);
    assert.equal(patchBody.cat.displayName, 'Renamed ACP');
    assert.deepEqual(patchBody.cat.acp, acpConfig, 'PATCH response should preserve active catalog ACP config');
  });

  it('POST /api/cats rejects generic ACP member without acp config', async () => {
    const projectRoot = createMonorepoProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const acpProfile = await createProviderProfile(projectRoot, {
      displayName: 'Bare ACP',
      authType: 'api_key',
      protocol: 'openai',
      apiKey: 'sk-bare',
      models: ['some-model'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'acp-bare',
        name: 'Bare ACP',
        displayName: 'Bare ACP',
        avatar: '/avatars/default.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@acp-bare'],
        roleDescription: 'ACP agent',
        clientId: 'acp',
        accountRef: acpProfile.id,
        defaultModel: 'some-model',
        // acp section deliberately omitted
      }),
    });

    assert.equal(createRes.statusCode, 400, 'clientId acp without acp config should be rejected');
  });

  it('POST /api/cats gates httpstream ACP transport behind explicit experimental opt-in', async () => {
    const projectRoot = createMonorepoProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const acpProfile = await createProviderProfile(projectRoot, {
      displayName: 'HTTP ACP',
      authType: 'api_key',
      protocol: 'openai',
      apiKey: 'sk-http',
      models: ['test-model'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    const baseBody = {
      name: 'HTTP ACP',
      displayName: 'HTTP ACP',
      avatar: '/avatars/default.png',
      color: { primary: '#0f172a', secondary: '#e2e8f0' },
      roleDescription: 'experimental ACP agent',
      clientId: 'acp',
      accountRef: acpProfile.id,
      defaultModel: 'test-model',
    };

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        ...baseBody,
        catId: 'acp-http-rejected',
        mentionPatterns: ['@acp-http-rejected'],
        acp: { command: 'http-acp', startupArgs: ['--serve'], transport: 'httpstream' },
      }),
    });
    assert.equal(rejected.statusCode, 400, 'httpstream without explicit experimental opt-in should be rejected');
    assert.match(JSON.stringify(JSON.parse(rejected.body).details), /experimental/i);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        ...baseBody,
        catId: 'acp-http-accepted',
        mentionPatterns: ['@acp-http-accepted'],
        acp: { command: 'http-acp', startupArgs: ['--serve'], transport: 'httpstream', experimental: true },
      }),
    });
    assert.equal(accepted.statusCode, 201, `experimental httpstream should be accepted: ${accepted.body}`);
    assert.deepEqual(JSON.parse(accepted.body).cat.acp, {
      command: 'http-acp',
      startupArgs: ['--serve'],
      transport: 'httpstream',
      experimental: true,
    });
  });

  it('PATCH /api/cats/:id rejects removing acp config from an ACP member', async () => {
    const projectRoot = createMonorepoProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const acpProfile = await createProviderProfile(projectRoot, {
      displayName: 'Patchable ACP',
      authType: 'api_key',
      protocol: 'openai',
      apiKey: 'sk-patch',
      models: ['test-model'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    // Step 1: Create ACP member
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'acp-patchable',
        name: 'Patchable ACP',
        displayName: 'Patchable ACP',
        avatar: '/avatars/default.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@acp-patchable'],
        roleDescription: 'ACP agent',
        clientId: 'acp',
        accountRef: acpProfile.id,
        defaultModel: 'test-model',
        acp: { command: 'test-cli', startupArgs: ['--acp'] },
      }),
    });
    assert.equal(createRes.statusCode, 201, `create failed: ${createRes.body}`);

    // Step 2: Try to remove acp config while clientId stays 'acp' → must 400
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/acp-patchable',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({ acp: null }),
    });
    assert.equal(patchRes.statusCode, 400, 'removing acp from ACP member should be rejected');

    // Step 3: Switch to non-ACP client + remove acp → must succeed
    const switchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/acp-patchable',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({ clientId: 'openai', accountRef: acpProfile.id, acp: null }),
    });
    assert.equal(switchRes.statusCode, 200, `client switch failed: ${switchRes.body}`);
    const switchBody = JSON.parse(switchRes.body);
    assert.equal(switchBody.cat.adapterMode, 'cli', 'after switch should be cli mode');
  });

  it('PATCH /api/cats/:id gates httpstream ACP transport behind explicit experimental opt-in', async () => {
    const projectRoot = createMonorepoProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const acpProfile = await createProviderProfile(projectRoot, {
      displayName: 'Patch HTTP ACP',
      authType: 'api_key',
      protocol: 'openai',
      apiKey: 'sk-patch-http',
      models: ['test-model'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'acp-patch-http',
        name: 'Patch HTTP ACP',
        displayName: 'Patch HTTP ACP',
        avatar: '/avatars/default.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@acp-patch-http'],
        roleDescription: 'ACP agent',
        clientId: 'acp',
        accountRef: acpProfile.id,
        defaultModel: 'test-model',
        acp: { command: 'test-cli', startupArgs: ['--acp'] },
      }),
    });
    assert.equal(createRes.statusCode, 201, `create failed: ${createRes.body}`);

    const rejected = await app.inject({
      method: 'PATCH',
      url: '/api/cats/acp-patch-http',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({ acp: { command: 'http-acp', startupArgs: ['--serve'], transport: 'httpstream' } }),
    });
    assert.equal(rejected.statusCode, 400, 'PATCH httpstream without opt-in should be rejected');
    assert.match(JSON.stringify(JSON.parse(rejected.body).details), /experimental/i);

    const accepted = await app.inject({
      method: 'PATCH',
      url: '/api/cats/acp-patch-http',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        acp: { command: 'http-acp', startupArgs: ['--serve'], transport: 'httpstream', experimental: true },
      }),
    });
    assert.equal(accepted.statusCode, 200, `experimental httpstream patch should be accepted: ${accepted.body}`);
    assert.equal(JSON.parse(accepted.body).cat.acp.experimental, true);
  });

  it('PATCH /api/cats/:id clears stale acp config when switching away from ACP without acp:null', async () => {
    const projectRoot = createMonorepoProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const acpProfile = await createProviderProfile(projectRoot, {
      displayName: 'ACP Switch',
      authType: 'api_key',
      protocol: 'openai',
      apiKey: 'sk-switch',
      models: ['test-model'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'acp-switch',
        name: 'ACP Switch',
        displayName: 'ACP Switch',
        avatar: '/avatars/default.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@acp-switch'],
        roleDescription: 'ACP agent',
        clientId: 'acp',
        accountRef: acpProfile.id,
        defaultModel: 'test-model',
        acp: { command: 'test-cli', startupArgs: ['--acp'] },
      }),
    });
    assert.equal(createRes.statusCode, 201, `create failed: ${createRes.body}`);

    const switchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/acp-switch',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        clientId: 'openai',
        accountRef: acpProfile.id,
        defaultModel: 'test-model',
      }),
    });
    assert.equal(switchRes.statusCode, 200, `client switch failed: ${switchRes.body}`);
    const switchBody = JSON.parse(switchRes.body);
    assert.equal(switchBody.cat.clientId, 'openai');
    assert.equal(switchBody.cat.adapterMode, 'cli', 'after switch should be cli mode');
    assert.equal(switchBody.cat.acp, undefined, 'response must not expose stale ACP config');

    const listRes = await app.inject({ method: 'GET', url: '/api/cats' });
    assert.equal(listRes.statusCode, 200, `Expected GET 200 but got ${listRes.statusCode}: ${listRes.body}`);
    const listBody = JSON.parse(listRes.body);
    const listed = listBody.cats.find((cat) => cat.id === 'acp-switch');
    assert.equal(listed.clientId, 'openai');
    assert.equal(listed.adapterMode, 'cli', 'listed cat should be cli mode after switch');
    assert.equal(listed.acp, undefined, 'catalog must not retain stale ACP config');
  });

  it('POST /api/cats strips provider for generic ACP (AC-A5/KD-1: acp is transport, not provider identity)', async () => {
    const projectRoot = createMonorepoProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const acpProfile = await createProviderProfile(projectRoot, {
      displayName: 'Kimi ACP',
      authType: 'api_key',
      protocol: 'openai',
      apiKey: 'sk-moonshot',
      models: ['kimi-k2'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'acp-kimi-noprovider',
        name: 'Kimi ACP',
        displayName: 'Kimi ACP',
        avatar: '/avatars/default.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@acp-kimi-noprovider'],
        roleDescription: 'ACP agent',
        clientId: 'acp',
        accountRef: acpProfile.id,
        defaultModel: 'kimi-k2',
        provider: 'anthropic', // must be stripped — generic ACP never carries provider
        acp: { command: 'kimi', startupArgs: ['acp'] },
      }),
    });
    assert.equal(createRes.statusCode, 201, `create failed: ${createRes.body}`);
    const created = JSON.parse(createRes.body);
    assert.equal(created.cat.provider, undefined, 'generic ACP must not persist provider on create');

    const listRes = await app.inject({ method: 'GET', url: '/api/cats' });
    const listed = JSON.parse(listRes.body).cats.find((cat) => cat.id === 'acp-kimi-noprovider');
    assert.equal(listed.provider, undefined, 'GET should confirm generic ACP has no persisted provider');
  });

  it('PATCH /api/cats/:id strips provider for generic ACP — stays transport-only', async () => {
    const projectRoot = createMonorepoProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const acpProfile = await createProviderProfile(projectRoot, {
      displayName: 'Patch ACP NoProvider',
      authType: 'api_key',
      protocol: 'openai',
      apiKey: 'sk-patch2',
      models: ['test-model'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'acp-patch-noprovider',
        name: 'Patch ACP',
        displayName: 'Patch ACP',
        avatar: '/avatars/default.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@acp-patch-noprovider'],
        roleDescription: 'ACP agent',
        clientId: 'acp',
        accountRef: acpProfile.id,
        defaultModel: 'test-model',
        acp: { command: 'test-cli', startupArgs: ['--acp'] },
      }),
    });
    assert.equal(createRes.statusCode, 201, `create failed: ${createRes.body}`);

    // Direct API PATCH tries to set a provider on a generic ACP member — must be stripped.
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/acp-patch-noprovider',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({ provider: 'anthropic' }),
    });
    assert.equal(patchRes.statusCode, 200, `patch failed: ${patchRes.body}`);
    const patched = JSON.parse(patchRes.body);
    assert.equal(patched.cat.provider, undefined, 'generic ACP must not persist provider on update');
  });

  it('PATCH /api/cats/:id enables MCP support when updating a generic ACP whitelist', async () => {
    const projectRoot = createMonorepoProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const acpProfile = await createProviderProfile(projectRoot, {
      displayName: 'Patch ACP Whitelist',
      authType: 'api_key',
      protocol: 'openai',
      apiKey: 'sk-patch-whitelist',
      models: ['test-model'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'acp-patch-whitelist',
        name: 'Patch ACP Whitelist',
        displayName: 'Patch ACP Whitelist',
        avatar: '/avatars/default.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@acp-patch-whitelist'],
        roleDescription: 'ACP agent',
        clientId: 'acp',
        accountRef: acpProfile.id,
        defaultModel: 'test-model',
        acp: { command: 'test-cli', startupArgs: ['--acp'] },
      }),
    });
    assert.equal(createRes.statusCode, 201, `create failed: ${createRes.body}`);
    assert.equal(JSON.parse(createRes.body).cat.mcpSupport, true, 'generic ACP without whitelist defaults MCP-on');

    const acpConfig = {
      command: 'test-cli',
      startupArgs: ['--acp'],
      mcpWhitelist: ['cat-cafe-memory'],
    };
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/acp-patch-whitelist',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({ acp: acpConfig }),
    });
    assert.equal(patchRes.statusCode, 200, `patch failed: ${patchRes.body}`);
    const patched = JSON.parse(patchRes.body);
    assert.equal(patched.cat.mcpSupport, true, 'ACP whitelist patch should imply MCP support');
    assert.deepEqual(patched.cat.acp, acpConfig, 'ACP whitelist patch should persist');

    const listRes = await app.inject({ method: 'GET', url: '/api/cats' });
    const listed = JSON.parse(listRes.body).cats.find((cat) => cat.id === 'acp-patch-whitelist');
    assert.equal(listed.mcpSupport, true, 'GET should confirm MCP support implied by patched whitelist');
  });

  it('PATCH /api/cats/:id preserves generic ACP MCP support on ACP-only edits without a whitelist', async () => {
    const projectRoot = createMonorepoProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const acpProfile = await createProviderProfile(projectRoot, {
      displayName: 'Patch ACP Preserve MCP',
      authType: 'api_key',
      protocol: 'openai',
      apiKey: 'sk-patch-preserve-mcp',
      models: ['test-model'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'acp-preserve-mcp',
        name: 'Patch ACP Preserve MCP',
        displayName: 'Patch ACP Preserve MCP',
        avatar: '/avatars/default.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@acp-preserve-mcp'],
        roleDescription: 'ACP agent',
        clientId: 'acp',
        accountRef: acpProfile.id,
        defaultModel: 'test-model',
        mcpSupport: true,
        acp: { command: 'test-cli', startupArgs: ['--acp'] },
      }),
    });
    assert.equal(createRes.statusCode, 201, `create failed: ${createRes.body}`);
    assert.equal(JSON.parse(createRes.body).cat.mcpSupport, true, 'explicit MCP support should persist on create');

    const commandOnlyAcpConfig = { command: 'test-cli', startupArgs: ['--acp', '--edited'] };
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/acp-preserve-mcp',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({ acp: commandOnlyAcpConfig }),
    });
    assert.equal(patchRes.statusCode, 200, `patch failed: ${patchRes.body}`);
    const patched = JSON.parse(patchRes.body);
    assert.equal(patched.cat.mcpSupport, true, 'ACP-only edit should preserve existing MCP support');
    assert.deepEqual(patched.cat.acp, commandOnlyAcpConfig, 'command-only ACP edit should persist');

    const listRes = await app.inject({ method: 'GET', url: '/api/cats' });
    const listed = JSON.parse(listRes.body).cats.find((cat) => cat.id === 'acp-preserve-mcp');
    assert.equal(listed.mcpSupport, true, 'GET should confirm ACP-only edit preserved MCP support');
  });

  it('PATCH /api/cats/:id resets generic ACP MCP support when replacing the whitelist with command-only config', async () => {
    const projectRoot = createMonorepoProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const acpProfile = await createProviderProfile(projectRoot, {
      displayName: 'Patch ACP Remove Whitelist',
      authType: 'api_key',
      protocol: 'openai',
      apiKey: 'sk-patch-remove-whitelist',
      models: ['test-model'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'acp-remove-whitelist',
        name: 'Patch ACP Remove Whitelist',
        displayName: 'Patch ACP Remove Whitelist',
        avatar: '/avatars/default.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@acp-remove-whitelist'],
        roleDescription: 'ACP agent',
        clientId: 'acp',
        accountRef: acpProfile.id,
        defaultModel: 'test-model',
        acp: {
          command: 'test-cli',
          startupArgs: ['--acp'],
          mcpWhitelist: ['cat-cafe-memory'],
        },
      }),
    });
    assert.equal(createRes.statusCode, 201, `create failed: ${createRes.body}`);
    assert.equal(JSON.parse(createRes.body).cat.mcpSupport, true, 'initial whitelist should imply MCP support');

    const commandOnlyAcpConfig = { command: 'test-cli', startupArgs: ['--acp', '--new-command'] };
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/acp-remove-whitelist',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({ acp: commandOnlyAcpConfig }),
    });
    assert.equal(patchRes.statusCode, 200, `patch failed: ${patchRes.body}`);
    const patched = JSON.parse(patchRes.body);
    assert.equal(patched.cat.mcpSupport, true, 'removing whitelist should preserve generic ACP MCP support');
    assert.deepEqual(patched.cat.acp, commandOnlyAcpConfig, 'command-only ACP patch should persist');

    const listRes = await app.inject({ method: 'GET', url: '/api/cats' });
    const listed = JSON.parse(listRes.body).cats.find((cat) => cat.id === 'acp-remove-whitelist');
    assert.equal(listed.mcpSupport, true, 'GET should confirm removed whitelist preserves MCP support');
  });

  it('PATCH /api/cats/:id clears stale provider when migrating opencode → generic ACP (covers the currentCat.provider != null clear branch)', async () => {
    // F161 R7 P3: the migration/stale path. A clientId=opencode member legitimately carries a
    // provider; migrating it to generic ACP (clientId=acp) must clear that stale provider
    // (provider:null) so it cannot leak into the ACP env-map. This is the exact path the
    // @acp-opencode runtime member takes. Locks cats.ts buildProviderPatch acp clear branch.
    const projectRoot = createMonorepoProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const { createProviderProfile } = await import('./helpers/create-test-account.js');
    const profile = await createProviderProfile(projectRoot, {
      displayName: 'OpenAI Key Profile',
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://api.bound.example',
      apiKey: 'sk-bound',
      models: ['openai/claude-sonnet-4-6'],
    });

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);

    // Step 1: create an opencode member that legitimately carries a provider.
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/cats',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        catId: 'migrate-oc-to-acp',
        name: 'Migrate OC',
        displayName: 'Migrate OC',
        avatar: '/avatars/default.png',
        color: { primary: '#0f172a', secondary: '#e2e8f0' },
        mentionPatterns: ['@migrate-oc-to-acp'],
        roleDescription: 'migration',
        clientId: 'opencode',
        accountRef: profile.id,
        defaultModel: 'openai/claude-sonnet-4-6',
        provider: 'openai',
      }),
    });
    assert.equal(createRes.statusCode, 201, `create failed: ${createRes.body}`);
    assert.equal(JSON.parse(createRes.body).cat.provider, 'openai', 'opencode should persist provider');

    // Step 2: migrate to generic ACP — the stale provider must be cleared (provider:null).
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/cats/migrate-oc-to-acp',
      headers: { 'content-type': 'application/json', 'x-cat-cafe-user': 'codex' },
      body: JSON.stringify({
        clientId: 'acp',
        accountRef: profile.id,
        acp: { command: 'opencode', startupArgs: ['acp', '--pure'] },
      }),
    });
    assert.equal(patchRes.statusCode, 200, `migration patch failed: ${patchRes.body}`);
    const patched = JSON.parse(patchRes.body);
    assert.equal(patched.cat.clientId, 'acp', 'should be generic ACP after migration');
    assert.equal(patched.cat.provider, undefined, 'stale provider must be cleared on migration to generic ACP');

    const listRes = await app.inject({ method: 'GET', url: '/api/cats' });
    const listed = JSON.parse(listRes.body).cats.find((cat) => cat.id === 'migrate-oc-to-acp');
    assert.equal(listed.provider, undefined, 'GET should confirm no stale provider remains after migration');
  });
});
