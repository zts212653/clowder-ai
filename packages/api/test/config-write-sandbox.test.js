import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('test config write sandbox', () => {
  let previousSandbox;
  let previousGlobalRoot;
  let previousHome;

  afterEach(() => {
    if (previousSandbox === undefined) delete process.env.CAT_CAFE_TEST_SANDBOX;
    else process.env.CAT_CAFE_TEST_SANDBOX = previousSandbox;
    if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;

    previousSandbox = undefined;
    previousGlobalRoot = undefined;
    previousHome = undefined;
  });

  it('blocks low-level account + credential writes to the repo root when sandbox is enabled', async () => {
    const accountsPath = join(REPO_ROOT, '.cat-cafe', 'accounts.json');
    const credentialsPath = join(REPO_ROOT, '.cat-cafe', 'credentials.json');
    const beforeAccounts = existsSync(accountsPath) ? readFileSync(accountsPath, 'utf8') : null;
    const beforeCredentials = existsSync(credentialsPath) ? readFileSync(credentialsPath, 'utf8') : null;

    previousSandbox = process.env.CAT_CAFE_TEST_SANDBOX;
    previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    previousHome = process.env.HOME;
    process.env.CAT_CAFE_TEST_SANDBOX = '1';
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = REPO_ROOT;

    const { resetMigrationState, writeCatalogAccount } = await import('../dist/config/catalog-accounts.js');
    const { writeCredential } = await import('../dist/config/credentials.js');
    resetMigrationState();

    assert.throws(
      () => writeCatalogAccount(REPO_ROOT, 'sandbox-leak', { authType: 'api_key' }),
      /test sandbox|repo root|unsafe/i,
    );
    assert.throws(
      () => writeCredential('sandbox-leak', { apiKey: 'should-not-write' }, REPO_ROOT),
      /test sandbox|repo root|unsafe/i,
    );

    if (beforeAccounts === null) {
      assert.equal(existsSync(accountsPath), false, 'repo accounts.json must stay absent');
    } else {
      assert.equal(readFileSync(accountsPath, 'utf8'), beforeAccounts, 'repo accounts.json must stay unchanged');
    }
    if (beforeCredentials === null) {
      assert.equal(existsSync(credentialsPath), false, 'repo credentials.json must stay absent');
    } else {
      assert.equal(
        readFileSync(credentialsPath, 'utf8'),
        beforeCredentials,
        'repo credentials.json must stay unchanged',
      );
    }
  });

  it('allows repo-root reads when sandboxed code does not need to write', async () => {
    previousSandbox = process.env.CAT_CAFE_TEST_SANDBOX;
    previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    previousHome = process.env.HOME;
    process.env.CAT_CAFE_TEST_SANDBOX = '1';
    delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.HOME = mkdtempSync(join(tmpdir(), 'cat-config-read-home-'));

    const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
    resetMigrationState();

    assert.doesNotThrow(() => {
      const accounts = readCatalogAccounts(REPO_ROOT);
      assert.equal(typeof accounts, 'object');
      assert.ok(accounts && !Array.isArray(accounts));
    });
  });
});
