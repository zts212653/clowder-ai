/**
 * P1-6: the standalone installer's duplicated guard must be fail-CLOSED too.
 *
 * scripts/install-auth-config.mjs carries a hand-copied clone of
 * src/config/test-config-write-guard.ts (both files say "keep the two guards in
 * sync"). §19 fixed only the TS copy, so a test process could still spawn the
 * installer and have it write accounts.json + credentials.json into an outer
 * store while exiting 0 — a second, unguarded writer behind the same boundary.
 *
 * A standalone installer has no module-load seam: it is a fresh child process,
 * so every root arrives from the environment at once and "inherited from the
 * launcher" cannot be told apart from "chosen by the caller" the way the TS
 * guard tells them apart. install.sh:635-641 proves the ambiguity is real — it
 * deliberately writes to a global root that DIFFERS from --project-dir.
 *
 * So the installer uses a positive declaration instead of a blacklist: a test
 * process must name its sandbox via CAT_CAFE_TEST_SANDBOX_ROOT, and writes
 * outside it are refused. Undeclared means refused, not allowed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, noGlobalOverrideEnv, runHelperWithEnv } from './install-auth-config-test-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALLER = resolve(__dirname, '..', '..', '..', 'scripts', 'install-auth-config.mjs');

const tempRoots = [];
function makeTemp(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

const INSTALLER_ARGS = (projectDir) => [
  'client-auth',
  'set',
  '--project-dir',
  projectDir,
  '--client',
  'anthropic',
  '--mode',
  'api_key',
];

/**
 * 砚砚's R8 repro shape: fake HOME, fake project dir, and a fake OUTER global
 * root that stands in for the live store — three distinct dirs, as in the real
 * split-root deployment.
 */
function buildFixture() {
  const fakeHome = makeTemp('p16-fake-home-');
  const projectDir = makeTemp('p16-fake-project-');
  const outerGlobalRoot = makeTemp('p16-fake-outer-global-');
  const innerDir = makeTemp('p16-inner-test-');

  const innerTest = join(innerDir, 'inner.test.mjs');
  writeFileSync(
    innerTest,
    [
      "import { test } from 'node:test';",
      "import { spawnSync } from 'node:child_process';",
      "test('test body spawns the standalone installer', () => {",
      '  const res = spawnSync(process.execPath, [',
      `    ${JSON.stringify(INSTALLER)},`,
      `    ${INSTALLER_ARGS(projectDir)
        .map((a) => JSON.stringify(a))
        .join(', ')}`,
      '  ], {',
      "    encoding: 'utf8',",
      // Realistic: the test body forwards its own env, so NODE_TEST_CONTEXT
      // reaches the installer. No wrapper, no CAT_CAFE_TEST_SANDBOX opt-in.
      '    env: { ...process.env,',
      `      CAT_CAFE_GLOBAL_CONFIG_ROOT: ${JSON.stringify(outerGlobalRoot)},`,
      "      _INSTALLER_API_KEY: 'sk-p16-must-never-be-written' },",
      '  });',
      "  console.log('INSTALLER_EXIT=' + res.status);",
      "  console.log('INSTALLER_ERR=' + String(res.stderr).replace(/\\n/g, ' | '));",
      '});',
      '',
    ].join('\n'),
  );

  return { fakeHome, projectDir, outerGlobalRoot, innerTest };
}

