import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const tempDirs = [];
let savedTemplatePath;
let savedGlobalRoot;

function makeCatalog(catId, displayName, clientId = 'openai', defaultModel = 'gpt-5.4') {
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
            clientId,
            defaultModel,
            mcpSupport: clientId !== 'antigravity',
            cli: { command: clientId === 'antigravity' ? 'antigravity' : 'codex', outputFormat: 'json' },
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
    coCreator: {
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

function createTemplateOnlyProject(template) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cats-route-template-'));
  tempDirs.push(projectRoot);
  writeFileSync(join(projectRoot, 'cat-template.json'), JSON.stringify(template, null, 2));
  return projectRoot;
}

function createMonorepoTemplateOnlyProject(template) {
  const projectRoot = createTemplateOnlyProject(template);
  writeFileSync(join(projectRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  return projectRoot;
}

function loadRepoTemplate() {
  return JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'cat-template.json'), 'utf-8'));
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
  dare: 'dare',
  opencode: 'opencode',
};

function seedCatalogFromTemplate(projectRoot, templateObj) {
  const template = templateObj || JSON.parse(readFileSync(join(projectRoot, 'cat-template.json'), 'utf-8'));
  const catalogPath = join(projectRoot, '.cat-cafe', 'cat-catalog.json');
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
  } catch {
    catalog = {};
  }
  // Use version from template or existing catalog; ensure required v2 fields are present.
  const version = template.version ?? catalog.version ?? 1;
  const breeds = structuredClone(template.breeds || []);
  for (const breed of breeds) {
    for (const variant of breed.variants || []) {
      if (!variant.accountRef && variant.clientId && BUILTIN_ACCOUNT_IDS[variant.clientId]) {
        variant.accountRef = BUILTIN_ACCOUNT_IDS[variant.clientId];
      }
    }
  }
  const roster = template.roster ?? catalog.roster ?? {};
  const reviewPolicy = template.reviewPolicy ??
    catalog.reviewPolicy ?? {
      requireDifferentFamily: true,
      preferActiveInThread: true,
      preferLead: true,
      excludeUnavailable: true,
    };
  const seeded =
    version >= 2
      ? { version, breeds, roster, reviewPolicy, ...(template.coCreator ? { coCreator: template.coCreator } : {}) }
      : { version, breeds };
  mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
  writeFileSync(catalogPath, `${JSON.stringify(seeded, null, 2)}\n`, 'utf-8');
}

