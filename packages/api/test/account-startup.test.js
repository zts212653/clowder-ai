import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('accountStartupHook (clowder-ai#340 fail-fast)', () => {
  let globalRoot;
  let projectRoot;
  let previousGlobalRoot;
  let previousHome;

  beforeEach(async () => {
    globalRoot = await mkdtemp(join(tmpdir(), 'acct-startup-'));
    projectRoot = await mkdtemp(join(tmpdir(), 'acct-startup-proj-'));
    previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    previousHome = process.env.HOME;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
    // Isolate homedir so the homedir migration doesn't pick up real ~/.cat-cafe/ files
    process.env.HOME = globalRoot;
    await mkdir(join(globalRoot, '.cat-cafe'), { recursive: true });
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
  });

  afterEach(async () => {
    if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(globalRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('returns zero accountCount when no accounts and no legacy source', async () => {
    const { accountStartupHook } = await import(`../dist/config/account-startup.js?t=${Date.now()}`);
    const { resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    const result = accountStartupHook(projectRoot);
    assert.equal(result.accountCount, 0);
  });

  it('returns correct accountCount for healthy state', async () => {
    const { accountStartupHook } = await import(`../dist/config/account-startup.js?t=${Date.now()}-1`);
    const { writeCatalogAccount, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    writeCatalogAccount(projectRoot, 'claude', { authType: 'oauth' });
    writeCatalogAccount(projectRoot, 'codex', { authType: 'oauth' });
    resetMigrationState();

    const result = accountStartupHook(projectRoot);
    assert.equal(result.accountCount, 2);
  });

  it('includes migrated project-level accounts in count', async () => {
    const { accountStartupHook } = await import(`../dist/config/account-startup.js?t=${Date.now()}-2`);
    const { resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    const catalog = {
      version: 2,
      breeds: [],
      roster: {},
      reviewPolicy: {},
      accounts: {
        'custom-ant': { authType: 'api_key' },
      },
    };
    await writeFile(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(catalog), 'utf-8');

    const result = accountStartupHook(projectRoot);
    assert.equal(result.accountCount, 1);
  });

  it('LL-043: throws when legacy source exists but no accounts after migration', async () => {
    const { accountStartupHook } = await import(`../dist/config/account-startup.js?t=${Date.now()}-3`);
    const { resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    // Legacy profiles with no valid entries → 0 accounts migrated
    await writeFile(
      join(globalRoot, '.cat-cafe', 'provider-profiles.json'),
      JSON.stringify({ version: 2, providers: [] }),
      'utf-8',
    );

    assert.throws(() => accountStartupHook(projectRoot), /LL-043/);
  });

  it('LL-043: conflict in legacy migration is skipped (global wins), startup succeeds', async () => {
    const { accountStartupHook } = await import(`../dist/config/account-startup.js?t=${Date.now()}-4`);
    const { resetMigrationState, writeCatalogAccount } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    // Pre-existing account that conflicts with legacy
    writeCatalogAccount(projectRoot, 'shared', { authType: 'oauth' });
    resetMigrationState();

    await writeFile(
      join(projectRoot, '.cat-cafe', 'provider-profiles.json'),
      JSON.stringify({
        version: 2,
        providers: [{ id: 'shared', authType: 'api_key', baseUrl: 'https://conflict.example' }],
      }),
      'utf-8',
    );

    // After 1dbeb421a: conflicts are skipped (global wins), startup succeeds
    const result = accountStartupHook(projectRoot);
    assert.equal(result.accountCount, 1, 'pre-existing global account should survive');
  });

  it('fails fast when credentials.json is malformed', async () => {
    const { accountStartupHook } = await import(`../dist/config/account-startup.js?t=${Date.now()}-5`);
    const { resetMigrationState, writeCatalogAccount } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    writeCatalogAccount(projectRoot, 'claude', { authType: 'oauth' });
    await writeFile(join(globalRoot, '.cat-cafe', 'credentials.json'), '{not valid json', 'utf-8');

    assert.throws(() => accountStartupHook(projectRoot), /credentials read failed/i);
  });
});
