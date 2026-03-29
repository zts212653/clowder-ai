import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('cat-catalog-store accounts section (HC-2)', () => {
  let projectRoot;
  let previousGlobalRoot;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'catalog-accounts-'));
    previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
  });

  afterEach(async () => {
    if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
    await rm(projectRoot, { recursive: true, force: true });
  });

  function makeCatalog(accounts) {
    return {
      version: 2,
      breeds: [],
      roster: {},
      reviewPolicy: {
        requireDifferentFamily: true,
        preferActiveInThread: true,
        preferLead: true,
        excludeUnavailable: true,
      },
      ...(accounts !== undefined ? { accounts } : {}),
    };
  }

  it('readCatCatalog returns accounts section when present', async () => {
    const { readCatCatalog, resolveCatCatalogPath } = await import('../dist/config/cat-catalog-store.js');
    const accounts = {
      claude: { authType: 'oauth', protocol: 'anthropic', models: ['claude-opus-4-6'] },
      'my-glm': { authType: 'api_key', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    };
    const catalog = makeCatalog(accounts);
    const catalogPath = resolveCatCatalogPath(projectRoot);
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2), 'utf-8');

    const loaded = readCatCatalog(projectRoot);
    assert.ok(loaded, 'catalog should be loaded');
    assert.equal(loaded.version, 2);
    assert.deepEqual(loaded.accounts, accounts);
  });

  it('readCatCatalog returns undefined accounts when section missing', async () => {
    const { readCatCatalog, resolveCatCatalogPath } = await import('../dist/config/cat-catalog-store.js');
    const catalog = makeCatalog();
    const catalogPath = resolveCatCatalogPath(projectRoot);
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2), 'utf-8');

    const loaded = readCatCatalog(projectRoot);
    assert.ok(loaded);
    assert.equal(loaded.accounts, undefined);
  });

  it('writeCatCatalog preserves accounts section', async () => {
    const { writeCatCatalog, readCatCatalog } = await import('../dist/config/cat-catalog-store.js');
    const accounts = {
      codex: { authType: 'oauth', protocol: 'openai', models: ['gpt-5.3-codex'] },
    };
    const catalog = makeCatalog(accounts);
    writeCatCatalog(projectRoot, catalog);

    const reloaded = readCatCatalog(projectRoot);
    assert.deepEqual(reloaded?.accounts, accounts);
  });

  it('readCatalogAccounts returns accounts from catalog', async () => {
    const { writeCatCatalog } = await import('../dist/config/cat-catalog-store.js');
    const { readCatalogAccounts } = await import('../dist/config/catalog-accounts.js');
    const accounts = {
      claude: { authType: 'oauth', protocol: 'anthropic' },
    };
    writeCatCatalog(projectRoot, makeCatalog(accounts));

    const result = readCatalogAccounts(projectRoot);
    assert.deepEqual(result, accounts);
  });

  it('readCatalogAccounts returns empty object when no accounts', async () => {
    const { writeCatCatalog } = await import('../dist/config/cat-catalog-store.js');
    const { readCatalogAccounts } = await import('../dist/config/catalog-accounts.js');
    writeCatCatalog(projectRoot, makeCatalog());

    const result = readCatalogAccounts(projectRoot);
    assert.deepEqual(result, {});
  });

  it('writeCatalogAccount adds account to catalog', async () => {
    const { writeCatCatalog, readCatCatalog } = await import('../dist/config/cat-catalog-store.js');
    const { writeCatalogAccount } = await import('../dist/config/catalog-accounts.js');
    writeCatCatalog(projectRoot, makeCatalog());

    writeCatalogAccount(projectRoot, 'my-glm', {
      authType: 'api_key',
      protocol: 'openai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      models: ['glm-5'],
    });

    const reloaded = readCatCatalog(projectRoot);
    assert.ok(reloaded?.accounts?.['my-glm']);
    assert.equal(reloaded.accounts['my-glm'].protocol, 'openai');
    assert.equal(reloaded.accounts['my-glm'].baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
  });

  it('deleteCatalogAccount removes account from catalog', async () => {
    const { writeCatCatalog, readCatCatalog } = await import('../dist/config/cat-catalog-store.js');
    const { writeCatalogAccount, deleteCatalogAccount } = await import('../dist/config/catalog-accounts.js');
    writeCatCatalog(
      projectRoot,
      makeCatalog({
        a: { authType: 'api_key', protocol: 'openai' },
        b: { authType: 'api_key', protocol: 'anthropic' },
      }),
    );

    deleteCatalogAccount(projectRoot, 'a');

    const reloaded = readCatCatalog(projectRoot);
    assert.equal(reloaded?.accounts?.a, undefined);
    assert.ok(reloaded?.accounts?.b);
  });
});
