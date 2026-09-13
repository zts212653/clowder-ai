/**
 * P1-8: the test persistence boundary must cover READS, not only writes.
 *
 * §19/§21 guarded every writer, so a bare `node --test` could no longer corrupt
 * an inherited store. But nothing corrupted is not the same as nothing leaked:
 * the guard only ran from writeCredential()/writeAllGlobal()/the migration's
 * write step, so whenever no write was attempted — an empty runtime source, an
 * already-matching migration marker, or a plain read — a test process resolved
 * the operator's real accounts.json and credentials.json and exited 0.
 *
 * "Tests use an isolated store" is a data boundary. A credential a test can
 * read is already out, whether or not anything was written afterwards.
 *
 * These tests spawn children the unsafe way ON PURPOSE — bare `node --test`,
 * no wrapper, no opt-in flag — against mkdtemp fixtures only. No assertion ever
 * prints a credential value; the children report booleans (P1-1).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'dist', 'config');
const CREDENTIALS_DIST = join(DIST, 'credentials.js');
const CATALOG_ACCOUNTS_DIST = join(DIST, 'catalog-accounts.js');
const PROBE_SECRET = 'sk-p18-probe-must-stay-unreadable';

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
 * 砚砚's R10 repro shape: fake runtime root, fake workspace store that already
 * holds accounts + credentials, fake HOME. The runtime source is deliberately
 * EMPTY so the runtime→workspace migration can never fire — the read is the
 * only thing under test.
 */
function buildFixture() {
  const runtimeRoot = makeTemp('p18-outer-runtime-');
  const workspaceRoot = makeTemp('p18-outer-workspace-');
  const fakeHome = makeTemp('p18-fake-home-');
  const innerDir = makeTemp('p18-inner-test-');

  mkdirSync(join(workspaceRoot, '.cat-cafe'), { recursive: true });
  writeFileSync(
    join(workspaceRoot, '.cat-cafe', 'accounts.json'),
    `${JSON.stringify({ probe: { authType: 'api_key', clientId: 'anthropic', displayName: 'probe' } }, null, 2)}\n`,
  );
  writeFileSync(
    join(workspaceRoot, '.cat-cafe', 'credentials.json'),
    `${JSON.stringify({ probe: { apiKey: PROBE_SECRET } }, null, 2)}\n`,
    { mode: 0o600 },
  );

  return { runtimeRoot, workspaceRoot, fakeHome, innerDir };
}

/**
 * Body of the child test. Reports only whether the probe credential came back
 * intact — never the value itself.
 */
function credentialReadSnippet(workspaceRoot) {
  return [
    `import { readCredential } from ${JSON.stringify(CREDENTIALS_DIST)};`,
    `const entry = readCredential('probe', ${JSON.stringify(workspaceRoot)});`,
    `console.log('READ_OUTER_CREDENTIAL=' + String(entry?.apiKey === ${JSON.stringify(PROBE_SECRET)}));`,
  ];
}

function accountsReadSnippet(workspaceRoot) {
  return [
    `import { readCatalogAccounts } from ${JSON.stringify(CATALOG_ACCOUNTS_DIST)};`,
    `const accounts = readCatalogAccounts(${JSON.stringify(workspaceRoot)});`,
    "console.log('READ_OUTER_ACCOUNT=' + String(Boolean(accounts?.probe)));",
  ];
}

function writeInnerTest(fixture, name, snippet) {
  const innerTest = join(fixture.innerDir, `${name}.test.mjs`);
  // Static imports must sit at module top level, so the snippet's import lines
  // are hoisted out of the generated test body.
  const imports = snippet.filter((line) => line.startsWith('import '));
  const body = snippet.filter((line) => !line.startsWith('import '));
  writeFileSync(
    innerTest,
    [
      "import { test } from 'node:test';",
      ...imports,
      `test('${name}', () => {`,
      ...body.map((l) => `  ${l}`),
      '});',
      '',
    ].join('\n'),
  );
  return innerTest;
}