describe('cats routes read runtime catalog', { concurrency: false }, () => {
  beforeEach(() => {
    savedTemplatePath = process.env.CAT_TEMPLATE_PATH;
    savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  });

  afterEach(() => {
    if (savedTemplatePath === undefined) {
      delete process.env.CAT_TEMPLATE_PATH;
    } else {
      process.env.CAT_TEMPLATE_PATH = savedTemplatePath;
    }
    if (savedGlobalRoot === undefined) {
      delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    } else {
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
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

  it('GET /api/cat-templates returns template cats even when runtime catalog has additional members', async () => {
    const templateConfig = makeVersion2Config('template-cat', '模板猫', {
      family: 'ragdoll',
      roles: ['architect'],
      lead: true,
      evaluation: 'template-evaluation',
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

    const res = await app.inject({ method: 'GET', url: '/api/cat-templates' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.templates), 'templates should be an array');
    assert.equal(body.templates.length, 1);
    // Legacy fallback (breeds path, no roleTemplates) returns breed.id — makeCatalog()
    // sets breed id to '${catId}-breed', so the expected id here is 'template-cat-breed'.
    assert.equal(body.templates[0].id, 'template-cat-breed');
    // The legacy breeds path does not include source or roster in the response.
    assert.equal(body.templates[0].name, '模板猫');

    await app.close();
  });

  it('GET /api/cats returns roster metadata without source field', async () => {
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

    const templateCat = body.cats.find((cat) => cat.id === 'template-cat');
    assert.ok(templateCat, 'template-cat should be listed');
    assert.equal(templateCat.source, undefined);
    assert.deepEqual(templateCat.roster, {
      family: 'ragdoll',
      roles: ['architect', 'peer-reviewer'],
      lead: true,
      available: true,
      evaluation: 'seed lead',
    });

    const runtimeCat = body.cats.find((cat) => cat.id === 'runtime-cat');
    assert.ok(runtimeCat, 'runtime-cat should be listed');
    assert.equal(runtimeCat.source, undefined);
    assert.equal(runtimeCat.roster, null);
  });

  it('GET /api/cats bootstraps the runtime catalog before the first read', async () => {
    const codexTemplate = makeCatalog('codex', 'Codex');
    const dareTemplate = makeCatalog('dare', 'Dare', 'dare', 'glm-4.7');
    const antigravityTemplate = makeCatalog('antigravity', 'Antigravity', 'antigravity', 'gemini-bridge');
    const opencodeTemplate = makeCatalog('opencode', 'OpenCode', 'opencode', 'claude-opus-4-6');
    const template = {
      version: 1,
      breeds: [
        ...codexTemplate.breeds,
        ...dareTemplate.breeds,
        ...antigravityTemplate.breeds,
        ...opencodeTemplate.breeds,
      ],
    };
    const projectRoot = createTemplateOnlyProject(template);
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    await app.register(catsRoutes);

    const res = await app.inject({ method: 'GET', url: '/api/cats' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    // GET /api/cats merges catRegistry (seeded from the global test template) with the
    // project-local runtime catalog — so the response may include cats beyond the
    // local template.  Assert that the four locally-bootstrapped cats ARE present.
    const catIds = body.cats.map((cat) => cat.id);
    for (const expected of ['codex', 'dare', 'antigravity', 'opencode']) {
      assert.ok(catIds.includes(expected), `first read should include bootstrapped cat "${expected}"`);
    }

    // F171: bootstrapCatCatalog now creates an EMPTY catalog (first-run quest).
    // The catalog file has breeds: [] — cats are served from catRegistry + lazy first-run setup.
    const runtimeCatalog = JSON.parse(readFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), 'utf-8'));
    assert.ok(Array.isArray(runtimeCatalog.breeds), 'bootstrapped runtime catalog should have a breeds array');

    await app.close();
  });

  it('GET /api/cats falls back to the readable active project root when CAT_TEMPLATE_PATH is stale', async () => {
    const localTemplate = makeCatalog('local-template', '本地模板猫');
    const projectRoot = createMonorepoTemplateOnlyProject(localTemplate);
    // F171: bootstrap now creates empty catalogs — pre-seed so the local cat is visible.
    seedCatalogFromTemplate(projectRoot, localTemplate);
    const staleRoot = mkdtempSync(join(tmpdir(), 'cats-route-catalog-stale-'));
    tempDirs.push(staleRoot);
    const previousCwd = process.cwd();
    process.chdir(projectRoot);
    process.env.CAT_TEMPLATE_PATH = join(staleRoot, 'missing-template.json');

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');

    const app = Fastify();
    try {
      await app.register(catsRoutes);

      const res = await app.inject({ method: 'GET', url: '/api/cats' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      const localTemplateCat = body.cats.find((cat) => cat.id === 'local-template');
      assert.ok(
        localTemplateCat,
        'GET /api/cats should read the local project template when CAT_TEMPLATE_PATH is stale',
      );
      assert.equal(localTemplateCat.source, undefined);
      assert.equal(
        readFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), 'utf-8').includes('local-template'),
        true,
      );
    } finally {
      process.chdir(previousCwd);
      await app.close();
    }
  });

  it('GET /api/cats resolves seed accountRef from well-known account ID', async () => {
    const repoTemplate = loadRepoTemplate();
    const projectRoot = createTemplateOnlyProject(repoTemplate);
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;

    const { bootstrapCatCatalog } = await import('../dist/config/cat-catalog-store.js');
    const { writeCatalogAccount } = await import('../dist/config/catalog-accounts.js');
    const { writeCredential } = await import('../dist/config/credentials.js');
    bootstrapCatCatalog(projectRoot, process.env.CAT_TEMPLATE_PATH);
    // F171: bootstrap creates empty catalog — seed breeds so codex appears as 'seed'.
    seedCatalogFromTemplate(projectRoot, repoTemplate);
    // clowder-ai#340: Custom accounts require well-known ID or explicit accountRef binding.
    // Overwrite the 'codex' well-known account with an api_key sponsor account.
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

    const res = await app.inject({ method: 'GET', url: '/api/cats' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const codex = body.cats.find((cat) => cat.id === 'codex');
    assert.ok(codex, 'codex should be listed');
    assert.equal(codex.source, undefined);
    assert.equal(codex.accountRef, 'codex');

    await app.close();
  });

  it('GET /api/cats/:id/status resolves runtime-only Antigravity cats', async () => {
    const projectRoot = createRuntimeCatalogProject(
      makeCatalog('runtime-antigravity', '运行时桥接猫', 'antigravity', 'gemini-bridge'),
    );
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
