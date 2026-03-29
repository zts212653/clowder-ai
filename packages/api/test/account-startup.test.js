import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('accountStartupHook (HC-3 migration + HC-5 conflict scan at startup)', () => {
  let globalRoot;
  let projectRoot;
  let previousGlobalRoot;

  beforeEach(async () => {
    globalRoot = await mkdtemp(join(tmpdir(), 'acct-startup-'));
    projectRoot = await mkdtemp(join(tmpdir(), 'acct-startup-proj-'));
    previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = globalRoot;
    await mkdir(join(globalRoot, '.cat-cafe'), { recursive: true });
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
  });

  afterEach(async () => {
    if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
    await rm(globalRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  function writeCatalog(root, accounts) {
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
    return writeFile(join(root, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(catalog, null, 2), 'utf-8');
  }

  function writeV3Meta(profiles) {
    const meta = { version: 3, activeProfileId: null, providers: profiles, bootstrapBindings: {} };
    return writeFile(join(globalRoot, '.cat-cafe', 'provider-profiles.json'), JSON.stringify(meta, null, 2), 'utf-8');
  }

  function writeV3Secrets(profileSecrets) {
    const secrets = { version: 3, profiles: profileSecrets };
    return writeFile(
      join(globalRoot, '.cat-cafe', 'provider-profiles.secrets.local.json'),
      JSON.stringify(secrets, null, 2),
      'utf-8',
    );
  }

  it('runs migration and returns migrated accounts + conflicts', async () => {
    const { accountStartupHook } = await import(`../dist/config/account-startup.js?t=${Date.now()}`);

    // Setup: old provider-profiles + catalog (so migration can write)
    await writeV3Meta([
      { id: 'custom-ant', authType: 'api_key', protocol: 'anthropic', baseUrl: 'https://ant.example.com' },
    ]);
    await writeV3Secrets({ 'custom-ant': { apiKey: 'sk-test-123' } });
    await writeCatalog(projectRoot, {});

    const result = accountStartupHook(projectRoot);
    assert.ok(result, 'hook should return a result');
    assert.ok(result.migration, 'should include migration result');
    assert.equal(result.migration.migrated, true);
    assert.equal(result.migration.accountsMigrated, 1);
    assert.ok(Array.isArray(result.conflicts), 'should include conflicts array');
  });

  it('skips migration when project already has all old accounts', async () => {
    const { accountStartupHook } = await import(`../dist/config/account-startup.js?t=${Date.now()}-1`);

    // Old profiles exist in global config
    await writeV3Meta([
      { id: 'custom-ant', authType: 'api_key', protocol: 'anthropic', baseUrl: 'https://ant.example.com' },
    ]);
    // Project catalog already has the account → migration should be skipped
    await writeCatalog(projectRoot, { 'custom-ant': { authType: 'api_key', protocol: 'anthropic' } });

    const result = accountStartupHook(projectRoot);
    assert.equal(result.migration.migrated, false);
    assert.equal(result.migration.reason, 'already-migrated');
  });

  it('detects cross-project conflicts at startup', async () => {
    const { accountStartupHook } = await import(`../dist/config/account-startup.js?t=${Date.now()}-2`);

    // Create a second project with a conflicting account
    const otherProject = await mkdtemp(join(tmpdir(), 'acct-startup-other-'));
    await mkdir(join(otherProject, '.cat-cafe'), { recursive: true });

    // Write known-project-roots.json
    await writeFile(
      join(globalRoot, '.cat-cafe', 'known-project-roots.json'),
      JSON.stringify([projectRoot, otherProject]),
      'utf-8',
    );

    // Write conflicting accounts: same ref, different protocol
    await writeCatalog(projectRoot, {
      shared: { authType: 'api_key', protocol: 'anthropic' },
    });
    await writeCatalog(otherProject, {
      shared: { authType: 'api_key', protocol: 'openai' },
    });

    // Write migration marker to skip migration
    await writeFile(
      join(globalRoot, '.cat-cafe', 'accounts-migration-done.json'),
      JSON.stringify({ migratedAt: new Date().toISOString() }),
      'utf-8',
    );

    assert.throws(
      () => accountStartupHook(projectRoot),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('shared'), 'error should name the conflicting accountRef');
        assert.ok(err.message.includes('protocol'), 'error should describe the conflict');
        return true;
      },
      'HC-5: startup conflict must be a hard error, not warn-only',
    );

    await rm(otherProject, { recursive: true, force: true });
  });

  it('LL-043: does NOT throw when legacy file exists but has zero providers', async () => {
    const { accountStartupHook } = await import(`../dist/config/account-startup.js?t=${Date.now()}-4`);

    // Legacy file exists but with empty providers — nothing to migrate
    await writeV3Meta([]);
    await writeCatalog(projectRoot, {});

    // Should NOT throw — empty providers means nothing was ever configured
    const result = accountStartupHook(projectRoot);
    assert.equal(result.migration.migrated, false);
    assert.equal(result.migration.reason, 'already-migrated');
  });

  it('LL-043: throws when legacy file is corrupt (unparseable) and catalog has no accounts', async () => {
    const { accountStartupHook } = await import(`../dist/config/account-startup.js?t=${Date.now()}-5`);

    // Corrupt legacy file — can't parse, but file IS present
    await writeFile(join(globalRoot, '.cat-cafe', 'provider-profiles.json'), '{', 'utf-8');
    await writeCatalog(projectRoot, {});

    assert.throws(
      () => accountStartupHook(projectRoot),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('LL-043'), 'error should reference LL-043');
        return true;
      },
      'LL-043: corrupt legacy file + empty accounts must throw',
    );
  });

  it('LL-043: throws when legacy source exists but catalog is corrupted JSON', async () => {
    const { accountStartupHook } = await import(`../dist/config/account-startup.js?t=${Date.now()}-6`);

    // Legacy file with providers
    await writeV3Meta([
      { id: 'custom-ant', authType: 'api_key', protocol: 'anthropic', baseUrl: 'https://ant.example.com' },
    ]);
    // Catalog exists but is corrupted — JSON.parse will fail
    await writeFile(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), '{ broken json', 'utf-8');

    // Should throw LL-043 — corrupted catalog means migration can't succeed,
    // and legacy data exists that should have been migrated
    assert.throws(
      () => accountStartupHook(projectRoot),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('LL-043'), 'error should reference LL-043, not a raw JSON parse error');
        return true;
      },
      'LL-043: corrupted catalog + legacy providers must throw LL-043, not a raw parse error',
    );
  });

  it('LL-043: throws when legacy source exists but catalog has no accounts after migration', async () => {
    const { accountStartupHook } = await import(`../dist/config/account-startup.js?t=${Date.now()}-3`);

    // Legacy provider-profiles.json exists with a profile
    await writeV3Meta([
      { id: 'custom-ant', authType: 'api_key', protocol: 'anthropic', baseUrl: 'https://ant.example.com' },
    ]);
    // Catalog exists but has NO accounts — simulates migration failing silently
    // (e.g. writeCatCatalog throws inside migrateProviderProfilesToAccounts, but the
    // function is wrapped in a caller's try/catch that swallows the error)
    await writeCatalog(projectRoot, {});

    // The hook runs migration first. If migration succeeds, accounts will be present
    // and the invariant won't fire. To test the invariant, we need migration to
    // "succeed" but NOT write accounts. We simulate this by writing a catalog
    // that already "has" the old IDs (so migration skips as already-migrated)
    // but then removing them.
    // Simpler approach: write catalog with the ID so migration skips,
    // then remove accounts to trigger the invariant.
    // Actually: migration will run and succeed here (adding accounts).
    // The invariant only fires when migration fails silently AND leaves 0 accounts.

    // To properly test: we need migration to return without writing accounts.
    // This happens when catalog is null (no-catalog reason). But then there's no catalog to read.
    // Better: remove the catalog file to make migration return no-catalog,
    // but the invariant checks hasLegacyProviderProfiles + readCatalogAccounts.
    // If there's no catalog at all, readCatalogAccounts returns {} — invariant fires.
    const { rm: rmSync } = await import('node:fs');
    const { unlinkSync } = await import('node:fs');
    unlinkSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'));

    assert.throws(
      () => accountStartupHook(projectRoot),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('LL-043'), 'error should reference LL-043');
        assert.ok(err.message.includes('legacy'), 'error should mention legacy source');
        return true;
      },
      'LL-043: must throw when legacy exists but no accounts in catalog',
    );
  });
});
