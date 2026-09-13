/**
 * P1-10: the sandbox boundary must compare DIRECTORIES, not strings.
 *
 * The TS guard only ever called resolve(), so a symlink pointing at an inherited
 * store root was a different string and walked straight through — the installer
 * twin already resolved symlinks, this one did not. Two names for one directory
 * must not land on opposite sides of a security boundary.
 *
 * Two separate defects live here, and each has its own regression:
 *
 *   1. Physical identity. resolve() is lexical; realpathSync() is not. And the
 *      obvious "realpath, fall back to the lexical path when it throws" is open
 *      exactly where it matters — a write target usually does not exist yet, so
 *      the call throws and the symlinked PARENT is never resolved.
 *   2. Containment. `target.startsWith(`${root}/`)` hard-codes the POSIX
 *      separator, so on Windows — a first-class platform per the README — every
 *      DESCENDANT of an inherited root escaped the check and only the root
 *      itself was caught. It is also a substring test: `/a/bc` is not inside
 *      `/a/b` on any platform.
 *
 * Only mkdtemp roots are used. Child assertions report booleans, never values.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, '..', 'dist', 'config');
const CREDENTIALS_DIST = join(DIST, 'credentials.js');
const GUARD_DIST = join(DIST, 'test-config-write-guard.js');
const PROBE_SECRET = 'sk-p110-alias-must-stay-unreadable';

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
 * An inherited store holding a probe credential, plus a symlink alias of it
 * living somewhere else entirely — so the two paths share no common prefix.
 */
function buildAliasFixture() {
  const inheritedStore = makeTemp('p110-inherited-store-');
  const inheritedRuntime = makeTemp('p110-inherited-runtime-');
  const aliasParent = makeTemp('p110-alias-parent-');
  const fakeHome = makeTemp('p110-fake-home-');
  const innerDir = makeTemp('p110-inner-');

  mkdirSync(join(inheritedStore, '.cat-cafe'), { recursive: true });
  writeFileSync(
    join(inheritedStore, '.cat-cafe', 'credentials.json'),
    `${JSON.stringify({ probe: { apiKey: PROBE_SECRET } })}\n`,
    { mode: 0o600 },
  );

  const alias = join(aliasParent, 'alias');
  symlinkSync(inheritedStore, alias);

  return { inheritedStore, inheritedRuntime, alias, fakeHome, innerDir };
}

