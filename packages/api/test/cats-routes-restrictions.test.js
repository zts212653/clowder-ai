import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import './helpers/setup-cat-registry.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';
import { selectFakeCodexHome } from './helpers/fake-codex-home.js';
import { readMemberRequestRevision } from './helpers/member-request-revision.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { loadCatConfig, loadResolvedCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

const BUILTIN_ACCOUNT_IDS = {
  anthropic: 'claude',
  openai: 'codex',
  google: 'gemini',
  kimi: 'kimi',
  opencode: 'opencode',
};

const tempDirs = [];

function resetRegistryToBuiltins() {
  catRegistry.reset();
  const allConfigs = toAllCatConfigs(loadCatConfig());
  for (const [id, config] of Object.entries(allConfigs)) {
    catRegistry.register(id, config);
  }
}

function createProjectFromRepoSiameseCatalog() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cats-route-restrictions-'));
  tempDirs.push(projectRoot);
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;
  const repoTemplate = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'cat-template.json'), 'utf-8'));
  const templateDest = join(projectRoot, 'cat-template.json');
  writeFileSync(templateDest, JSON.stringify(repoTemplate, null, 2));

  // Mirror real runtime catalog where siamese breed in cat-catalog.json omits restrictions
  // and relies on mergeTemplateWithCatalog(cat-template.json, cat-catalog.json).
  const siamese = structuredClone(repoTemplate.breeds.find((breed) => breed.id === 'siamese'));
  delete siamese.restrictions;
  delete siamese.caution;
  for (const variant of siamese.variants) {
    if (!variant.accountRef && variant.clientId && BUILTIN_ACCOUNT_IDS[variant.clientId]) {
      variant.accountRef = BUILTIN_ACCOUNT_IDS[variant.clientId];
    }
  }
  const catalog = {
    version: 2,
    breeds: [siamese],
    roster: {
      gemini: repoTemplate.roster.gemini,
      gemini25: repoTemplate.roster.gemini25,
    },
    reviewPolicy: repoTemplate.reviewPolicy,
    coCreator: repoTemplate.coCreator,
  };
  mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
  writeFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  selectFakeCodexHome(projectRoot);
  process.env.CAT_TEMPLATE_PATH = templateDest;
  return projectRoot;
}

