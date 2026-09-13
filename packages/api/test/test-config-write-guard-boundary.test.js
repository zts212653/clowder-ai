/**
 * P1-5: the test persistence boundary must be fail-CLOSED by default.
 *
 * A cat's shell is launched by the running API process, which exports
 * CAT_CAFE_RUNTIME_ROOT / CAT_CAFE_WORKSPACE_ROOT pointing at the live stores.
 * scripts/with-test-home.sh strips those roots, but it is an OPTIONAL
 * entrypoint — safety must not depend on remembering it.
 *
 * After dual-root adjudication, ordinary catalog reads are pure (no cutover
 * writes). The boundary that remains: a bare `node --test` must refuse to READ
 * or WRITE inherited outer store roots; explicit migrateCatalogAccounts stays
 * under the same write guard.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_ACCOUNTS_DIST = join(__dirname, '..', 'dist', 'config', 'catalog-accounts.js');

const tempRoots = [];
function makeTemp(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/**
 * Fake outer stores + an inner test whose project path sits UNDER the inherited
 * runtime root. Dual-root topology only selects the workspace primary when the
 * reader path is under RUNTIME_ROOT — that is the live-shell hazard P1-5 guards.
 */
function buildFixture() {
  const runtimeRoot = makeTemp('p15-outer-runtime-');
  const workspaceRoot = makeTemp('p15-outer-workspace-');
  const fakeHome = makeTemp('p15-fake-home-');
  const projectRoot = join(runtimeRoot, 'packages', 'api');
  const innerDir = makeTemp('p15-inner-test-');

  mkdirSync(join(runtimeRoot, '.cat-cafe'), { recursive: true });
  mkdirSync(join(workspaceRoot, '.cat-cafe'), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(runtimeRoot, '.cat-cafe', 'accounts.json'),
    `${JSON.stringify({ outer: { authType: 'api_key', clientId: 'anthropic', displayName: 'outer' } }, null, 2)}\n`,
  );
  writeFileSync(
    join(runtimeRoot, '.cat-cafe', 'credentials.json'),
    `${JSON.stringify({ outer: { apiKey: 'sk-outer-should-never-move' } }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const innerTest = join(innerDir, 'inner.test.mjs');
  writeFileSync(
    innerTest,
    [
      "import { test } from 'node:test';",
      `import { readCatalogAccounts } from ${JSON.stringify(CATALOG_ACCOUNTS_DIST)};`,
      "test('reading the catalog must not reach the inherited outer store', () => {",
      `  readCatalogAccounts(${JSON.stringify(projectRoot)});`,
      '});',
      '',
    ].join('\n'),
  );

  return { runtimeRoot, workspaceRoot, fakeHome, innerTest, innerDir, projectRoot };
}

function runBareChild({ runtimeRoot, workspaceRoot, fakeHome, innerTest }, extraEnv = {}) {
  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
  for (const key of [
    'NODE_TEST_CONTEXT',
    'CAT_CAFE_TEST_SANDBOX',
    'CAT_CAFE_TEST_REAL_HOME',
    'CAT_CAFE_GLOBAL_CONFIG_ROOT',
    'CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT',
  ]) {
    delete env[key];
  }
  env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
  env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;
  Object.assign(env, extraEnv);

  const res = spawnSync(process.execPath, ['--test', innerTest], { encoding: 'utf-8', env });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

function outerArtifacts(workspaceRoot) {
  return {
    accounts: existsSync(join(workspaceRoot, '.cat-cafe', 'accounts.json')),
    credentials: existsSync(join(workspaceRoot, '.cat-cafe', 'credentials.json')),
    marker: existsSync(join(workspaceRoot, '.cat-cafe', 'runtime-migration.json')),
  };
}

describe('test persistence boundary (P1-5)', () => {
  it('a bare `node --test` inheriting store roots fails before writing anything outside its fixture', () => {
    const fixture = buildFixture();
    const { status, out } = runBareChild(fixture);

    const written = outerArtifacts(fixture.workspaceRoot);
    assert.deepEqual(
      written,
      { accounts: false, credentials: false, marker: false },
      `no outer store file may be created. Child output:\n${out}`,
    );
    assert.notEqual(status, 0, `the child must FAIL, not silently exit 0. Output:\n${out}`);
    assert.match(out, /\[test sandbox\] Refusing/, 'the failure must name the boundary that refused');
    assert.match(out, /inherited from the launching process/);
  });

  /**
   * Positive control for the READ refusal above: with the escape hatch, the
   * same ordinary read is allowed to open the inherited roots. Ordinary reads
   * stay pure — still no cutover write / marker — which is what proves the
   * refusal was the guard, not "migration somehow disabled".
   */
  it('the same fixture can read inherited roots when the guard is opted out, still without cutover writes', () => {
    const fixture = buildFixture();
    const { status, out } = runBareChild(fixture, { CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT: '1' });

    assert.equal(status, 0, `escape hatch must allow the ordinary read. Output:\n${out}`);
    assert.deepEqual(
      outerArtifacts(fixture.workspaceRoot),
      { accounts: false, credentials: false, marker: false },
      `ordinary read remains pure even when the guard is opted out. Child output:\n${out}`,
    );
  });

  /**
   * Explicit migrate stays guarded: without the escape hatch a bare test child
   * that calls migrateCatalogAccounts against inherited roots must still refuse
   * before writing.
   */
  it('explicit migrateCatalogAccounts against inherited roots is still refused in a bare test child', () => {
    const fixture = buildFixture();
    const migrateTest = join(fixture.innerDir, 'migrate-inner.test.mjs');
    writeFileSync(
      migrateTest,
      [
        "import { test } from 'node:test';",
        `import { migrateCatalogAccounts } from ${JSON.stringify(CATALOG_ACCOUNTS_DIST)};`,
        "test('explicit migrate must hit the write guard', () => {",
        `  migrateCatalogAccounts(${JSON.stringify(fixture.projectRoot)});`,
        '});',
        '',
      ].join('\n'),
    );

    const { status, out } = runBareChild({ ...fixture, innerTest: migrateTest });
    assert.notEqual(status, 0, `explicit migrate must FAIL closed. Output:\n${out}`);
    assert.match(out, /\[test sandbox\] Refusing/);
    assert.deepEqual(outerArtifacts(fixture.workspaceRoot), {
      accounts: false,
      credentials: false,
      marker: false,
    });
  });

  /**
   * Production (non-test) ordinary read against the same roots stays pure —
   * dual-root adjudication replaced cutover, so a plain node -e read must not
   * create workspace accounts/credentials/marker as a side effect.
   */
  it('a production (non-test) ordinary read against the same roots stays pure (no cutover write)', () => {
    const fixture = buildFixture();
    const env = { ...process.env, HOME: fixture.fakeHome, USERPROFILE: fixture.fakeHome };
    for (const key of [
      'NODE_TEST_CONTEXT',
      'CAT_CAFE_TEST_SANDBOX',
      'CAT_CAFE_TEST_REAL_HOME',
      'CAT_CAFE_GLOBAL_CONFIG_ROOT',
      'CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT',
    ]) {
      delete env[key];
    }
    env.CAT_CAFE_RUNTIME_ROOT = fixture.runtimeRoot;
    env.CAT_CAFE_WORKSPACE_ROOT = fixture.workspaceRoot;

    const res = spawnSync(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(CATALOG_ACCOUNTS_DIST)}).then((m) => m.readCatalogAccounts(${JSON.stringify(
          fixture.projectRoot,
        )}));`,
      ],
      { encoding: 'utf-8', env },
    );

    assert.equal(res.status, 0, `production ordinary read must succeed: ${res.stdout}${res.stderr}`);
    assert.deepEqual(
      outerArtifacts(fixture.workspaceRoot),
      { accounts: false, credentials: false, marker: false },
      'production ordinary read must not resurrect runtime→workspace cutover writes',
    );
  });

  it('the passwd home stays protected when CAT_CAFE_TEST_REAL_HOME names a fake one (P1-7)', async () => {
    const { assertSafeTestConfigRoot } = await import('../dist/config/test-config-write-guard.js');
    const passwdHome = userInfo().homedir;
    const fakeRealHome = makeTemp('p17-fake-real-home-');
    const saved = process.env.CAT_CAFE_TEST_REAL_HOME;
    try {
      process.env.CAT_CAFE_TEST_REAL_HOME = fakeRealHome;
      assert.throws(
        () => assertSafeTestConfigRoot(passwdHome, 'p17.probe'),
        /\[test sandbox\] Refusing/,
        'the passwd home must stay in the protected set no matter what the env claims',
      );
      assert.throws(() => assertSafeTestConfigRoot(fakeRealHome, 'p17.probe'), /\[test sandbox\] Refusing/);
      assert.doesNotThrow(() => assertSafeTestConfigRoot(makeTemp('p17-neutral-'), 'p17.probe'));
    } finally {
      if (saved === undefined) delete process.env.CAT_CAFE_TEST_REAL_HOME;
      else process.env.CAT_CAFE_TEST_REAL_HOME = saved;
    }
  });

  it('the guard is active on NODE_TEST_CONTEXT alone, without the wrapper opt-in flag', async () => {
    const { assertSafeTestConfigRoot } = await import('../dist/config/test-config-write-guard.js');
    assert.ok(process.env.NODE_TEST_CONTEXT, 'precondition: running under the node test runner');
    const saved = process.env.CAT_CAFE_TEST_REAL_HOME;
    try {
      process.env.CAT_CAFE_TEST_REAL_HOME = '/p15-guard-probe-home';
      assert.throws(
        () => assertSafeTestConfigRoot('/p15-guard-probe-home', 'p15.probe'),
        /\[test sandbox\] Refusing/,
        'HOME must stay refused regardless of how the test process was launched',
      );
    } finally {
      if (saved === undefined) delete process.env.CAT_CAFE_TEST_REAL_HOME;
      else process.env.CAT_CAFE_TEST_REAL_HOME = saved;
    }
  });
});