function childEnv(fixture, extraEnv = {}) {
  const env = { ...process.env, HOME: fixture.fakeHome, USERPROFILE: fixture.fakeHome };
  // Deleted, not blanked: node treats an inherited NODE_TEST_CONTEXT — even
  // empty — as "already inside a run" and silently skips the child's file,
  // which would make every assertion below pass for the wrong reason.
  for (const key of [
    'NODE_TEST_CONTEXT',
    'CAT_CAFE_TEST_SANDBOX',
    'CAT_CAFE_TEST_REAL_HOME',
    'CAT_CAFE_TEST_SANDBOX_ROOT',
    'CAT_CAFE_GLOBAL_CONFIG_ROOT',
    'CAT_CAFE_RUNTIME_ROOT',
    'CAT_CAFE_WORKSPACE_ROOT',
    'CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT',
  ]) {
    delete env[key];
  }
  env.CAT_CAFE_RUNTIME_ROOT = fixture.runtimeRoot;
  env.CAT_CAFE_WORKSPACE_ROOT = fixture.workspaceRoot;
  Object.assign(env, extraEnv);
  return env;
}

function runBareChild(fixture, innerTest, extraEnv = {}) {
  const res = spawnSync(process.execPath, ['--test', innerTest], {
    encoding: 'utf-8',
    env: childEnv(fixture, extraEnv),
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

describe('account store read boundary (P1-8)', () => {
  it('a bare `node --test` cannot read credentials out of an inherited store', () => {
    const fixture = buildFixture();
    const innerTest = writeInnerTest(fixture, 'read-credential', credentialReadSnippet(fixture.workspaceRoot));
    const { status, out } = runBareChild(fixture, innerTest);

    assert.notEqual(status, 0, `reading an inherited store must FAIL, not exit 0. Output:\n${out}`);
    assert.match(out, /\[test sandbox\] Refusing/, 'the failure must name the boundary that refused');
    assert.match(out, /inherited from the launching process/);
    assert.doesNotMatch(
      out,
      /READ_OUTER_CREDENTIAL=true/,
      'the credential must never come back — refusing after the read is not a boundary',
    );
  });

  /**
   * The migration is not what saves us here: an inherited CAT_CAFE_GLOBAL_CONFIG_ROOT
   * makes migrateRuntimeStaleAccountsToWorkspace() return on its first line
   * (INV-2), so no write is even attempted and the old code exited 0 with the
   * account in hand. Only readAllGlobal's own guard can refuse this.
   */
  it('a bare `node --test` cannot read the account catalog out of an inherited store', () => {
    const fixture = buildFixture();
    const innerTest = writeInnerTest(fixture, 'read-accounts', accountsReadSnippet(fixture.workspaceRoot));
    const { status, out } = runBareChild(fixture, innerTest, {
      CAT_CAFE_GLOBAL_CONFIG_ROOT: fixture.workspaceRoot,
    });

    assert.notEqual(status, 0, `reading an inherited store must FAIL. Output:\n${out}`);
    assert.match(out, /\[test sandbox\] Refusing/);
    assert.doesNotMatch(out, /READ_OUTER_ACCOUNT=true/);
  });

  /**
   * Upstream replaced runtime→workspace marker migration with dual-root
   * topology adjudication. Naming an inherited workspace as the explicit
   * projectRoot must still refuse before accounts/credentials open.
   */
  it('a bare `node --test` cannot read an inherited workspace named as projectRoot', () => {
    const fixture = buildFixture();
    const innerTest = writeInnerTest(fixture, 'read-inherited-workspace', accountsReadSnippet(fixture.workspaceRoot));
    const { status, out } = runBareChild(fixture, innerTest);

    assert.notEqual(status, 0, `inherited workspace projectRoot must FAIL closed. Output:\n${out}`);
    assert.match(out, /\[test sandbox\] Refusing/);
    assert.match(
      out,
      /account-store-snapshot\.readStore|catalog-accounts\.|inherited from the launching process/,
      'the refusal must come from a store read guard before data returns',
    );
    assert.doesNotMatch(out, /READ_OUTER_ACCOUNT=true/);
  });

  /**
   * Positive control. Without it the refusals above could just mean the fixture
   * is unreadable for some unrelated reason, proving nothing. With the
   * documented escape hatch the SAME fixture must really hand the probe back.
   */
  it('the same fixture really is readable when the guard is opted out', () => {
    const fixture = buildFixture();
    const innerTest = writeInnerTest(fixture, 'read-optout', credentialReadSnippet(fixture.workspaceRoot));
    const { status, out } = runBareChild(fixture, innerTest, { CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT: '1' });

    assert.equal(status, 0, `the escape hatch must reproduce the original read. Output:\n${out}`);
    assert.match(out, /READ_OUTER_CREDENTIAL=true/, 'the fixture must genuinely contain a readable probe');
  });

  /**
   * The boundary must not have been bought by breaking the reader. Production
   * is a plain non-test process and must still read its own store.
   */
  it('a production (non-test) process still reads the same store', () => {
    const fixture = buildFixture();
    const res = spawnSync(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(CREDENTIALS_DIST)}).then((m) => {
           const entry = m.readCredential('probe', ${JSON.stringify(fixture.workspaceRoot)});
           console.log('READ_OUTER_CREDENTIAL=' + String(entry?.apiKey === ${JSON.stringify(PROBE_SECRET)}));
         });`,
      ],
      { encoding: 'utf-8', env: childEnv(fixture) },
    );
    const out = `${res.stdout}${res.stderr}`;

    assert.equal(res.status, 0, `production reads must still succeed: ${out}`);
    assert.match(out, /READ_OUTER_CREDENTIAL=true/, 'the guard is a TEST boundary, not a reader kill switch');
  });

  /**
   * A test that names its OWN fixture as the store must keep working — the
   * boundary is about inherited roots, not about reads in general. Without
   * this, "guard everything" would look identical to "break every suite".
   */
  it('a test-chosen fixture root is still readable', () => {
    const fixture = buildFixture();
    const own = makeTemp('p18-own-fixture-');
    mkdirSync(join(own, '.cat-cafe'), { recursive: true });
    writeFileSync(
      join(own, '.cat-cafe', 'credentials.json'),
      `${JSON.stringify({ probe: { apiKey: PROBE_SECRET } })}\n`,
      { mode: 0o600 },
    );
    const innerTest = writeInnerTest(fixture, 'read-own-fixture', credentialReadSnippet(own));
    const { status, out } = runBareChild(fixture, innerTest);

    assert.equal(status, 0, `a test's own fixture must stay readable. Output:\n${out}`);
    assert.match(out, /READ_OUTER_CREDENTIAL=true/);
  });
});

/**
 * P1-9: migration sources must be guarded at first open.
 *
 * Ordinary catalog reads are pure (no migrate-on-read). Format migrations run
 * only from accountStartupHook / write / explicit migrateCatalogAccounts, and
 * those paths open $HOME credentials, legacy provider-profiles, and the project
 * catalog — then COPY what they find into the caller's store. Guarding only the
 * final reader is too late; the crossing has already happened.
 *
 * A protected HOME is stood in for by a mkdtemp dir declared through
 * CAT_CAFE_TEST_REAL_HOME (砚砚's R11 shape). The operator's real home is never
 * read, written or listed by any test here.
 */
const HOME_PROBE_SECRET = 'sk-p19-home-credential-must-not-be-copied';

/** A HOME whose .cat-cafe/credentials.json holds a builtin-ref probe. */
function seedHomeCredential(home) {
  mkdirSync(join(home, '.cat-cafe'), { recursive: true });
  writeFileSync(
    join(home, '.cat-cafe', 'credentials.json'),
    `${JSON.stringify({ codex: { apiKey: HOME_PROBE_SECRET } })}\n`,
    {
      mode: 0o600,
    },
  );
}

/** True iff the HOME probe ended up inside `root`'s store. Never prints it. */
function homeCredentialLandedIn(root) {
  const path = join(root, '.cat-cafe', 'credentials.json');
  if (!existsSync(path)) return false;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))?.codex?.apiKey === HOME_PROBE_SECRET;
  } catch {
    return false;
  }
}