function runBareChild(fixture, innerTest, extraEnv = {}) {
  const env = { ...process.env, HOME: fixture.fakeHome, USERPROFILE: fixture.fakeHome };
  // Deleted, not blanked: node treats an inherited NODE_TEST_CONTEXT — even
  // empty — as "already inside a run" and silently skips the child's file.
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
  env.CAT_CAFE_RUNTIME_ROOT = fixture.inheritedRuntime;
  env.CAT_CAFE_WORKSPACE_ROOT = fixture.inheritedStore;
  Object.assign(env, extraEnv);

  const res = spawnSync(process.execPath, ['--test', innerTest], { encoding: 'utf-8', env });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

function writeInnerTest(innerDir, name, lines) {
  const innerTest = join(innerDir, `${name}.test.mjs`);
  const imports = lines.filter((line) => line.startsWith('import '));
  const body = lines.filter((line) => !line.startsWith('import '));
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

describe('sandbox guard path identity (P1-10)', () => {
  it('a bare `node --test` cannot read an inherited store through a symlink alias', () => {
    const fixture = buildAliasFixture();
    const innerTest = writeInnerTest(fixture.innerDir, 'alias-read', [
      `import { readCredential } from ${JSON.stringify(CREDENTIALS_DIST)};`,
      `const entry = readCredential('probe', ${JSON.stringify(fixture.alias)});`,
      `console.log('ALIAS_READ=' + String(entry?.apiKey === ${JSON.stringify(PROBE_SECRET)}));`,
    ]);
    const { status, out } = runBareChild(fixture, innerTest);

    assert.notEqual(status, 0, `an alias of the inherited store must FAIL, not exit 0. Output:\n${out}`);
    assert.match(out, /\[test sandbox\] Refusing/);
    assert.doesNotMatch(out, /ALIAS_READ=true/, 'the credential must never come back through the alias');
  });

  /**
   * The write half, and the reason a bare realpathSync() is not enough: the
   * target directory does not exist yet, so realpath throws. Falling back to the
   * lexical path there re-opens the alias — the symlinked PARENT is what has to
   * be resolved.
   */
  it('a not-yet-created target under an aliased inherited root is still refused', () => {
    const fixture = buildAliasFixture();
    const innerTest = writeInnerTest(fixture.innerDir, 'alias-write-target', [
      `import { assertSafeTestConfigRoot } from ${JSON.stringify(GUARD_DIST)};`,
      `assertSafeTestConfigRoot(${JSON.stringify(join(fixture.alias, 'not-created-yet'))}, 'p110.probe');`,
      "console.log('ALIAS_WRITE_ALLOWED=true');",
    ]);
    const { status, out } = runBareChild(fixture, innerTest);

    assert.notEqual(status, 0, `a nonexistent leaf under an aliased root must FAIL. Output:\n${out}`);
    assert.match(out, /\[test sandbox\] Refusing/);
    assert.doesNotMatch(out, /ALIAS_WRITE_ALLOWED=true/);
  });

  /**
   * Positive control. Without it the two refusals above could just mean the
   * symlink is broken, proving nothing about the guard.
   */
  it('the same alias really is readable when the guard is opted out', () => {
    const fixture = buildAliasFixture();
    const innerTest = writeInnerTest(fixture.innerDir, 'alias-optout', [
      `import { readCredential } from ${JSON.stringify(CREDENTIALS_DIST)};`,
      `const entry = readCredential('probe', ${JSON.stringify(fixture.alias)});`,
      `console.log('ALIAS_READ=' + String(entry?.apiKey === ${JSON.stringify(PROBE_SECRET)}));`,
    ]);
    const { status, out } = runBareChild(fixture, innerTest, { CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT: '1' });

    assert.equal(status, 0, `the escape hatch must reproduce the original read. Output:\n${out}`);
    assert.match(out, /ALIAS_READ=true/, 'the alias must genuinely resolve to the probe store');
  });

  /**
   * The exact-root checks (repo root, HOME) stay exact per R11 ruling 4 — but an
   * ALIAS of that exact root is the same directory, so it must compare equal.
   * Decision-only: the guard throws before its caller opens anything.
   */
  it('an alias of a protected HOME is the same HOME', async () => {
    const { assertSafeTestConfigRoot } = await import('../dist/config/test-config-write-guard.js');
    const protectedHome = makeTemp('p110-protected-home-');
    const aliasParent = makeTemp('p110-home-alias-parent-');
    const aliasedHome = join(aliasParent, 'home-alias');
    symlinkSync(protectedHome, aliasedHome);

    const saved = process.env.CAT_CAFE_TEST_REAL_HOME;
    try {
      process.env.CAT_CAFE_TEST_REAL_HOME = protectedHome;
      assert.throws(() => assertSafeTestConfigRoot(protectedHome, 'p110.probe'), /\[test sandbox\] Refusing/);
      assert.throws(
        () => assertSafeTestConfigRoot(aliasedHome, 'p110.probe'),
        /\[test sandbox\] Refusing/,
        'a second name for the protected home must not be a second, unprotected home',
      );
      // Control: the guard is not simply refusing everything.
      assert.doesNotThrow(() => assertSafeTestConfigRoot(makeTemp('p110-neutral-'), 'p110.probe'));
    } finally {
      if (saved === undefined) delete process.env.CAT_CAFE_TEST_REAL_HOME;
      else process.env.CAT_CAFE_TEST_REAL_HOME = saved;
    }
  });

  it('containment is by path segment, not by string prefix (POSIX)', async () => {
    const { isPathAtOrUnder } = await import('../dist/config/test-config-write-guard.js');

    assert.equal(isPathAtOrUnder('/a/b', '/a/b', posix), true);
    assert.equal(isPathAtOrUnder('/a/b/.cat-cafe/credentials.json', '/a/b', posix), true);
    assert.equal(isPathAtOrUnder('/a/bc', '/a/b', posix), false, '/a/bc is a sibling, not a child');
    assert.equal(isPathAtOrUnder('/a', '/a/b', posix), false);
  });

  /**
   * The Windows branch, which no POSIX CI run would otherwise execute. With the
   * hard-coded '/' every descendant of an inherited root reported false here —
   * the guard caught the root and nothing beneath it.
   */
  it('containment uses the platform separator, so Windows descendants are contained', async () => {
    const { isPathAtOrUnder } = await import('../dist/config/test-config-write-guard.js');

    assert.equal(isPathAtOrUnder('C:\\store', 'C:\\store', win32), true);
    assert.equal(
      isPathAtOrUnder('C:\\store\\.cat-cafe\\credentials.json', 'C:\\store', win32),
      true,
      'a backslash descendant of an inherited root must be contained',
    );
    assert.equal(isPathAtOrUnder('C:\\store2', 'C:\\store', win32), false);
    assert.equal(isPathAtOrUnder('D:\\store\\.cat-cafe', 'C:\\store', win32), false, 'a different drive is not inside');
  });
});
