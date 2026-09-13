/**
 * Split-root invariants that remain after upstream dual-root adjudication.
 *
 * SUNSET (2026-09-09, origin↔upstream integration): the old runtime→workspace
 * migrate-on-read / runtime-migration.json cutover suite is retired. Ordinary
 * catalog reads are pure; dual-root conflicts are adjudicated in-memory by
 * account-store-snapshot / account-store-adjudication.test.js; format migrations
 * run only from accountStartupHook / write / explicit migrateCatalogAccounts.
 *
 * This file keeps the still-valid safety surface: lexical redirect, workspace
 * resolve from a runtime-root reader, GLOBAL override, write-root redirect,
 * prototype-named unknown refs, and "ordinary read never writes".
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
const { writeCredential } = await import('../dist/config/credentials.js');
const { resolveByAccountRef } = await import('../dist/config/account-resolver.js');
const { redirectRuntimePathLexical, resolvePersistentProjectPath } = await import(
  '../dist/utils/persistent-project-path.js'
);

const ENV_KEYS = [
  'CAT_CAFE_RUNTIME_ROOT',
  'CAT_CAFE_WORKSPACE_ROOT',
  'CAT_CAFE_GLOBAL_CONFIG_ROOT',
  'HOME',
  'USERPROFILE',
  'CAT_CAFE_TEST_SANDBOX',
];
const savedEnv = {};

describe('accounts split-root (dual-root topology; no migrate-on-read)', () => {
  let runtimeRoot;
  let workspaceRoot;
  let fakeHome;

  beforeEach(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    runtimeRoot = await mkdtemp(join(tmpdir(), 'split-root-runtime-'));
    workspaceRoot = await mkdtemp(join(tmpdir(), 'split-root-workspace-'));
    fakeHome = await mkdtemp(join(tmpdir(), 'split-root-home-'));
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    await mkdir(join(runtimeRoot, '.cat-cafe'), { recursive: true });
    await mkdir(join(workspaceRoot, '.cat-cafe'), { recursive: true });
    resetMigrationState();
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    resetMigrationState();
    await rm(runtimeRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  function setSplitEnv() {
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;
  }

  async function writeWorkspaceAccount() {
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify(
        {
          'my-claude-20x': {
            authType: 'api_key',
            clientId: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            displayName: 'my-claude-20x',
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
  }

  it('redirectRuntimePathLexical maps runtime-root paths to the workspace (synchronous, no IO)', () => {
    setSplitEnv();
    assert.equal(redirectRuntimePathLexical(runtimeRoot), resolve(workspaceRoot));
    assert.equal(
      redirectRuntimePathLexical(join(runtimeRoot, 'packages', 'api')),
      resolve(workspaceRoot, 'packages', 'api'),
    );
    assert.equal(redirectRuntimePathLexical('/tmp/unrelated-project'), '/tmp/unrelated-project');
  });

  it('redirectRuntimePathLexical is a no-op when only one env root is set', () => {
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    assert.equal(redirectRuntimePathLexical(runtimeRoot), runtimeRoot);
  });

  it('resolvePersistentProjectPath (async) agrees with the lexical redirect for runtime root', async () => {
    setSplitEnv();
    assert.equal(await resolvePersistentProjectPath(runtimeRoot), realpathSync(workspaceRoot));
  });

  it('readers resolve workspace accounts from a runtime-root reader without writing', async () => {
    setSplitEnv();
    await writeWorkspaceAccount();
    await writeFile(
      join(runtimeRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({ 'stale-runtime-only': { authType: 'api_key', clientId: 'openai' } }, null, 2),
      'utf-8',
    );

    const beforeWs = readFileSync(join(workspaceRoot, '.cat-cafe', 'accounts.json'), 'utf-8');
    const accounts = readCatalogAccounts(runtimeRoot);
    assert.ok('my-claude-20x' in accounts, 'workspace account must resolve from runtime-root reader');
    assert.equal(
      readFileSync(join(workspaceRoot, '.cat-cafe', 'accounts.json'), 'utf-8'),
      beforeWs,
      'ordinary read must not rewrite the workspace store',
    );
    assert.equal(
      existsSync(join(workspaceRoot, '.cat-cafe', 'runtime-migration.json')),
      false,
      'ordinary read must never write the retired cutover marker',
    );
  });

  it('resolveByAccountRef finds a workspace-only account from a runtime-root reader', async () => {
    setSplitEnv();
    await writeWorkspaceAccount();

    const profile = resolveByAccountRef(runtimeRoot, 'my-claude-20x');
    assert.ok(profile, 'bound custom account must resolve even though reader passes runtime root');
    assert.equal(profile.id, 'my-claude-20x');
  });

  it('divergent same-id dual-root metadata fails closed without writing (adjudication, not migrate-on-read)', async () => {
    setSplitEnv();
    await writeFile(
      join(runtimeRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify(
        { 'max20x-2': { authType: 'api_key', clientId: 'anthropic', displayName: 'stale-name' } },
        null,
        2,
      ),
      'utf-8',
    );
    await writeFile(
      join(workspaceRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify(
        { 'max20x-2': { authType: 'api_key', clientId: 'anthropic', displayName: 'fresh-name' } },
        null,
        2,
      ),
      'utf-8',
    );
    const beforeWs = readFileSync(join(workspaceRoot, '.cat-cafe', 'accounts.json'), 'utf-8');

    // Listing is partial (unavailableAccounts); resolving the rejected ref still throws.
    const listed = readCatalogAccounts(runtimeRoot);
    assert.equal('max20x-2' in listed, false, 'divergent ref must not appear as a resolved listing entry');
    assert.throws(() => resolveByAccountRef(runtimeRoot, 'max20x-2'), /divergent|torn|reconcile|conflict/i);
    assert.equal(readFileSync(join(workspaceRoot, '.cat-cafe', 'accounts.json'), 'utf-8'), beforeWs);
    assert.equal(existsSync(join(workspaceRoot, '.cat-cafe', 'runtime-migration.json')), false);
  });

  it('no store cutover when CAT_CAFE_GLOBAL_CONFIG_ROOT is set (explicit override wins)', async () => {
    setSplitEnv();
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = workspaceRoot;
    await writeFile(
      join(runtimeRoot, '.cat-cafe', 'accounts.json'),
      JSON.stringify({ stale: { authType: 'api_key', clientId: 'openai' } }, null, 2),
      'utf-8',
    );

    const accounts = readCatalogAccounts(runtimeRoot);
    assert.equal('stale' in accounts, false, 'GLOBAL_CONFIG_ROOT target store must not import runtime data');
    assert.equal(
      redirectRuntimePathLexical(runtimeRoot),
      resolve(workspaceRoot),
      'lexical redirect is root-only, env override is store-level',
    );
  });

  it('credentials written via runtime-root writer land in the workspace store', async () => {
    setSplitEnv();
    writeCredential('my-claude-20x', { apiKey: 'sk-new' }, runtimeRoot);

    const wsCredPath = join(workspaceRoot, '.cat-cafe', 'credentials.json');
    assert.ok(existsSync(wsCredPath), 'credential must be written into the workspace store');
    const wsCreds = JSON.parse(readFileSync(wsCredPath, 'utf-8'));
    assert.equal(wsCreds['my-claude-20x'].apiKey, 'sk-new');
    assert.equal(
      existsSync(join(runtimeRoot, '.cat-cafe', 'credentials.json')),
      false,
      'write root is workspace primary, not the disposable runtime checkout',
    );
  });

  for (const ref of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
    it(`resolveByAccountRef("${ref}") is an unknown ref, not an inherited builtin (R19 P1)`, async () => {
      setSplitEnv();
      await writeFile(join(workspaceRoot, '.cat-cafe', 'accounts.json'), '{"real":{"authType":"api_key"}}', 'utf-8');

      assert.equal(
        resolveByAccountRef(runtimeRoot, ref),
        null,
        `a ref named ${ref} names no account, so it must resolve to null — never a synthesised builtin`,
      );
    });
  }
});