describe('cats routes restrictions & siamese breed inheritance', { concurrency: false }, () => {
  let savedTemplatePath;
  let savedGlobalRoot;
  let savedConfigRoot;
  let savedCodexHome;
  let savedCodexSqliteHome;
  let restoreAuthEnvironment;

  beforeEach(() => {
    restoreAuthEnvironment = isolateAccountAuthEnvironment();
    savedTemplatePath = process.env.CAT_TEMPLATE_PATH;
    savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    savedConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    savedCodexHome = process.env.CODEX_HOME;
    savedCodexSqliteHome = process.env.CODEX_SQLITE_HOME;
    resetRegistryToBuiltins();
  });

  afterEach(() => {
    restoreAuthEnvironment();
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    if (savedCodexSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
    else process.env.CODEX_SQLITE_HOME = savedCodexSqliteHome;
    if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
    if (savedConfigRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
    else process.env.CAT_CAFE_CONFIG_ROOT = savedConfigRoot;
    if (savedTemplatePath === undefined) delete process.env.CAT_TEMPLATE_PATH;
    else process.env.CAT_TEMPLATE_PATH = savedTemplatePath;
    resetRegistryToBuiltins();
  });

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('new siamese member does not inherit 3.1-era "禁止写代码" restriction from cat-template.json', async () => {
    const projectRoot = createProjectFromRepoSiameseCatalog();
    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);
    const headers = { 'x-cat-cafe-user': 'default-user' };
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/cats',
        headers,
        payload: {
          catId: 'gemini-carbon',
          breedId: 'siamese',
          name: '暹罗猫 Gemini 4 Carbon',
          displayName: '暹罗猫',
          nickname: '烁烁',
          avatar: '/avatars/gemini.png',
          color: { primary: '#5B9BD5', secondary: '#D6E9F8' },
          mentionPatterns: ['@gemini-carbon'],
          roleDescription: '暹罗猫 Gemini 4 Carbon（烁烁），AGY Native 独立成员',
          clientId: 'openai',
          accountRef: 'codex',
          defaultModel: 'gpt-5.4',
          mcpSupport: true,
        },
      });
      assert.equal(created.statusCode, 201, created.payload);
      const resolved = toAllCatConfigs(loadResolvedCatConfig(join(projectRoot, 'cat-template.json')));
      assert.equal(resolved['gemini-carbon']?.restrictions, undefined);
      assert.deepStrictEqual(resolved.gemini?.restrictions, ['禁止写代码']);

      const createdCat = created.json().cat;
      assert.deepStrictEqual(createdCat.restrictions, []);
      assert.equal(createdCat.caution, null);
    } finally {
      await app.close();
    }
  });

  it('POST, GET, and PATCH manage member restrictions including explicit empty override over breed restrictions', async () => {
    const projectRoot = createProjectFromRepoSiameseCatalog();
    // Seed a breed with an explicit breed-level restriction to verify [] vs null semantics.
    const catalogPath = join(projectRoot, '.cat-cafe', 'cat-catalog.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    catalog.breeds.push({
      id: 'guarded-breed',
      catId: 'guarded-lead',
      name: '守门猫',
      displayName: '守门猫',
      avatar: '/avatars/default.png',
      color: { primary: '#334155', secondary: '#cbd5e1' },
      mentionPatterns: ['@guarded-lead'],
      roleDescription: '守门负责人',
      restrictions: ['禁止直接合入'],
      defaultVariantId: 'guarded-lead-default',
      variants: [
        {
          id: 'guarded-lead-default',
          clientId: 'openai',
          accountRef: 'codex',
          defaultModel: 'gpt-5.4',
          mcpSupport: true,
          cli: { command: 'codex', outputFormat: 'json' },
        },
      ],
    });
    catalog.roster['guarded-lead'] = {
      family: 'guarded-breed',
      roles: ['reviewer'],
      lead: true,
      available: true,
      evaluation: 'guarded lead',
    };
    writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

    const Fastify = (await import('fastify')).default;
    const { catsRoutes } = await import('../dist/routes/cats.js');
    const app = Fastify();
    await app.register(catsRoutes);
    const headers = { 'x-cat-cafe-user': 'default-user' };
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/cats',
        headers,
        payload: {
          catId: 'review-only-cat',
          breedId: 'siamese',
          name: '审阅猫',
          displayName: '审阅猫',
          avatar: '/avatars/default.png',
          color: { primary: '#5B9BD5', secondary: '#D6E9F8' },
          mentionPatterns: ['@review-only-cat'],
          roleDescription: '专注审查',
          restrictions: ['仅做审查，不写代码'],
          clientId: 'openai',
          accountRef: 'codex',
          defaultModel: 'gpt-5.4',
          mcpSupport: true,
        },
      });
      assert.equal(created.statusCode, 201, created.payload);
      assert.deepStrictEqual(created.json().cat.restrictions, ['仅做审查，不写代码']);
      assert.equal(created.json().cat.identitySources.restrictions, 'variant');

      // Guarded lead initially inherits ['禁止直接合入'] from breed.
      const listed = await app.inject({ method: 'GET', url: '/api/cats', headers });
      const guardedBefore = listed.json().cats.find((cat) => cat.id === 'guarded-lead');
      assert.deepStrictEqual(guardedBefore.restrictions, ['禁止直接合入']);
      assert.equal(guardedBefore.identitySources.restrictions, 'breed');

      // Explicit [] overrides breed-level restrictions cleanly.
      const clearedOverride = await app.inject({
        method: 'PATCH',
        url: '/api/cats/guarded-lead',
        headers,
        payload: {
          expectedRevision: await readMemberRequestRevision(app, '/api/cats/guarded-lead', headers),
          restrictions: [],
        },
      });
      assert.equal(clearedOverride.statusCode, 200, clearedOverride.payload);
      assert.deepStrictEqual(clearedOverride.json().cat.restrictions, []);
      assert.equal(clearedOverride.json().cat.identitySources.restrictions, 'variant');

      // Explicit non-empty array updates member restrictions.
      const updated = await app.inject({
        method: 'PATCH',
        url: '/api/cats/guarded-lead',
        headers,
        payload: {
          expectedRevision: await readMemberRequestRevision(app, '/api/cats/guarded-lead', headers),
          restrictions: ['禁止修改生产配置'],
        },
      });
      assert.equal(updated.statusCode, 200, updated.payload);
      assert.deepStrictEqual(updated.json().cat.restrictions, ['禁止修改生产配置']);

      // Explicit null removes variant override and restores breed inheritance.
      const restoredInheritance = await app.inject({
        method: 'PATCH',
        url: '/api/cats/guarded-lead',
        headers,
        payload: {
          expectedRevision: await readMemberRequestRevision(app, '/api/cats/guarded-lead', headers),
          restrictions: null,
        },
      });
      assert.equal(restoredInheritance.statusCode, 200, restoredInheritance.payload);
      assert.deepStrictEqual(restoredInheritance.json().cat.restrictions, ['禁止直接合入']);
      assert.equal(restoredInheritance.json().cat.identitySources.restrictions, 'breed');
    } finally {
      await app.close();
    }
  });
});