/**
 * No inherited store roots at all: whatever refuses here can only be a
 * migration's own source guard, never the inherited-root check.
 */
function homeMigrationEnv(home, extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of [
    'NODE_TEST_CONTEXT',
    'CAT_CAFE_TEST_SANDBOX',
    'CAT_CAFE_TEST_REAL_HOME',
    'CAT_CAFE_TEST_SANDBOX_ROOT',
    'CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT',
    'CAT_CAFE_GLOBAL_CONFIG_ROOT',
    'CAT_CAFE_RUNTIME_ROOT',
    'CAT_CAFE_WORKSPACE_ROOT',
    'CAT_CAFE_SKIP_HOMEDIR_MIGRATION',
  ]) {
    delete env[key];
  }
  Object.assign(env, extraEnv);
  return env;
}

function catalogMigrateInnerTest(innerDir, name, projectRoot) {
  const innerTest = join(innerDir, `${name}.test.mjs`);
  writeFileSync(
    innerTest,
    [
      "import { test } from 'node:test';",
      `import { migrateCatalogAccounts } from ${JSON.stringify(CATALOG_ACCOUNTS_DIST)};`,
      `test('${name}', () => {`,
      `  migrateCatalogAccounts(${JSON.stringify(projectRoot)});`,
      "  console.log('CATALOG_MIGRATE_OK=true');",
      '});',
      '',
    ].join('\n'),
  );
  return innerTest;
}

