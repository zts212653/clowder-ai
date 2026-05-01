import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('global accounts (clowder-ai#340)', () => {
  let globalRoot;
  let projectRoot;
  let previousGlobalRoot;
  let previousHome;

  beforeEach(async () => {
    globalRoot = await mkdtemp(join(tmpdir(), 'global-accounts-'));
    projectRoot = await mkdtemp(join(tmpdir(), 'project-accounts-'));
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

  it('readCatalogAccounts returns empty object when no accounts file exists', async () => {
    const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();
    const result = readCatalogAccounts(projectRoot);
    assert.deepEqual(result, {});
  });

  it('writeCatalogAccount creates global accounts.json', async () => {
    const { writeCatalogAccount, readCatalogAccounts, resetMigrationState } = await import(
      '../dist/config/catalog-accounts.js'
    );
    resetMigrationState();
    writeCatalogAccount(projectRoot, 'claude', {
      authType: 'oauth',
      protocol: 'anthropic',
    });

    const result = readCatalogAccounts(projectRoot);
    assert.deepEqual(result.claude, { authType: 'oauth', protocol: 'anthropic' });

    // Verify it's in global path
    const raw = await readFile(join(globalRoot, '.cat-cafe', 'accounts.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.claude.protocol, 'anthropic');
  });

  it('deleteCatalogAccount removes account from global', async () => {
    const { writeCatalogAccount, deleteCatalogAccount, readCatalogAccounts, resetMigrationState } = await import(
      '../dist/config/catalog-accounts.js'
    );
    resetMigrationState();
    writeCatalogAccount(projectRoot, 'a', { authType: 'api_key', protocol: 'openai' });
    writeCatalogAccount(projectRoot, 'b', { authType: 'api_key', protocol: 'anthropic' });

    deleteCatalogAccount(projectRoot, 'a');

    const result = readCatalogAccounts(projectRoot);
    assert.equal(result.a, undefined);
    assert.ok(result.b);
  });

  it('migrates project-level accounts to global on first read', async () => {
    const { readCatalogAccounts, resetMigrationState, resolveAccountsPath } = await import(
      '../dist/config/catalog-accounts.js'
    );
    resetMigrationState();

    // Write a catalog with accounts section in project
    const catalog = {
      version: 2,
      breeds: [],
      roster: {},
      reviewPolicy: {},
      accounts: {
        claude: { authType: 'oauth', protocol: 'anthropic' },
        'my-glm': { authType: 'api_key', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
      },
    };
    await writeFile(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(catalog, null, 2), 'utf-8');

    // First read triggers migration
    const result = readCatalogAccounts(projectRoot);
    assert.equal(result.claude.protocol, 'anthropic');
    assert.equal(result['my-glm'].baseUrl, 'https://open.bigmodel.cn/api/paas/v4');

    // Global file should now contain accounts
    const globalRaw = await readFile(resolveAccountsPath(), 'utf-8');
    const globalAccounts = JSON.parse(globalRaw);
    assert.ok(globalAccounts.claude);
    assert.ok(globalAccounts['my-glm']);

    // Project catalog keeps accounts section untouched (rollback compat)
    const catalogRaw = await readFile(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), 'utf-8');
    const updatedCatalog = JSON.parse(catalogRaw);
    assert.ok(updatedCatalog.accounts?.claude, 'project accounts preserved for rollback compat');
    assert.ok(updatedCatalog.accounts?.['my-glm'], 'project accounts preserved for rollback compat');
    assert.equal(updatedCatalog.version, 2);
  });

  it('skips compatible duplicate project account IDs without overwriting; keeps skipped keys in project', async () => {
    const { writeCatalogAccount, readCatalogAccounts, resetMigrationState } = await import(
      '../dist/config/catalog-accounts.js'
    );
    resetMigrationState();

    // Pre-populate global with 'existing' account
    writeCatalogAccount(projectRoot, 'existing', { authType: 'oauth', protocol: 'anthropic' });
    resetMigrationState();

    // Write project catalog with an equivalent key + a new key
    const catalog = {
      version: 2,
      breeds: [],
      roster: {},
      reviewPolicy: {},
      accounts: {
        existing: { authType: 'oauth', protocol: 'anthropic' },
        'new-from-project': { authType: 'api_key', protocol: 'openai' },
      },
    };
    await writeFile(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(catalog, null, 2), 'utf-8');

    const result = readCatalogAccounts(projectRoot);
    assert.equal(result.existing.authType, 'oauth', 'existing global key must not be overwritten');
    assert.ok(result['new-from-project'], 'new key from project should be merged');

    // Skipped key must still be in project catalog (not silently deleted)
    const catalogRaw = await readFile(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), 'utf-8');
    const updatedCatalog = JSON.parse(catalogRaw);
    assert.ok(updatedCatalog.accounts?.existing, 'skipped key must remain in project catalog');
    assert.ok(
      updatedCatalog.accounts['new-from-project'],
      'merged key must also remain in project catalog (rollback compat)',
    );
  });

  it('migrates project-level legacy provider-profiles.json into global accounts', async () => {
    const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    // Write legacy provider-profiles.json at project level (old installer output)
    const legacyMeta = {
      version: 2,
      providers: [{ id: 'my-custom', authType: 'api_key', protocol: 'openai', baseUrl: 'https://custom.api/v1' }],
    };
    await writeFile(join(projectRoot, '.cat-cafe', 'provider-profiles.json'), JSON.stringify(legacyMeta), 'utf-8');

    // Write secrets file too
    const legacySecrets = { profiles: { 'my-custom': { apiKey: 'sk-secret-123' } } };
    await writeFile(
      join(projectRoot, '.cat-cafe', 'provider-profiles.secrets.local.json'),
      JSON.stringify(legacySecrets),
      'utf-8',
    );

    // Reading accounts should trigger project-level legacy migration
    const result = readCatalogAccounts(projectRoot);
    // clowder-ai#340: protocol not migrated — derived at runtime from well-known account IDs.
    assert.equal(result['my-custom'].protocol, undefined);
    assert.equal(result['my-custom'].baseUrl, 'https://custom.api/v1');

    // Credentials should also be migrated to global
    const credRaw = await readFile(join(globalRoot, '.cat-cafe', 'credentials.json'), 'utf-8');
    const creds = JSON.parse(credRaw);
    assert.equal(creds['my-custom'].apiKey, 'sk-secret-123');
  });

  it('propagates global legacy provider-profile migration errors instead of failing open', async () => {
    const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    await writeFile(join(globalRoot, '.cat-cafe', 'provider-profiles.json'), '{"version":2,"profiles":[', 'utf-8');

    assert.throws(() => readCatalogAccounts(projectRoot), /Unexpected end of JSON input|JSON/i);
  });

  it('infers legacy api_key authType from mode/kind before migrating secrets', async () => {
    const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    const legacyMeta = {
      version: 1,
      providers: {
        anthropic: {
          activeProfileId: 'installer-managed',
          profiles: [
            {
              id: 'installer-managed',
              displayName: 'Installer API Key',
              kind: 'api_key',
              mode: 'api_key',
              baseUrl: 'https://legacy.example/v1',
            },
          ],
        },
      },
    };
    await writeFile(join(projectRoot, '.cat-cafe', 'provider-profiles.json'), JSON.stringify(legacyMeta), 'utf-8');
    await writeFile(
      join(projectRoot, '.cat-cafe', 'provider-profiles.secrets.local.json'),
      JSON.stringify({
        version: 1,
        providers: { anthropic: { 'installer-managed': { apiKey: 'sk-legacy-api-key' } } },
      }),
      'utf-8',
    );

    const result = readCatalogAccounts(projectRoot);
    assert.equal(result['installer-managed'].authType, 'api_key');

    const credRaw = await readFile(join(globalRoot, '.cat-cafe', 'credentials.json'), 'utf-8');
    const creds = JSON.parse(credRaw);
    assert.equal(creds['installer-managed'].apiKey, 'sk-legacy-api-key');
  });

  it('migrates multiple projects without losing accounts', async () => {
    const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    // Project A has account 'a'
    const projectA = await mkdtemp(join(tmpdir(), 'project-a-'));
    await mkdir(join(projectA, '.cat-cafe'), { recursive: true });
    await writeFile(
      join(projectA, '.cat-cafe', 'cat-catalog.json'),
      JSON.stringify({
        version: 2,
        breeds: [],
        roster: {},
        reviewPolicy: {},
        accounts: { a: { authType: 'oauth', protocol: 'anthropic' } },
      }),
      'utf-8',
    );

    // Project B has account 'b'
    const projectB = await mkdtemp(join(tmpdir(), 'project-b-'));
    await mkdir(join(projectB, '.cat-cafe'), { recursive: true });
    await writeFile(
      join(projectB, '.cat-cafe', 'cat-catalog.json'),
      JSON.stringify({
        version: 2,
        breeds: [],
        roster: {},
        reviewPolicy: {},
        accounts: { b: { authType: 'api_key', protocol: 'openai' } },
      }),
      'utf-8',
    );

    // Read A first, then B — both should migrate
    readCatalogAccounts(projectA);
    const result = readCatalogAccounts(projectB);
    assert.ok(result.a, 'account from project A should exist');
    assert.ok(result.b, 'account from project B should exist');

    const { rm: rmAsync } = await import('node:fs/promises');
    await rmAsync(projectA, { recursive: true, force: true });
    await rmAsync(projectB, { recursive: true, force: true });
  });

  it('skips conflicting project catalog accounts without crashing (global wins)', async () => {
    const { readCatalogAccounts, resetMigrationState, writeCatalogAccount } = await import(
      '../dist/config/catalog-accounts.js'
    );
    resetMigrationState();

    // Global already has 'shared' with different fields
    writeCatalogAccount(projectRoot, 'shared', {
      authType: 'api_key',
      baseUrl: 'https://global.example/v1',
      displayName: 'Global Shared',
    });
    resetMigrationState();

    // Project catalog has a stale version of 'shared'
    await writeFile(
      join(projectRoot, '.cat-cafe', 'cat-catalog.json'),
      JSON.stringify({
        version: 2,
        breeds: [],
        roster: {},
        reviewPolicy: {},
        accounts: {
          shared: {
            authType: 'api_key',
            baseUrl: 'https://project.example/v1',
            displayName: 'Project Shared',
          },
        },
      }),
      'utf-8',
    );

    // Should NOT throw — project catalog is stale, global wins
    const result = readCatalogAccounts(projectRoot);
    // Global version preserved, not overwritten by stale project version
    assert.equal(result.shared.baseUrl, 'https://global.example/v1');
    assert.equal(result.shared.displayName, 'Global Shared');
  });

  it('migrates v1 nested providers.<client>.profiles[] into flat accounts', async () => {
    const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    // v1 format: providers keyed by client, each with a profiles array
    const v1Meta = {
      version: 1,
      providers: {
        anthropic: {
          activeProfileId: 'my-proxy',
          profiles: [
            { id: 'my-proxy', displayName: 'My Proxy', authType: 'api_key', baseUrl: 'https://proxy.example/v1' },
            { id: 'team-key', displayName: 'Team Key', authType: 'api_key' },
          ],
        },
      },
    };
    await writeFile(join(projectRoot, '.cat-cafe', 'provider-profiles.json'), JSON.stringify(v1Meta), 'utf-8');

    // v1 secrets: also nested under providers.<client>
    const v1Secrets = {
      version: 1,
      providers: {
        anthropic: {
          'my-proxy': { apiKey: 'sk-proxy-key' },
          'team-key': { apiKey: 'sk-team-key' },
        },
      },
    };
    await writeFile(
      join(projectRoot, '.cat-cafe', 'provider-profiles.secrets.local.json'),
      JSON.stringify(v1Secrets),
      'utf-8',
    );

    const result = readCatalogAccounts(projectRoot);
    // Both profiles should be migrated as individual accounts (not "anthropic" shell)
    assert.ok(result['my-proxy'], 'my-proxy account should exist');
    assert.equal(result['my-proxy'].authType, 'api_key');
    assert.equal(result['my-proxy'].displayName, 'My Proxy');
    assert.equal(result['my-proxy'].baseUrl, 'https://proxy.example/v1');
    assert.ok(result['team-key'], 'team-key account should exist');
    assert.equal(result['team-key'].authType, 'api_key');
    // Must NOT create an "anthropic" shell account from the parent key
    assert.equal(result.anthropic, undefined, 'should not create shell account from client key');

    // Credentials should also be migrated
    const credRaw = await readFile(join(globalRoot, '.cat-cafe', 'credentials.json'), 'utf-8');
    const creds = JSON.parse(credRaw);
    assert.equal(creds['my-proxy'].apiKey, 'sk-proxy-key');
    assert.equal(creds['team-key'].apiKey, 'sk-team-key');
  });

  it('skips conflicting legacy provider-profile without crashing (global wins)', async () => {
    const { readCatalogAccounts, resetMigrationState, writeCatalogAccount } = await import(
      '../dist/config/catalog-accounts.js'
    );
    resetMigrationState();

    writeCatalogAccount(projectRoot, 'shared', {
      authType: 'oauth',
      displayName: 'Global OAuth',
    });
    resetMigrationState();

    await writeFile(
      join(projectRoot, '.cat-cafe', 'provider-profiles.json'),
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: 'shared',
            authType: 'api_key',
            baseUrl: 'https://legacy.example/v1',
            displayName: 'Legacy Shared',
          },
        ],
      }),
      'utf-8',
    );

    const result = readCatalogAccounts(projectRoot);
    assert.equal(result.shared.authType, 'oauth', 'global account must win over legacy');
    assert.equal(result.shared.displayName, 'Global OAuth', 'global displayName must be preserved');
  });

  it('retries secret import when accounts already exist from previous migration', async () => {
    const { readCatalogAccounts, resetMigrationState, writeCatalogAccount } = await import(
      '../dist/config/catalog-accounts.js'
    );
    resetMigrationState();

    // Simulate previous successful account merge: account exists in global (same fields
    // as what migration would produce) but credential is missing from a partial first run
    writeCatalogAccount(projectRoot, 'my-custom', { authType: 'api_key', baseUrl: 'https://custom.api/v1' });
    resetMigrationState(); // reset so next read re-runs migration

    // Legacy source still has the profile + secret
    const legacyMeta = {
      version: 2,
      providers: [{ id: 'my-custom', authType: 'api_key', baseUrl: 'https://custom.api/v1' }],
    };
    await writeFile(join(projectRoot, '.cat-cafe', 'provider-profiles.json'), JSON.stringify(legacyMeta), 'utf-8');

    const legacySecrets = { profiles: { 'my-custom': { apiKey: 'sk-retry-key' } } };
    await writeFile(
      join(projectRoot, '.cat-cafe', 'provider-profiles.secrets.local.json'),
      JSON.stringify(legacySecrets),
      'utf-8',
    );

    // On retry: accounts already exist (mergedIds empty), but credentials must still import
    const result = readCatalogAccounts(projectRoot);
    assert.ok(result['my-custom'], 'account should exist');

    const credRaw = await readFile(join(globalRoot, '.cat-cafe', 'credentials.json'), 'utf-8');
    const creds = JSON.parse(credRaw);
    assert.equal(creds['my-custom'].apiKey, 'sk-retry-key', 'credential must be imported on retry');
  });

  it('skips legacy secret when colliding with pre-existing global OAuth account', async () => {
    const { readCatalogAccounts, resetMigrationState, writeCatalogAccount } = await import(
      '../dist/config/catalog-accounts.js'
    );
    resetMigrationState();

    // Pre-existing OAuth account in global — NOT from this legacy source
    writeCatalogAccount(projectRoot, 'shared', { authType: 'oauth' });
    resetMigrationState();

    // Legacy source happens to use the same "shared" ID but as api_key
    const legacyMeta = {
      version: 2,
      providers: [{ id: 'shared', authType: 'api_key', baseUrl: 'https://legacy.api/v1' }],
    };
    await writeFile(join(projectRoot, '.cat-cafe', 'provider-profiles.json'), JSON.stringify(legacyMeta), 'utf-8');

    const legacySecrets = { profiles: { shared: { apiKey: 'sk-collision' } } };
    await writeFile(
      join(projectRoot, '.cat-cafe', 'provider-profiles.secrets.local.json'),
      JSON.stringify(legacySecrets),
      'utf-8',
    );

    // Must not crash — global wins, secret must NOT be imported
    const result = readCatalogAccounts(projectRoot);
    assert.equal(result.shared.authType, 'oauth', 'global OAuth account must win');

    const credPath = join(globalRoot, '.cat-cafe', 'credentials.json');
    if (existsSync(credPath)) {
      const creds = JSON.parse(await readFile(credPath, 'utf-8'));
      assert.equal(creds.shared, undefined, 'legacy secret must NOT be attached to pre-existing OAuth account');
    }
    // If credentials.json doesn't exist at all, that's also correct
  });

  it('stores accounts in projectRoot/.cat-cafe/ when env override is unset', async () => {
    delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    const { writeCatalogAccount, readCatalogAccounts, resetMigrationState } = await import(
      '../dist/config/catalog-accounts.js'
    );
    resetMigrationState();

    writeCatalogAccount(projectRoot, 'local-test', { authType: 'api_key' });
    const result = readCatalogAccounts(projectRoot);
    assert.deepEqual(result['local-test'], { authType: 'api_key' });

    // Must be in projectRoot, not globalRoot
    const projectFile = join(projectRoot, '.cat-cafe', 'accounts.json');
    assert.ok(existsSync(projectFile), 'accounts.json should be in projectRoot/.cat-cafe/');
    const raw = JSON.parse(await readFile(projectFile, 'utf-8'));
    assert.equal(raw['local-test'].authType, 'api_key');

    const globalFile = join(globalRoot, '.cat-cafe', 'accounts.json');
    assert.ok(!existsSync(globalFile), 'accounts.json should NOT be in globalRoot when env unset');
  });

  it('skips legacy secret when colliding with different-source api_key account', async () => {
    const { readCatalogAccounts, resetMigrationState, writeCatalogAccount } = await import(
      '../dist/config/catalog-accounts.js'
    );
    resetMigrationState();

    // Pre-existing api_key account — same type, different source (different baseUrl)
    writeCatalogAccount(projectRoot, 'shared', { authType: 'api_key', baseUrl: 'https://existing.example/v1' });
    resetMigrationState();

    // Legacy source: same ID, same authType, but different baseUrl → different source
    const legacyMeta = {
      version: 2,
      providers: [{ id: 'shared', authType: 'api_key', baseUrl: 'https://legacy.example/v1' }],
    };
    await writeFile(join(projectRoot, '.cat-cafe', 'provider-profiles.json'), JSON.stringify(legacyMeta), 'utf-8');

    const legacySecrets = { profiles: { shared: { apiKey: 'sk-collision-api-key' } } };
    await writeFile(
      join(projectRoot, '.cat-cafe', 'provider-profiles.secrets.local.json'),
      JSON.stringify(legacySecrets),
      'utf-8',
    );

    // Must not crash — global wins, secret must NOT be imported
    const result = readCatalogAccounts(projectRoot);
    assert.equal(result.shared.authType, 'api_key', 'global account must win');
    assert.equal(result.shared.baseUrl, 'https://existing.example/v1', 'global baseUrl must be preserved');

    const credPath = join(globalRoot, '.cat-cafe', 'credentials.json');
    if (existsSync(credPath)) {
      const creds = JSON.parse(await readFile(credPath, 'utf-8'));
      assert.equal(creds.shared, undefined, 'legacy secret must NOT be attached to different-source api_key account');
    }
  });

  it('migrates well-known installer credentials from homedir when globalRoot differs from homedir', async () => {
    const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    // Simulate: CAT_CAFE_GLOBAL_CONFIG_ROOT is unset, projectRoot != homedir.
    // Old installer (pre-clowder-ai#340) wrote secrets to homedir when --project-dir was not given.
    delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;

    const fakeHome = await mkdtemp(join(tmpdir(), 'fake-home-'));
    await mkdir(join(fakeHome, '.cat-cafe'), { recursive: true });
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      // Legacy provider-profiles + secrets in homedir (old installer output)
      await writeFile(
        join(fakeHome, '.cat-cafe', 'provider-profiles.json'),
        JSON.stringify({
          version: 2,
          providers: [{ id: 'installer-openai', authType: 'api_key', baseUrl: 'https://home.api/v1' }],
        }),
        'utf-8',
      );
      await writeFile(
        join(fakeHome, '.cat-cafe', 'provider-profiles.secrets.local.json'),
        JSON.stringify({ profiles: { 'installer-openai': { apiKey: 'sk-from-homedir' } } }),
        'utf-8',
      );

      // projectRoot is a separate directory — no legacy files there
      const result = readCatalogAccounts(projectRoot);
      assert.equal(
        result['installer-openai']?.baseUrl,
        'https://home.api/v1',
        'installer account from homedir must be migrated',
      );

      // Credentials should be migrated to globalRoot (= projectRoot when env unset)
      const credRaw = await readFile(join(projectRoot, '.cat-cafe', 'credentials.json'), 'utf-8');
      const creds = JSON.parse(credRaw);
      assert.equal(creds['installer-openai']?.apiKey, 'sk-from-homedir', 'API key from homedir must be migrated');
    } finally {
      process.env.HOME = savedHome;
      // Restore env for subsequent tests
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('migrates homedir installer credentials to multiple projects in the same process', async () => {
    const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;

    const fakeHome = await mkdtemp(join(tmpdir(), 'fake-home-'));
    await mkdir(join(fakeHome, '.cat-cafe'), { recursive: true });
    const projectB = await mkdtemp(join(tmpdir(), 'project-b-'));
    await mkdir(join(projectB, '.cat-cafe'), { recursive: true });
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      await writeFile(
        join(fakeHome, '.cat-cafe', 'provider-profiles.json'),
        JSON.stringify({
          version: 2,
          providers: [{ id: 'installer-openai', authType: 'api_key', baseUrl: 'https://home.api/v1' }],
        }),
        'utf-8',
      );
      await writeFile(
        join(fakeHome, '.cat-cafe', 'provider-profiles.secrets.local.json'),
        JSON.stringify({ profiles: { 'installer-openai': { apiKey: 'sk-from-homedir' } } }),
        'utf-8',
      );

      // First project migrates successfully
      const resultA = readCatalogAccounts(projectRoot);
      assert.equal(resultA['installer-openai']?.baseUrl, 'https://home.api/v1', 'projectA must get homedir account');

      // Second project must ALSO get the homedir credentials (not skipped by boolean cache)
      const resultB = readCatalogAccounts(projectB);
      assert.equal(
        resultB['installer-openai']?.baseUrl,
        'https://home.api/v1',
        'projectB must also get homedir account',
      );

      const credRawB = await readFile(join(projectB, '.cat-cafe', 'credentials.json'), 'utf-8');
      const credsB = JSON.parse(credRawB);
      assert.equal(credsB['installer-openai']?.apiKey, 'sk-from-homedir', 'projectB must also get homedir API key');
    } finally {
      process.env.HOME = savedHome;
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(projectB, { recursive: true, force: true });
    }
  });

  it('imports homedir credentials for legacy project catalog.accounts refs', async () => {
    const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    const fakeHome = await mkdtemp(join(tmpdir(), 'fake-home-catalog-accounts-creds-'));
    await mkdir(join(fakeHome, '.cat-cafe'), { recursive: true });
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      await writeFile(
        join(projectRoot, '.cat-cafe', 'cat-catalog.json'),
        JSON.stringify({
          version: 2,
          breeds: [],
          roster: {},
          reviewPolicy: {},
          accounts: {
            'legacy-custom': {
              authType: 'api_key',
              baseUrl: 'https://legacy-custom.example/v1',
            },
          },
        }),
        'utf-8',
      );
      await writeFile(
        join(fakeHome, '.cat-cafe', 'credentials.json'),
        JSON.stringify({ 'legacy-custom': { apiKey: 'sk-legacy-custom' } }),
        'utf-8',
      );

      const result = readCatalogAccounts(projectRoot);
      assert.equal(result['legacy-custom']?.baseUrl, 'https://legacy-custom.example/v1');

      const credsRaw = await readFile(join(globalRoot, '.cat-cafe', 'credentials.json'), 'utf-8');
      const creds = JSON.parse(credsRaw);
      assert.equal(creds['legacy-custom']?.apiKey, 'sk-legacy-custom');
    } finally {
      process.env.HOME = savedHome;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('does not import unreferenced homedir legacy experiments into project-local accounts', async () => {
    const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;

    const fakeHome = await mkdtemp(join(tmpdir(), 'fake-home-unreferenced-legacy-'));
    await mkdir(join(fakeHome, '.cat-cafe'), { recursive: true });
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      await writeFile(
        join(fakeHome, '.cat-cafe', 'provider-profiles.json'),
        JSON.stringify({
          version: 2,
          providers: [
            { id: 'installer-openai', authType: 'api_key', baseUrl: 'https://api.openai.com/v1' },
            { id: 'agent-teams-local', authType: 'api_key', displayName: 'Agent Teams Local' },
            {
              id: 'codex-sponsor',
              authType: 'api_key',
              displayName: 'codex-sponsor',
              baseUrl: 'https://openai.example/v1',
              models: ['gpt-5.4'],
            },
          ],
        }),
        'utf-8',
      );
      await writeFile(
        join(fakeHome, '.cat-cafe', 'provider-profiles.secrets.local.json'),
        JSON.stringify({
          profiles: {
            'installer-openai': { apiKey: 'sk-installer-openai' },
            'agent-teams-local': { apiKey: 'sk-agent-teams-local' },
            'codex-sponsor': { apiKey: 'sk-codex-sponsor' },
          },
        }),
        'utf-8',
      );

      const result = readCatalogAccounts(projectRoot);
      assert.ok(result['installer-openai'], 'well-known installer account should still migrate');
      assert.equal(result['agent-teams-local'], undefined, 'unreferenced homedir experiment must not migrate');
      assert.equal(result['codex-sponsor'], undefined, 'unreferenced homedir test fixture must not migrate');

      const credsRaw = await readFile(join(projectRoot, '.cat-cafe', 'credentials.json'), 'utf-8');
      const creds = JSON.parse(credsRaw);
      assert.equal(creds['installer-openai']?.apiKey, 'sk-installer-openai');
      assert.equal(creds['agent-teams-local'], undefined, 'skipped experiment credential must not migrate');
      assert.equal(creds['codex-sponsor'], undefined, 'skipped fixture credential must not migrate');
    } finally {
      process.env.HOME = savedHome;
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('imports a homedir legacy account when the project catalog references it', async () => {
    const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;

    const fakeHome = await mkdtemp(join(tmpdir(), 'fake-home-referenced-legacy-'));
    await mkdir(join(fakeHome, '.cat-cafe'), { recursive: true });
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      await writeFile(
        join(projectRoot, '.cat-cafe', 'cat-catalog.json'),
        JSON.stringify({
          version: 2,
          breeds: [
            {
              id: 'custom',
              variants: [{ id: 'custom-default', accountRef: 'modelarts-shared' }],
            },
          ],
          roster: {},
          reviewPolicy: {},
        }),
        'utf-8',
      );
      await writeFile(
        join(fakeHome, '.cat-cafe', 'provider-profiles.json'),
        JSON.stringify({
          version: 2,
          providers: [
            {
              id: 'modelarts-shared',
              authType: 'api_key',
              displayName: 'ModelArts Shared',
              baseUrl: 'https://api.modelarts-maas.com/v2',
              models: ['glm-5'],
            },
          ],
        }),
        'utf-8',
      );
      await writeFile(
        join(fakeHome, '.cat-cafe', 'provider-profiles.secrets.local.json'),
        JSON.stringify({ profiles: { 'modelarts-shared': { apiKey: 'sk-modelarts' } } }),
        'utf-8',
      );

      const result = readCatalogAccounts(projectRoot);
      assert.equal(result['modelarts-shared']?.baseUrl, 'https://api.modelarts-maas.com/v2');

      const credsRaw = await readFile(join(projectRoot, '.cat-cafe', 'credentials.json'), 'utf-8');
      const creds = JSON.parse(credsRaw);
      assert.equal(creds['modelarts-shared']?.apiKey, 'sk-modelarts');
    } finally {
      process.env.HOME = savedHome;
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('imports a homedir legacy account when the project catalog references legacy providerProfileId', async () => {
    const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;

    const fakeHome = await mkdtemp(join(tmpdir(), 'fake-home-provider-profile-id-'));
    await mkdir(join(fakeHome, '.cat-cafe'), { recursive: true });
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      await writeFile(
        join(projectRoot, '.cat-cafe', 'cat-catalog.json'),
        JSON.stringify({
          version: 2,
          breeds: [
            {
              id: 'legacy-custom',
              variants: [{ id: 'legacy-custom-default', providerProfileId: 'legacy-provider-profile' }],
            },
          ],
          roster: {},
          reviewPolicy: {},
        }),
        'utf-8',
      );
      await writeFile(
        join(fakeHome, '.cat-cafe', 'provider-profiles.json'),
        JSON.stringify({
          version: 2,
          providers: [
            {
              id: 'legacy-provider-profile',
              authType: 'api_key',
              displayName: 'Legacy Provider Profile',
              baseUrl: 'https://legacy-provider.example/v1',
            },
          ],
        }),
        'utf-8',
      );
      await writeFile(
        join(fakeHome, '.cat-cafe', 'provider-profiles.secrets.local.json'),
        JSON.stringify({ profiles: { 'legacy-provider-profile': { apiKey: 'sk-legacy-provider' } } }),
        'utf-8',
      );

      const result = readCatalogAccounts(projectRoot);
      assert.equal(result['legacy-provider-profile']?.baseUrl, 'https://legacy-provider.example/v1');

      const credsRaw = await readFile(join(projectRoot, '.cat-cafe', 'credentials.json'), 'utf-8');
      const creds = JSON.parse(credsRaw);
      assert.equal(creds['legacy-provider-profile']?.apiKey, 'sk-legacy-provider');
    } finally {
      process.env.HOME = savedHome;
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('imports project-referenced homedir legacy accounts across shared global roots', async () => {
    const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    const fakeHome = await mkdtemp(join(tmpdir(), 'fake-home-shared-global-legacy-'));
    const projectB = await mkdtemp(join(tmpdir(), 'project-b-shared-global-'));
    await mkdir(join(fakeHome, '.cat-cafe'), { recursive: true });
    await mkdir(join(projectB, '.cat-cafe'), { recursive: true });
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      await writeFile(
        join(projectRoot, '.cat-cafe', 'cat-catalog.json'),
        JSON.stringify({
          version: 2,
          breeds: [{ id: 'custom-a', variants: [{ id: 'custom-a-default', accountRef: 'modelarts-a' }] }],
          roster: {},
          reviewPolicy: {},
        }),
        'utf-8',
      );
      await writeFile(
        join(projectB, '.cat-cafe', 'cat-catalog.json'),
        JSON.stringify({
          version: 2,
          breeds: [{ id: 'custom-b', variants: [{ id: 'custom-b-default', accountRef: 'modelarts-b' }] }],
          roster: {},
          reviewPolicy: {},
        }),
        'utf-8',
      );
      await writeFile(
        join(fakeHome, '.cat-cafe', 'provider-profiles.json'),
        JSON.stringify({
          version: 2,
          providers: [
            { id: 'modelarts-a', authType: 'api_key', baseUrl: 'https://modelarts-a.example/v1' },
            { id: 'modelarts-b', authType: 'api_key', baseUrl: 'https://modelarts-b.example/v1' },
          ],
        }),
        'utf-8',
      );
      await writeFile(
        join(fakeHome, '.cat-cafe', 'provider-profiles.secrets.local.json'),
        JSON.stringify({
          profiles: {
            'modelarts-a': { apiKey: 'sk-modelarts-a' },
            'modelarts-b': { apiKey: 'sk-modelarts-b' },
          },
        }),
        'utf-8',
      );

      const resultA = readCatalogAccounts(projectRoot);
      assert.equal(resultA['modelarts-a']?.baseUrl, 'https://modelarts-a.example/v1');
      assert.equal(resultA['modelarts-b'], undefined, 'projectA must not import projectB-only account');

      const resultB = readCatalogAccounts(projectB);
      assert.equal(resultB['modelarts-b']?.baseUrl, 'https://modelarts-b.example/v1');

      const credsRaw = await readFile(join(globalRoot, '.cat-cafe', 'credentials.json'), 'utf-8');
      const creds = JSON.parse(credsRaw);
      assert.equal(creds['modelarts-a']?.apiKey, 'sk-modelarts-a');
      assert.equal(creds['modelarts-b']?.apiKey, 'sk-modelarts-b');
    } finally {
      process.env.HOME = savedHome;
      await rm(fakeHome, { recursive: true, force: true });
      await rm(projectB, { recursive: true, force: true });
    }
  });

  it('skips homedir profile + credentials migrations when CAT_CAFE_SKIP_HOMEDIR_MIGRATION=1', async () => {
    const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_SKIP_HOMEDIR_MIGRATION = '1';

    const fakeHome = await mkdtemp(join(tmpdir(), 'fake-home-skip-'));
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    await mkdir(join(fakeHome, '.cat-cafe'), { recursive: true });

    try {
      await writeFile(
        join(fakeHome, '.cat-cafe', 'provider-profiles.json'),
        JSON.stringify({
          version: 2,
          providers: [{ id: 'homedir-account', authType: 'api_key', baseUrl: 'https://home.api/v1' }],
        }),
        'utf-8',
      );
      await writeFile(
        join(fakeHome, '.cat-cafe', 'provider-profiles.secrets.local.json'),
        JSON.stringify({ profiles: { 'homedir-account': { apiKey: 'sk-from-homedir' } } }),
        'utf-8',
      );

      const result = readCatalogAccounts(projectRoot);
      assert.equal(
        result['homedir-account'],
        undefined,
        'skip flag must prevent homedir profile metadata from being migrated into project accounts',
      );
      assert.equal(
        existsSync(join(projectRoot, '.cat-cafe', 'credentials.json')),
        false,
        'skip flag must not materialize a credentials.json from homedir data',
      );
    } finally {
      delete process.env.CAT_CAFE_SKIP_HOMEDIR_MIGRATION;
      process.env.HOME = savedHome;
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });

  it('skip flag still allows project-scoped legacy migrations', async () => {
    const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    process.env.CAT_CAFE_SKIP_HOMEDIR_MIGRATION = '1';

    try {
      await writeFile(
        join(projectRoot, '.cat-cafe', 'provider-profiles.json'),
        JSON.stringify({
          version: 2,
          providers: [{ id: 'project-account', authType: 'api_key', baseUrl: 'https://project.api/v1' }],
        }),
        'utf-8',
      );
      await writeFile(
        join(projectRoot, '.cat-cafe', 'provider-profiles.secrets.local.json'),
        JSON.stringify({ profiles: { 'project-account': { apiKey: 'sk-from-project' } } }),
        'utf-8',
      );

      const result = readCatalogAccounts(projectRoot);
      assert.equal(result['project-account']?.baseUrl, 'https://project.api/v1');
      const credsRaw = await readFile(join(globalRoot, '.cat-cafe', 'credentials.json'), 'utf-8');
      const creds = JSON.parse(credsRaw);
      assert.equal(creds['project-account']?.apiKey, 'sk-from-project');
    } finally {
      delete process.env.CAT_CAFE_SKIP_HOMEDIR_MIGRATION;
    }
  });
});
