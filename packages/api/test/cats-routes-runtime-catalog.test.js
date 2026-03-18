import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

const tempDirs = [];
let savedTemplatePath;

function makeCatalog(catId, displayName, provider = 'openai', defaultModel = 'gpt-5.4') {
  return {
    version: 1,
    breeds: [
      {
        id: `${catId}-breed`,
        catId,
        name: displayName,
        displayName,
        avatar: `/avatars/${catId}.png`,
        color: { primary: '#334155', secondary: '#cbd5e1' },
        mentionPatterns: [`@${catId}`],
        roleDescription: 'runtime cat',
        defaultVariantId: `${catId}-default`,
        variants: [
          {
            id: `${catId}-default`,
            provider,
            defaultModel,
            mcpSupport: provider !== 'antigravity',
            cli: { command: provider === 'antigravity' ? 'antigravity' : 'codex', outputFormat: 'json' },
          },
        ],
      },
    ],
  };
}

function makeVersion2Config(catId, displayName, options = {}) {
  const provider = options.provider ?? 'openai';
  const defaultModel = options.defaultModel ?? 'gpt-5.4';
  const evaluation = options.evaluation ?? `${displayName} evaluation`;
  return {
    version: 2,
    breeds: makeCatalog(catId, displayName, provider, defaultModel).breeds,
    roster: {
      [catId]: {
        family: options.family ?? 'maine-coon',
        roles: options.roles ?? ['peer-reviewer'],
        lead: options.lead ?? false,
        available: options.available ?? true,
        evaluation,
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

function createRuntimeCatalogProject(catalog, template = makeCatalog('template-cat', '模板猫')) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cats-route-runtime-'));
  tempDirs.push(projectRoot);
  writeFileSync(join(projectRoot, 'cat-template.json'), JSON.stringify(template, null, 2));
  mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
  writeFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(catalog, null, 2));
  return projectRoot;
}

describe('cats routes read runtime catalog', { concurrency: false }, () => {
  beforeEach(() => {
    savedTemplatePath = process.env.CAT_TEMPLATE_PATH;
  });

  afterEach(() => {
    if (savedTemplatePath === undefined) {
      delete process.env.CAT_TEMPLATE_PATH;
    } else {
      process.env.CAT_TEMPLATE_PATH = savedTemplatePath;
    }
  });

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET /api/cats returns cats from runtime catalog even when not in catRegistry', async () => {
    const projectRoot = createRuntimeCatalogProject(makeCatalog('runtime-cat', '运行时猫'));
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/cats' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const runtimeCat = body.cats.find((cat) => cat.id === 'runtime-cat');
    assert.ok(runtimeCat, 'runtime-cat should come from runtime catalog');
    assert.equal(runtimeCat.displayName, '运行时猫');
    assert.deepEqual(runtimeCat.mentionPatterns, ['@runtime-cat']);
  });

  it('GET /api/cats annotates seed/runtime source and roster metadata', async () => {
    const templateConfig = makeVersion2Config('template-cat', '模板猫', {
      family: 'ragdoll',
      roles: ['architect', 'peer-reviewer'],
      lead: true,
      evaluation: 'seed lead',
      provider: 'anthropic',
      defaultModel: 'claude-opus-4-6',
    });
    const runtimeCatalog = {
      ...templateConfig,
      breeds: [...templateConfig.breeds, ...makeCatalog('runtime-cat', '运行时猫').breeds],
    };
    const projectRoot = createRuntimeCatalogProject(runtimeCatalog, templateConfig);
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/cats' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    const seedCat = body.cats.find((cat) => cat.id === 'template-cat');
    assert.ok(seedCat, 'template-cat should be listed');
    assert.equal(seedCat.source, 'seed');
    assert.deepEqual(seedCat.roster, {
      family: 'ragdoll',
      roles: ['architect', 'peer-reviewer'],
      lead: true,
      available: true,
      evaluation: 'seed lead',
    });

    const runtimeCat = body.cats.find((cat) => cat.id === 'runtime-cat');
    assert.ok(runtimeCat, 'runtime-cat should be listed');
    assert.equal(runtimeCat.source, 'runtime');
    assert.equal(runtimeCat.roster, null);
  });

  it('GET /api/cats/:id/status resolves runtime-only Antigravity cats', async () => {
    const projectRoot = createRuntimeCatalogProject(makeCatalog('runtime-antigravity', '运行时桥接猫', 'antigravity', 'gemini-bridge'));
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/cats/runtime-antigravity/status' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.id, 'runtime-antigravity');
    assert.equal(body.displayName, '运行时桥接猫');
  });
});