describe('account migration source boundary (P1-9)', () => {
  it('a bare `node --test` cannot copy credentials out of a protected HOME', () => {
    const home = makeTemp('p19-protected-home-');
    const project = makeTemp('p19-own-project-');
    seedHomeCredential(home);

    const innerTest = catalogMigrateInnerTest(makeTemp('p19-inner-'), 'home-cred-source', project);
    const res = spawnSync(process.execPath, ['--test', innerTest], {
      encoding: 'utf-8',
      // The fake home is DECLARED protected, which is what the operator's real
      // passwd home is at runtime — without ever touching the real one.
      env: homeMigrationEnv(home, { CAT_CAFE_TEST_REAL_HOME: home }),
    });
    const out = `${res.stdout}${res.stderr}`;

    assert.equal(
      homeCredentialLandedIn(project),
      false,
      `the HOME credential must never reach the fixture — copying first and refusing later is not a boundary. Output:\n${out}`,
    );
    assert.notEqual(res.status, 0, `the migration must FAIL, not exit 0. Output:\n${out}`);
    assert.match(out, /\[test sandbox\] Refusing/);
    assert.match(
      out,
      /migrateHomedirCredentials\.source/,
      'the refusal must come from the HOME source guard itself, not from a later reader',
    );
  });

  /**
   * The other half of the same migration: it reads and rewrites the TARGET
   * store's credentials.json before readAllGlobal() ever runs. Here the HOME is
   * a plain undeclared fixture (safe) and the target is the inherited root, so
   * only the target guard can produce this refusal.
   */
  it('a bare `node --test` cannot read the migration target store either', () => {
    const fixture = buildFixture();
    seedHomeCredential(fixture.fakeHome);

    const innerTest = catalogMigrateInnerTest(fixture.innerDir, 'home-cred-target', fixture.workspaceRoot);
    const { status, out } = runBareChild(fixture, innerTest);

    assert.notEqual(status, 0, `reading the inherited target must FAIL. Output:\n${out}`);
    assert.match(out, /\[test sandbox\] Refusing/);
    assert.match(out, /migrateHomedirCredentials\.target/);
  });

  /**
   * The legacy provider-profiles path, which carries
   * provider-profiles.secrets.local.json — API keys in plain text. Homedir
   * migration is switched off with the documented #506 flag so that the only
   * guard able to refuse is migrateLegacyFrom's own.
   */
  it('a bare `node --test` cannot read legacy provider profiles out of an inherited store', () => {
    const fixture = buildFixture();
    const innerTest = catalogMigrateInnerTest(fixture.innerDir, 'legacy-source', fixture.workspaceRoot);
    const { status, out } = runBareChild(fixture, innerTest, { CAT_CAFE_SKIP_HOMEDIR_MIGRATION: '1' });

    assert.notEqual(status, 0, `reading an inherited legacy source must FAIL. Output:\n${out}`);
    assert.match(out, /\[test sandbox\] Refusing/);
    assert.match(out, /migrateLegacyFrom\.source/);
  });

  /**
   * The HOME legacy provider-profiles path — the one carrying
   * provider-profiles.secrets.local.json, i.e. API keys in plain text.
   *
   * It is reached through a different door than the test above: when the store
   * root IS the home, migrateHomedirCredentials() short-circuits by design
   * ("already covered by migrateLegacyProviderProfiles"), so the guard that
   * refuses here is migrateLegacyFrom's own, not the homedir-credentials one.
   */
  it('a bare `node --test` cannot read HOME legacy profiles when HOME is the store root', () => {
    const home = makeTemp('p19-legacy-home-');
    mkdirSync(join(home, '.cat-cafe'), { recursive: true });
    writeFileSync(
      join(home, '.cat-cafe', 'provider-profiles.json'),
      `${JSON.stringify({ profiles: [{ id: 'codex', displayName: 'probe' }] })}\n`,
    );
    writeFileSync(
      join(home, '.cat-cafe', 'provider-profiles.secrets.local.json'),
      `${JSON.stringify({ profiles: { codex: { apiKey: HOME_PROBE_SECRET } } })}\n`,
      { mode: 0o600 },
    );

    const innerTest = catalogMigrateInnerTest(makeTemp('p19-inner-legacy-'), 'home-legacy-source', home);
    const res = spawnSync(process.execPath, ['--test', innerTest], {
      encoding: 'utf-8',
      env: homeMigrationEnv(home, { CAT_CAFE_TEST_REAL_HOME: home }),
    });
    const out = `${res.stdout}${res.stderr}`;

    assert.equal(homeCredentialLandedIn(home), false, `no credential may be materialised. Output:\n${out}`);
    assert.notEqual(res.status, 0, `reading HOME legacy profiles must FAIL. Output:\n${out}`);
    assert.match(out, /\[test sandbox\] Refusing/);
    assert.match(out, /migrateLegacyFrom\.source/);
  });

  /**
   * Positive control #1: a fake HOME the test OWNS (never declared protected) is
   * exactly what every wrapped suite runs with, and it must still migrate. Without
   * this, "guard the HOME source" would be indistinguishable from "break the
   * homedir migration".
   */
  it('a test-owned fake HOME still migrates into the test’s own store', () => {
    const home = makeTemp('p19-owned-home-');
    const project = makeTemp('p19-owned-project-');
    seedHomeCredential(home);

    const innerTest = catalogMigrateInnerTest(makeTemp('p19-inner-owned-'), 'home-owned', project);
    const res = spawnSync(process.execPath, ['--test', innerTest], {
      encoding: 'utf-8',
      env: homeMigrationEnv(home),
    });
    const out = `${res.stdout}${res.stderr}`;

    assert.equal(res.status, 0, `a test-owned home must stay migratable. Output:\n${out}`);
    assert.equal(homeCredentialLandedIn(project), true, `the migration must genuinely run. Output:\n${out}`);
  });

  /**
   * Positive control #2: production. A plain non-test process migrating from the
   * SAME protected home that the test process was refused must still succeed —
   * this is a test boundary, not a migration kill switch.
   */
  it('a production (non-test) process still migrates from the same protected HOME', () => {
    const home = makeTemp('p19-prod-home-');
    const project = makeTemp('p19-prod-project-');
    seedHomeCredential(home);

    const res = spawnSync(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(CATALOG_ACCOUNTS_DIST)}).then((m) => m.migrateCatalogAccounts(${JSON.stringify(project)}));`,
      ],
      { encoding: 'utf-8', env: homeMigrationEnv(home, { CAT_CAFE_TEST_REAL_HOME: home }) },
    );
    const out = `${res.stdout}${res.stderr}`;

    assert.equal(res.status, 0, `production migration must still succeed. Output:\n${out}`);
    assert.equal(homeCredentialLandedIn(project), true, 'production behaviour must be unchanged');
  });
});

/**
 * P1-11: a direct migration reader guards its OWN first open.
 *
 * migrateCatalogAccounts has a fixed order, so an earlier guard on the same
 * root would always refuse first — but the STATE is not fixed. Completion
 * caches live for the whole process while CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT
 * and CAT_CAFE_SKIP_HOMEDIR_MIGRATION are re-read on every call, so a first
 * call made under an explicit opt-out caches away the guard the second call
 * was counting on — and the reader downstream still opens the file.
 *
 * Every test below is that two-phase shape in ONE child process, because a
 * fresh process would reset the caches and hide the defect entirely.
 */
const PROJECT_PROBE_REF = 'p111-project-only-account';

/** A project catalog carrying one account that must not cross the boundary. */
function seedProjectCatalog(projectRoot) {
  mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.cat-cafe', 'cat-catalog.json'),
    `${JSON.stringify({ accounts: { [PROJECT_PROBE_REF]: { client: 'anthropic', mode: 'api_key' } } })}\n`,
  );
}

/** True iff the project-only account ended up in `root`'s global store. */
function projectAccountLandedIn(root) {
  const path = join(root, '.cat-cafe', 'accounts.json');
  if (!existsSync(path)) return false;
  try {
    return PROJECT_PROBE_REF in JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return false;
  }
}

/**
 * Run `lines` inside one bare `node --test` child. CAT_CAFE_GLOBAL_CONFIG_ROOT
 * is assigned INSIDE the child body, after module load, so the target counts as
 * a root the test owns rather than an inherited one — the guard snapshots
 * ambient roots at import time.
 */
function runTwoPhaseChild(name, { protectedRoot, target, home, lines, env = {} }) {
  const innerDir = makeTemp(`${name}-inner-`);
  const innerTest = join(innerDir, `${name}.test.mjs`);
  writeFileSync(
    innerTest,
    [
      "import { test } from 'node:test';",
      `import * as catalog from ${JSON.stringify(CATALOG_ACCOUNTS_DIST)};`,
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      `const PROJECT = ${JSON.stringify(protectedRoot)};`,
      `const TARGET = ${JSON.stringify(target)};`,
      `test('${name}', () => {`,
      '  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = TARGET;',
      ...lines.map((l) => `  ${l}`),
      '});',
      '',
    ].join('\n'),
  );

  const res = spawnSync(process.execPath, ['--test', innerTest], {
    encoding: 'utf-8',
    // The protected root is DECLARED protected the same way §26's tests do it:
    // a mkdtemp dir named by CAT_CAFE_TEST_REAL_HOME. The operator's real home
    // is never read, written or listed.
    env: homeMigrationEnv(home, { CAT_CAFE_TEST_REAL_HOME: protectedRoot, ...env }),
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

describe('direct-reader boundary (P1-11)', () => {
  /**
   * The exact bypass 砚砚 reported. Phase 1 caches migratedProjectLegacy (it
   * caches even with no legacy source present); migrateProjectAccountsToGlobal
   * returns from INSIDE its try and caches nothing. Phase 2 therefore reaches
   * its existsSync/readFileSync with every "earlier" guard already skipped.
   */
  it('a cached earlier migration cannot open the project catalog guard', () => {
    const project = makeTemp('p111-protected-project-');
    const target = makeTemp('p111-target-');
    const { status, out } = runTwoPhaseChild('project-catalog-two-phase', {
      protectedRoot: project,
      target,
      home: makeTemp('p111-home-'),
      lines: [
        '// Phase 1: opt-out ON, no project catalog yet.',
        "process.env.CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT = '1';",
        'catalog.migrateCatalogAccounts(PROJECT);',
        '// Phase 2: protection restored, and now the catalog exists.',
        'delete process.env.CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT;',
        "mkdirSync(join(PROJECT, '.cat-cafe'), { recursive: true });",
        `writeFileSync(join(PROJECT, '.cat-cafe', 'cat-catalog.json'), ${JSON.stringify(
          `${JSON.stringify({ accounts: { [PROJECT_PROBE_REF]: { client: 'anthropic', mode: 'api_key' } } })}\n`,
        )});`,
        'catalog.migrateCatalogAccounts(PROJECT);',
        "console.log('PHASE2_ALLOWED=true');",
      ],
    });

    assert.equal(
      projectAccountLandedIn(target),
      false,
      `the protected project catalog must not be copied into the test's own store. Output:\n${out}`,
    );
    assert.notEqual(status, 0, `phase 2 must FAIL, not exit 0. Output:\n${out}`);
    assert.match(out, /migrateProjectAccountsToGlobal\.source/, 'the refusal must come from the reader that opens it');
    assert.doesNotMatch(out, /PHASE2_ALLOWED=true/);
  });

  /**
   * The other direct reader. Here the skew comes from CAT_CAFE_SKIP_HOMEDIR_MIGRATION:
   * phase 1 skips the homedir migrations entirely (so they cache nothing) while
   * caching the project legacy guard, and phase 2 runs migrateHomedirCredentials,
   * which calls readProjectAccountRefs() on the protected project root.
   */
  it('a cached earlier migration cannot open the project account-ref reader', () => {
    const project = makeTemp('p111-refs-project-');
    const target = makeTemp('p111-refs-target-');
    const home = makeTemp('p111-refs-home-');
    seedHomeCredential(home);
    seedProjectCatalog(project);

    const { status, out } = runTwoPhaseChild('project-refs-two-phase', {
      protectedRoot: project,
      target,
      home,
      lines: [
        '// Phase 1: homedir migrations skipped, so they cache nothing; the',
        '//          project legacy guard is cached away under the opt-out.',
        "process.env.CAT_CAFE_SKIP_HOMEDIR_MIGRATION = '1';",
        "process.env.CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT = '1';",
        'catalog.migrateCatalogAccounts(PROJECT);',
        '// Phase 2: both switches off — migrateHomedirCredentials now runs and',
        '//          asks the protected project which refs it references.',
        'delete process.env.CAT_CAFE_SKIP_HOMEDIR_MIGRATION;',
        'delete process.env.CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT;',
        'catalog.migrateCatalogAccounts(PROJECT);',
        "console.log('PHASE2_ALLOWED=true');",
      ],
    });

    assert.notEqual(status, 0, `phase 2 must FAIL, not exit 0. Output:\n${out}`);
    assert.match(out, /readProjectAccountRefs\.source/, 'the refusal must come from the reader that opens it');
    assert.doesNotMatch(out, /PHASE2_ALLOWED=true/);
  });

  /**
   * Positive control for both: with the opt-out held ON across phase 2, the same
   * two-phase script really does copy the project account across. Without this,
   * the refusals above could just mean the fixture never worked.
   */
  it('the same two-phase script really does copy the account when the guard is opted out', () => {
    const project = makeTemp('p111-control-project-');
    const target = makeTemp('p111-control-target-');
    const { status, out } = runTwoPhaseChild('project-catalog-control', {
      protectedRoot: project,
      target,
      home: makeTemp('p111-control-home-'),
      lines: [
        "process.env.CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT = '1';",
        'catalog.migrateCatalogAccounts(PROJECT);',
        "mkdirSync(join(PROJECT, '.cat-cafe'), { recursive: true });",
        `writeFileSync(join(PROJECT, '.cat-cafe', 'cat-catalog.json'), ${JSON.stringify(
          `${JSON.stringify({ accounts: { [PROJECT_PROBE_REF]: { client: 'anthropic', mode: 'api_key' } } })}\n`,
        )});`,
        'catalog.migrateCatalogAccounts(PROJECT);',
      ],
    });

    assert.equal(status, 0, `the opted-out control must succeed. Output:\n${out}`);
    assert.equal(projectAccountLandedIn(target), true, 'the control must reproduce the original copy');
  });

  /**
   * hasLegacyProviderProfiles() runs no migration at all, so it is always its
   * own first open — there is no "earlier guard" to inherit safety from, in any
   * cache state. Decision-only: both guards throw before anything is opened.
   */
  it('the legacy-profile probe guards both roots it opens', async () => {
    const catalog = await import('../dist/config/catalog-accounts.js');
    const saved = {
      realHome: process.env.CAT_CAFE_TEST_REAL_HOME,
      globalRoot: process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT,
    };
    const store = makeTemp('p111-probe-store-');
    const project = makeTemp('p111-probe-project-');
    try {
      // The store root is the protected one: the project is fine, the store is not.
      process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = store;
      process.env.CAT_CAFE_TEST_REAL_HOME = store;
      assert.throws(
        () => catalog.hasLegacyProviderProfiles(project),
        /hasLegacyProviderProfiles\.store/,
        'probing a protected store root is still a read of it',
      );

      // Now the other way round: safe store, protected project root.
      process.env.CAT_CAFE_TEST_REAL_HOME = project;
      assert.throws(
        () => catalog.hasLegacyProviderProfiles(project),
        /hasLegacyProviderProfiles\.project/,
        'probing a protected project root is still a read of it',
      );

      // Control: neither root protected, so the probe answers normally.
      process.env.CAT_CAFE_TEST_REAL_HOME = makeTemp('p111-probe-elsewhere-');
      assert.equal(catalog.hasLegacyProviderProfiles(project), false);
    } finally {
      if (saved.realHome === undefined) delete process.env.CAT_CAFE_TEST_REAL_HOME;
      else process.env.CAT_CAFE_TEST_REAL_HOME = saved.realHome;
      if (saved.globalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = saved.globalRoot;
    }
  });
});
