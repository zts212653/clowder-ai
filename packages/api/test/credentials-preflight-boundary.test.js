/**
 * P2-12: assertCredentialsReadable() is a security-critical entry point and
 * needs its own regression.
 *
 * §24 added the read guard to the startup preflight, but every test that
 * exercised the boundary went through credentials.readAll(), the catalog reader
 * or the runtime migration. Deleting the guard line from the preflight left all
 * of them green — a safety property vouched for only by its neighbours in the
 * same file is not covered, it is adjacent to coverage.
 *
 * The preflight also has pre-existing semantics to keep: a missing file is fine,
 * a malformed one must still report itself. The sandbox refusal takes precedence
 * over the parse error (R11 ruling 3) — the data boundary is decided before the
 * content is looked at.
 *
 * Only mkdtemp roots are used; no credential value is ever printed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_DIST = join(__dirname, '..', 'dist', 'config', 'credentials.js');

const tempRoots = [];
function makeTemp(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** A store whose credentials.json is VALID — so only the guard can fail. */
function seedValidStore(root) {
  mkdirSync(join(root, '.cat-cafe'), { recursive: true });
  writeFileSync(
    join(root, '.cat-cafe', 'credentials.json'),
    `${JSON.stringify({ probe: { apiKey: 'sk-p212-probe' } })}\n`,
    {
      mode: 0o600,
    },
  );
  return root;
}

function writeStore(root, contents) {
  mkdirSync(join(root, '.cat-cafe'), { recursive: true });
  writeFileSync(join(root, '.cat-cafe', 'credentials.json'), contents, { mode: 0o600 });
  return root;
}

function preflightScript(root) {
  return (
    `import(${JSON.stringify(CREDENTIALS_DIST)}).then((m) => {` +
    `  m.assertCredentialsReadable(${JSON.stringify(root)});` +
    "  console.log('PREFLIGHT_OK=true');" +
    '});'
  );
}

function bareTestEnv(fixture, extraEnv = {}) {
  const env = { ...process.env, HOME: fixture.fakeHome, USERPROFILE: fixture.fakeHome };
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
  return env;
}

function buildFixture() {
  return {
    inheritedStore: seedValidStore(makeTemp('p212-inherited-store-')),
    inheritedRuntime: makeTemp('p212-inherited-runtime-'),
    fakeHome: makeTemp('p212-fake-home-'),
    innerDir: makeTemp('p212-inner-'),
  };
}

describe('credentials startup preflight boundary (P2-12)', () => {
  it('a bare `node --test` cannot preflight an inherited store', () => {
    const fixture = buildFixture();
    const innerTest = join(fixture.innerDir, 'preflight.test.mjs');
    writeFileSync(
      innerTest,
      [
        "import { test } from 'node:test';",
        `import { assertCredentialsReadable } from ${JSON.stringify(CREDENTIALS_DIST)};`,
        "test('preflight against the inherited store', () => {",
        `  assertCredentialsReadable(${JSON.stringify(fixture.inheritedStore)});`,
        "  console.log('PREFLIGHT_OK=true');",
        '});',
        '',
      ].join('\n'),
    );

    const res = spawnSync(process.execPath, ['--test', innerTest], {
      encoding: 'utf-8',
      env: bareTestEnv(fixture),
    });
    const out = `${res.stdout}${res.stderr}`;

    assert.notEqual(res.status, 0, `the preflight must FAIL against an inherited store. Output:\n${out}`);
    assert.match(out, /\[test sandbox\] Refusing/);
    assert.match(
      out,
      /assertCredentialsReadable/,
      'the refusal must come from the preflight itself, not from a neighbouring reader',
    );
    assert.doesNotMatch(out, /PREFLIGHT_OK=true/);
  });

  /**
   * Positive control: production. The same store, the same valid file, a plain
   * non-test process — the preflight must still pass, or the "regression" above
   * would just be a broken preflight.
   */
  it('a production (non-test) process still preflights the same store', () => {
    const fixture = buildFixture();
    const res = spawnSync(process.execPath, ['-e', preflightScript(fixture.inheritedStore)], {
      encoding: 'utf-8',
      env: bareTestEnv(fixture),
    });
    const out = `${res.stdout}${res.stderr}`;

    assert.equal(res.status, 0, `production preflight must still succeed. Output:\n${out}`);
    assert.match(out, /PREFLIGHT_OK=true/);
  });

  /**
   * The pre-existing contract, unchanged: at a root the test owns, the preflight
   * still reports malformed content exactly as before. Adding a data boundary
   * must not swallow the content check it sits in front of.
   */
  it('malformed credentials at a test-owned root still report themselves', async () => {
    const { assertCredentialsReadable } = await import('../dist/config/credentials.js');

    const missing = makeTemp('p212-missing-');
    assert.doesNotThrow(() => assertCredentialsReadable(missing), 'a missing store is not an error');

    const valid = seedValidStore(makeTemp('p212-valid-'));
    assert.doesNotThrow(() => assertCredentialsReadable(valid));

    const arrayRoot = writeStore(makeTemp('p212-array-'), '[]\n');
    assert.throws(() => assertCredentialsReadable(arrayRoot), /expected object/);

    const garbageRoot = writeStore(makeTemp('p212-garbage-'), '{not json\n');
    assert.throws(() => assertCredentialsReadable(garbageRoot), SyntaxError);
  });
});