/** Run the outer `node --test` the unsafe way: no wrapper, no sandbox flag. */
function runBareTestRunner(fixture, extraEnv = {}) {
  const env = { ...process.env, HOME: fixture.fakeHome, USERPROFILE: fixture.fakeHome };
  // Must be deleted, not blanked — node treats an inherited NODE_TEST_CONTEXT,
  // even empty, as "already inside a run" and silently skips the child file.
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
  Object.assign(env, extraEnv);

  const res = spawnSync(process.execPath, ['--test', fixture.innerTest], { encoding: 'utf8', env });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

/**
 * Ask the installer's boundary for a decision from inside a REAL `node --test`
 * process, without letting it write: the `test-guard-probe` subcommand
 * evaluates the guard and exits (0 = would allow, 1 = refused, 2 = not a test
 * process) before any store is opened. The decision has to come from a genuine
 * test process, so it is spawned from an inner test file rather than with a
 * hand-set NODE_TEST_CONTEXT.
 *
 * P2-11: the trigger used to be an env var checked ahead of dispatch, which
 * meant a production command that merely inherited it exited 0 having done
 * nothing. It is now an explicit subcommand AND a real test process.
 */
function runGuardProbe(probeRoot, extraEnv = {}) {
  const innerDir = makeTemp('p17-inner-probe-');
  const fakeHome = makeTemp('p17-probe-home-');
  const innerTest = join(innerDir, 'probe.test.mjs');
  writeFileSync(
    innerTest,
    [
      "import { test } from 'node:test';",
      "import { spawnSync } from 'node:child_process';",
      "test('test body probes the installer boundary', () => {",
      `  const args = [${JSON.stringify(INSTALLER)}, 'test-guard-probe', '--root', ${JSON.stringify(probeRoot)}];`,
      '  const res = spawnSync(process.execPath, args, {',
      "    encoding: 'utf8',",
      '    env: process.env,',
      '  });',
      "  console.log('PROBE_EXIT=' + res.status);",
      "  console.log('PROBE_ERR=' + String(res.stderr).replace(/\\n/g, ' | '));",
      '});',
      '',
    ].join('\n'),
  );

  const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
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
  Object.assign(env, extraEnv);

  const res = spawnSync(process.execPath, ['--test', innerTest], { encoding: 'utf8', env });
  const out = `${res.stdout}${res.stderr}`;
  const m = out.match(/PROBE_EXIT=(\S+)/);
  assert.ok(m, `inner test must report the probe exit code. Output:\n${out}`);
  return { status: m[1] === 'null' ? null : Number(m[1]), out };
}

function storeArtifacts(root) {
  return {
    accounts: existsSync(join(root, '.cat-cafe', 'accounts.json')),
    credentials: existsSync(join(root, '.cat-cafe', 'credentials.json')),
  };
}

/** Parse the installer's exit code out of the inner test's stdout. */
function installerExit(out) {
  const m = out.match(/INSTALLER_EXIT=(\S+)/);
  assert.ok(m, `inner test must report the installer exit code. Output:\n${out}`);
  return m[1] === 'null' ? null : Number(m[1]);
}

describe('standalone installer persistence boundary (P1-6)', () => {
  it('refuses to write an undeclared outer store when spawned from a test process', () => {
    const fixture = buildFixture();
    const { out } = runBareTestRunner(fixture);

    assert.deepEqual(
      storeArtifacts(fixture.outerGlobalRoot),
      { accounts: false, credentials: false },
      `no outer store file may be created. Output:\n${out}`,
    );
    assert.notEqual(installerExit(out), 0, `the installer must FAIL, not exit 0. Output:\n${out}`);
    assert.match(out, /\[test sandbox\] Refusing/, 'the failure must name the boundary that refused');
  });

  /**
   * Positive control. Without it, the refusal above could simply mean the
   * fixture never reaches a write at all. With the documented escape hatch the
   * SAME fixture must really create both files.
   */
  it('the same fixture really does write the outer store when the guard is opted out', () => {
    const fixture = buildFixture();
    const { out } = runBareTestRunner(fixture, { CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT: '1' });

    assert.deepEqual(
      storeArtifacts(fixture.outerGlobalRoot),
      { accounts: true, credentials: true },
      `the escape hatch must reproduce the original fail-open write. Output:\n${out}`,
    );
  });

  /**
   * The boundary must not have been bought by breaking the installer. A plain
   * non-test process — what `install.sh` actually is — must still write.
   */
  it('a production (non-test) installer run still writes normally', () => {
    const fixture = buildFixture();
    const env = {
      ...process.env,
      HOME: fixture.fakeHome,
      USERPROFILE: fixture.fakeHome,
      CAT_CAFE_GLOBAL_CONFIG_ROOT: fixture.outerGlobalRoot,
    };
    for (const key of [
      'NODE_TEST_CONTEXT',
      'CAT_CAFE_TEST_SANDBOX',
      'CAT_CAFE_TEST_REAL_HOME',
      'CAT_CAFE_TEST_SANDBOX_ROOT',
      'CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT',
    ]) {
      delete env[key];
    }
    env._INSTALLER_API_KEY = 'sk-p16-production-control';

    const res = spawnSync(process.execPath, [INSTALLER, ...INSTALLER_ARGS(fixture.projectDir)], {
      encoding: 'utf8',
      env,
    });

    assert.equal(res.status, 0, `production installer must still succeed: ${res.stdout}${res.stderr}`);
    assert.deepEqual(
      storeArtifacts(fixture.outerGlobalRoot),
      { accounts: true, credentials: true },
      'production behaviour must be unchanged — the guard is a TEST boundary, not an installer kill switch',
    );
  });

  /**
   * The declaration is what keeps the existing installer suites green without
   * touching CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT, which would switch the
   * whole boundary off.
   */
  it('a test process CAN write inside a sandbox root it explicitly declared', () => {
    const fixture = buildFixture();
    const { out } = runBareTestRunner(fixture, { CAT_CAFE_TEST_SANDBOX_ROOT: fixture.outerGlobalRoot });

    assert.equal(installerExit(out), 0, `a declared sandbox must be writable. Output:\n${out}`);
    assert.deepEqual(storeArtifacts(fixture.outerGlobalRoot), { accounts: true, credentials: true });
  });

  it('declaring one sandbox does not license writes to a different root', () => {
    const fixture = buildFixture();
    const elsewhere = makeTemp('p16-declared-elsewhere-');
    const { out } = runBareTestRunner(fixture, { CAT_CAFE_TEST_SANDBOX_ROOT: elsewhere });

    assert.notEqual(installerExit(out), 0, `writing outside the declared sandbox must fail. Output:\n${out}`);
    assert.deepEqual(storeArtifacts(fixture.outerGlobalRoot), { accounts: false, credentials: false });
  });

  /**
   * Defense in depth: a declaration must not be able to re-open the live store.
   * Roots inherited from the launching process stay refused even when declared,
   * which is the case that actually burned us in §17.
   */
  it('a declared sandbox under an inherited workspace root is still refused', () => {
    const fixture = buildFixture();
    const { out } = runBareTestRunner(fixture, {
      CAT_CAFE_TEST_SANDBOX_ROOT: fixture.outerGlobalRoot,
      CAT_CAFE_WORKSPACE_ROOT: fixture.outerGlobalRoot,
    });

    assert.notEqual(installerExit(out), 0, `an inherited store root must win over a declaration. Output:\n${out}`);
    assert.match(out, /inherited from the launching process/);
    assert.deepEqual(storeArtifacts(fixture.outerGlobalRoot), { accounts: false, credentials: false });
  });

  /**
   * P1-7. The explicit hint must be ADDITIVE: the passwd home has to stay in
   * the protected set even when CAT_CAFE_TEST_REAL_HOME names a fake one AND
   * the caller declares the passwd home as its sandbox — 砚砚's exact bypass.
   *
   * This asks the installer for a decision only. Every other way of asking lets
   * a broken guard answer by writing into the operator's real home, which is
   * the outcome this regression exists to prevent.
   */
  it('the passwd home stays protected when CAT_CAFE_TEST_REAL_HOME names a fake one (P1-7)', () => {
    const passwdHome = userInfo().homedir;
    const fakeRealHome = makeTemp('p17-fake-real-home-');
    const probe = runGuardProbe(passwdHome, {
      CAT_CAFE_TEST_REAL_HOME: fakeRealHome,
      // Declaring the home as the sandbox removes the OTHER reason to refuse,
      // so only the passwd-home check can produce this failure.
      CAT_CAFE_TEST_SANDBOX_ROOT: passwdHome,
    });

    assert.notEqual(probe.status, 0, `the passwd home must stay refused. Output:\n${probe.out}`);
    assert.match(probe.out, /\[test sandbox\] Refusing/);
    assert.match(probe.out, /HOME/);
  });

  /** The hint still adds its own path — additive, not ignored. */
  it('CAT_CAFE_TEST_REAL_HOME still adds a second protected home (P1-7)', () => {
    const fakeRealHome = makeTemp('p17-added-home-');
    const probe = runGuardProbe(fakeRealHome, {
      CAT_CAFE_TEST_REAL_HOME: fakeRealHome,
      CAT_CAFE_TEST_SANDBOX_ROOT: fakeRealHome,
    });

    assert.notEqual(probe.status, 0, `the declared real home must stay refused. Output:\n${probe.out}`);
    assert.match(probe.out, /HOME/);
  });

  /** Control: the probe is not a stuck "always refuse" — a real sandbox passes. */
  it('the probe allows a declared sandbox root, so a refusal above means something', () => {
    const sandbox = makeTemp('p17-real-sandbox-');
    const probe = runGuardProbe(sandbox, { CAT_CAFE_TEST_SANDBOX_ROOT: sandbox });

    assert.equal(probe.status, 0, `a declared sandbox must be allowed. Output:\n${probe.out}`);
  });

  /**
   * P1-10, installer side. The twin resolved symlinks with a plain
   * realpathSync() and fell back to the lexical path when it threw — which is
   * precisely the install case, because the target directory usually does not
   * exist yet. The symlinked PARENT then went unresolved and the alias walked
   * through. The declaration is set to the same aliased path so only containment
   * can produce this refusal.
   */
  it('an aliased inherited root is refused even for a target that does not exist yet (P1-10)', () => {
    const inherited = makeTemp('p110-installer-inherited-');
    const aliasParent = makeTemp('p110-installer-alias-');
    const alias = join(aliasParent, 'alias');
    symlinkSync(inherited, alias);
    const target = join(alias, 'not-created-yet');

    const probe = runGuardProbe(target, {
      CAT_CAFE_WORKSPACE_ROOT: inherited,
      CAT_CAFE_TEST_SANDBOX_ROOT: target,
    });

    assert.notEqual(probe.status, 0, `an aliased inherited root must stay refused. Output:\n${probe.out}`);
    assert.match(probe.out, /inherited from the launching process/);
  });

  /**
   * P2-11. The probe used to fire on an env var, before command dispatch — so a
   * production `client-auth set` that merely inherited the variable exited 0
   * having created neither file. An installer that reports success without
   * installing is worse than one that crashes: install.sh believes it.
   *
   * The variable is gone from the code entirely; this pins that a stray copy of
   * it in the environment cannot change what a production command does.
   */
  it('a stray probe env var cannot turn a production install into a silent no-op (P2-11)', () => {
    const fixture = buildFixture();
    const env = {
      ...process.env,
      HOME: fixture.fakeHome,
      USERPROFILE: fixture.fakeHome,
      CAT_CAFE_GLOBAL_CONFIG_ROOT: fixture.outerGlobalRoot,
    };
    for (const key of [
      'NODE_TEST_CONTEXT',
      'CAT_CAFE_TEST_SANDBOX',
      'CAT_CAFE_TEST_REAL_HOME',
      'CAT_CAFE_TEST_SANDBOX_ROOT',
      'CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT',
    ]) {
      delete env[key];
    }
    env._INSTALLER_API_KEY = 'sk-p211-production-control';
    env.CAT_CAFE_TEST_GUARD_PROBE_ROOT = fixture.outerGlobalRoot;

    const res = spawnSync(process.execPath, [INSTALLER, ...INSTALLER_ARGS(fixture.projectDir)], {
      encoding: 'utf8',
      env,
    });

    assert.equal(res.status, 0, `the production install must still run: ${res.stdout}${res.stderr}`);
    assert.deepEqual(
      storeArtifacts(fixture.outerGlobalRoot),
      { accounts: true, credentials: true },
      'exit 0 must mean the account was installed, not that a probe short-circuited dispatch',
    );
  });

  /**
   * The other half of P2-11: the subcommand alone is not enough either. Outside
   * a test process the probe refuses to run at all, with its own exit code so it
   * can never be mistaken for a guard verdict.
   */
  it('the probe subcommand is unavailable outside a test process (P2-11)', () => {
    const sandbox = makeTemp('p211-non-test-probe-');
    const probeHome = makeTemp('p211-probe-home-');
    const env = { ...process.env, HOME: probeHome, USERPROFILE: probeHome };
    for (const key of [
      'NODE_TEST_CONTEXT',
      'CAT_CAFE_TEST_SANDBOX',
      'CAT_CAFE_TEST_REAL_HOME',
      'CAT_CAFE_TEST_SANDBOX_ROOT',
      'CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT',
      'CAT_CAFE_GLOBAL_CONFIG_ROOT',
    ]) {
      delete env[key];
    }

    const res = spawnSync(process.execPath, [INSTALLER, 'test-guard-probe', '--root', sandbox], {
      encoding: 'utf8',
      env,
    });

    assert.equal(res.status, 2, `a non-test probe must exit 2, not 0 or 1: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /only available inside a test process/);
    assert.deepEqual(storeArtifacts(sandbox), { accounts: false, credentials: false });
  });

  it('the real passwd home stays refused even when HOME is pointed elsewhere', () => {
    const fixture = buildFixture();
    const realHome = mkdirSync(join(fixture.outerGlobalRoot, 'unused'), { recursive: true });
    void realHome;
    // CAT_CAFE_TEST_REAL_HOME names the true home explicitly; the installer must
    // refuse it as a target no matter what HOME the spawner substituted.
    const { out } = runBareTestRunner(fixture, {
      CAT_CAFE_TEST_SANDBOX_ROOT: fixture.outerGlobalRoot,
      CAT_CAFE_TEST_REAL_HOME: fixture.outerGlobalRoot,
    });

    assert.notEqual(installerExit(out), 0, `HOME must stay refused. Output:\n${out}`);
    assert.match(out, /HOME/);
  });
});

/**
 * P1-13: the shared installer helpers must isolate BOTH home coordinates.
 *
 * The installer runs migrateAllLegacySources() on every mutating command, and
 * that function calls homedir() directly — the CAT_CAFE_TEST_SANDBOX_ROOT
 * declaration constrains where the installer WRITES, and says nothing about
 * where it reads legacy provider-profiles FROM. os.homedir() resolves from
 * USERPROFILE on Windows and HOME elsewhere, so a child handed an isolated HOME
 * and an inherited USERPROFILE takes the operator's real profile as a migration
 * source on the platform these tests do not run on.
 *
 * Windows' resolution order cannot be executed here. The property that makes it
 * safe — one owned directory under both names, in the env the child actually
 * receives — is platform-independent, so it is asserted directly rather than
 * registered as residual risk (R13 ruling 2).
 */
const OUTER_PROFILE = '/outer/operator/profile';

/** What the child really sees, built by the same function the helpers use. */
function childHomePair(env) {
  const res = spawnSync(process.execPath, ['-p', 'JSON.stringify([process.env.HOME, process.env.USERPROFILE])'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

describe('installer helper home isolation (P1-13)', () => {
  it('isolatedEnv points both coordinates at the project dir', () => {
    const projectDir = makeTemp('p113-project-');
    const saved = process.env.USERPROFILE;
    try {
      process.env.USERPROFILE = OUTER_PROFILE;
      const [home, userProfile] = childHomePair(isolatedEnv(projectDir));
      assert.equal(home, projectDir);
      assert.equal(userProfile, projectDir, 'an inherited profile must not survive into the installer child');
    } finally {
      if (saved === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = saved;
    }
  });

  /**
   * The call shape that already exists throughout install-auth-config-script.test.js.
   * HOME is overridden LAST, so a USERPROFILE written before the merge would
   * leave the two coordinates pointing at different directories.
   */
  it('USERPROFILE follows the HOME an override actually ends up with', () => {
    const projectDir = makeTemp('p113-shape-project-');
    const fakeHome = makeTemp('p113-shape-home-');
    const saved = process.env.USERPROFILE;
    try {
      process.env.USERPROFILE = OUTER_PROFILE;
      const [home, userProfile] = childHomePair(isolatedEnv(projectDir, { HOME: fakeHome }));
      assert.equal(home, fakeHome);
      assert.equal(userProfile, fakeHome, 'USERPROFILE must track the effective HOME, not the project dir');
      assert.notEqual(userProfile, OUTER_PROFILE);
    } finally {
      if (saved === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = saved;
    }
  });

  it('an explicit USERPROFILE from the caller is left alone', () => {
    const projectDir = makeTemp('p113-explicit-project-');
    const chosen = makeTemp('p113-explicit-profile-');
    const [, userProfile] = childHomePair(isolatedEnv(projectDir, { USERPROFILE: chosen }));
    assert.equal(userProfile, chosen, 'a caller that names the coordinate keeps its choice');
  });

  it('the no-global-override runner isolates both coordinates too', () => {
    const projectDir = makeTemp('p113-noglobal-project-');
    const saved = process.env.USERPROFILE;
    try {
      process.env.USERPROFILE = OUTER_PROFILE;
      const env = noGlobalOverrideEnv(projectDir);
      assert.equal(env.CAT_CAFE_GLOBAL_CONFIG_ROOT, undefined, 'the global override must still be stripped');
      const [home, userProfile] = childHomePair(env);
      assert.equal(home, projectDir);
      assert.equal(userProfile, projectDir);
    } finally {
      if (saved === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = saved;
    }
  });

  /**
   * End-to-end control: a real installer run through the `{ HOME: fakeHome }`
   * shape still migrates the legacy profile sitting in that home. Without it the
   * assertions above could be satisfied by an env nobody reads.
   */
  it('a real installer run still takes its legacy source from that same home', () => {
    const projectDir = makeTemp('p113-e2e-project-');
    const fakeHome = makeTemp('p113-e2e-home-');
    mkdirSync(join(fakeHome, '.cat-cafe'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.cat-cafe', 'provider-profiles.json'),
      `${JSON.stringify({ profiles: [{ id: 'installer-anthropic', client: 'anthropic', authType: 'api_key' }] })}\n`,
    );

    runHelperWithEnv(['client-auth', 'set', '--project-dir', projectDir, '--client', 'anthropic', '--mode', 'oauth'], {
      HOME: fakeHome,
    });

    const accountsPath = join(projectDir, '.cat-cafe', 'accounts.json');
    assert.ok(existsSync(accountsPath), 'the installer must have written the project store');
    assert.match(
      readFileSync(accountsPath, 'utf-8'),
      /installer-anthropic/,
      'the legacy profile in the effective home must still be a migration source',
    );
  });
});
