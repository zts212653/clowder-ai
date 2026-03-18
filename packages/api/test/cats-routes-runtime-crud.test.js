import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { CAT_CONFIGS, catRegistry, createCatId } from '@cat-cafe/shared';

const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');

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
    owner: {
      name: 'Co-worker',
      aliases: ['共创伙伴'],
      mentionPatterns: ['@co-worker', '@owner'],
    },
  };
}

function createProjectRoot() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cats-route-crud-'));
  tempDirs.push(projectRoot);
  writeFileSync(join(projectRoot, 'cat-template.json'), JSON.stringify(makeTemplate(), null, 2));
  return projectRoot;
}

describe('cats routes runtime CRUD', { concurrency: false }, () => {
  beforeEach(() => {
    savedTemplatePath = process.env.CAT_TEMPLATE_PATH;
    resetRegistryToBuiltins();
  });

  afterEach(() => {
    if (savedTemplatePath === undefined) {
      delete process.env.CAT_TEMPLATE_PATH;
    } else {
      process.env.CAT_TEMPLATE_PATH = savedTemplatePath;
    }
    resetRegistryToBuiltins();
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
        providerProfileId: 'codex-oauth',
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
    assert.equal(clearProviderRes.statusCode, 200);

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
    assert.equal(runtimeCatAfterClear.providerProfileId, undefined);

    const mentions = parseA2AMentions('@运行时火花 请跟进这个分支', createCatId('opus'));
    assert.ok(mentions.includes('runtime-spark'), 'new alias should route immediately');
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

  it('PATCH /api/cats/:id rejects provider bindings incompatible with client protocol', async () => {
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
    assert.match(patchBody.error, /incompatible with client "openai"/i);
  });

  it('DELETE /api/cats/:id removes runtime members from subsequent reads', async () => {
    const projectRoot = createProjectRoot();
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    await app.inject({
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
        client: 'dare',
        defaultModel: 'dare-1',
        mcpSupport: false,
        cli: { command: 'dare', outputFormat: 'json' },
      }),
    });

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
    assert.equal(listBody.cats.some((cat) => cat.id === 'runtime-temp'), false);
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
    assert.equal(listBody.cats.some((cat) => cat.id === 'opus'), true);
  });
});
