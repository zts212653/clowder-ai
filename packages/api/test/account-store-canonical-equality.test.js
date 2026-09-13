/**
 * Dual-root P1-14 / P1-15 / P1-16 input-integrity matrix.
 *
 * Ordinary reads are pure; equality uses canonicalizeAccount(). That normaliser
 * may absorb legal padding/key-order, but must FAIL CLOSED on unusable
 * persisted content and must not rewrite observable semantics (models[0]).
 * Migrated here from the retired accounts-split-root migrate-on-read suite —
 * no marker/copy assertions.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const { resolveByAccountRef } = await import('../dist/config/account-resolver.js');
const { readCatalogAccounts, resetMigrationState } = await import('../dist/config/catalog-accounts.js');
const { canonicalizeAccount } = await import('../dist/config/account-store-format.js');

const ENV_KEYS = [
  'CAT_CAFE_RUNTIME_ROOT',
  'CAT_CAFE_WORKSPACE_ROOT',
  'CAT_CAFE_GLOBAL_CONFIG_ROOT',
  'CAT_CAFE_SKIP_HOMEDIR_MIGRATION',
  'HOME',
  'USERPROFILE',
];
const savedEnv = {};

describe('account-store canonical equality (dual-root P1-14/15/16)', () => {
  let runtimeRoot;
  let workspaceRoot;
  let fakeHome;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    const root = mkdtempSync(join(tmpdir(), 'canonical-eq-'));
    runtimeRoot = join(root, 'runtime');
    workspaceRoot = join(root, 'workspace');
    fakeHome = join(root, 'home');
    for (const dir of [runtimeRoot, workspaceRoot, fakeHome]) {
      mkdirSync(join(dir, '.cat-cafe'), { recursive: true });
    }
    // Dual-root topology requires both roots to exist as directories and the
    // requested path to sit under RUNTIME when selecting workspace primary.
    mkdirSync(join(runtimeRoot, 'packages', 'api'), { recursive: true });
    writeFileSync(join(runtimeRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;
    process.env.CAT_CAFE_SKIP_HOMEDIR_MIGRATION = '1';
    resetMigrationState();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    resetMigrationState();
    for (const dir of [runtimeRoot, workspaceRoot, fakeHome]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function putAccount(root, account) {
    writeFileSync(join(root, '.cat-cafe', 'accounts.json'), `${JSON.stringify({ shared: account }, null, 2)}\n`);
  }

  function putCredential(root, secret = 'sk-canonical-eq-probe') {
    writeFileSync(
      join(root, '.cat-cafe', 'credentials.json'),
      `${JSON.stringify({ shared: { apiKey: secret } }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  function snapshotWorkspace() {
    const dir = join(workspaceRoot, '.cat-cafe');
    const snapshot = {};
    if (!existsSync(dir)) return snapshot;
    for (const name of readdirSync(dir).sort()) {
      snapshot[name] = readFileSync(join(dir, name), 'utf-8');
    }
    return snapshot;
  }

  function assertWorkspaceUntouched(before, label) {
    const after = snapshotWorkspace();
    for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      assert.equal(after[name], before[name], `${label}: workspace file "${name}" must stay byte-identical`);
    }
  }

  function seedPair(runtimeAccount, workspaceAccount, secret = 'sk-canonical-eq-probe') {
    putAccount(runtimeRoot, runtimeAccount);
    putAccount(workspaceRoot, workspaceAccount);
    // Same credential on both roots so adjudication reaches canonicalize, not "torn".
    putCredential(runtimeRoot, secret);
    putCredential(workspaceRoot, secret);
  }

  function assertRejected(label, secret) {
    const before = snapshotWorkspace();
    assert.equal('shared' in readCatalogAccounts(runtimeRoot), false, `${label}: listing must omit rejected ref`);
    let thrown = null;
    try {
      resolveByAccountRef(runtimeRoot, 'shared');
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof Error, `${label}: resolve must fail closed`);
    assert.match(String(thrown.message), /divergent|invalid|malformed/i, `${label}: ${thrown.message}`);
    if (secret) {
      assert.equal(String(thrown.message).includes(secret), false, `${label}: secret must not leak`);
    }
    assertWorkspaceUntouched(before, label);
  }

  it('reviewer repro: alias trim-collision must not collapse into both-equal (P1-14)', () => {
    seedPair(
      { authType: 'api_key', clientId: 'anthropic', modelAliases: { a: 'x', ' a ': 'y' } },
      { authType: 'api_key', clientId: 'anthropic', modelAliases: { a: 'y' } },
      'sk-alias-trim-collision',
    );
    assertRejected('alias trim-collision', 'sk-alias-trim-collision');
  });

  it('reviewer repro: reordered models must not collapse into both-equal (P1-16)', () => {
    seedPair(
      { authType: 'api_key', clientId: 'anthropic', models: ['b', 'a'] },
      { authType: 'api_key', clientId: 'anthropic', models: ['a', 'b'] },
      'sk-models-reordered',
    );
    assertRejected('reordered models', 'sk-models-reordered');
  });

  it('non-string alias value is unusable content, not an absent field (P1-14)', () => {
    seedPair(
      { authType: 'api_key', clientId: 'anthropic', modelAliases: { local: 123 } },
      { authType: 'api_key', clientId: 'anthropic' },
      'sk-alias-nonstring',
    );
    assertRejected('non-string alias', 'sk-alias-nonstring');
  });

  it('blank-after-trim alias value is unusable content (P1-14)', () => {
    seedPair(
      { authType: 'api_key', clientId: 'anthropic', modelAliases: { 'a/x': 'up-x', 'b/y': '   ' } },
      { authType: 'api_key', clientId: 'anthropic', modelAliases: { 'a/x': 'up-x' } },
      'sk-alias-blank-value',
    );
    assertRejected('blank alias value', 'sk-alias-blank-value');
  });

  it('blank-after-trim alias key is unusable content (P1-14)', () => {
    seedPair(
      { authType: 'api_key', clientId: 'anthropic', modelAliases: { 'a/x': 'up-x', '   ': 'up-y' } },
      { authType: 'api_key', clientId: 'anthropic', modelAliases: { 'a/x': 'up-x' } },
      'sk-alias-blank-key',
    );
    assertRejected('blank alias key', 'sk-alias-blank-key');
  });

  it('persisted null modelAliases is unusable content, not absence (P1-15)', () => {
    seedPair(
      { authType: 'api_key', clientId: 'anthropic', modelAliases: null },
      { authType: 'api_key', clientId: 'anthropic' },
      'sk-alias-null',
    );
    assertRejected('null modelAliases', 'sk-alias-null');
  });

  it('legal alias padding/key-order remains equivalent (P1-14 control)', () => {
    seedPair(
      { authType: 'api_key', clientId: 'anthropic', modelAliases: { 'b/y': ' up-y ', 'a/x': ' up-x ' } },
      { authType: 'api_key', clientId: 'anthropic', modelAliases: { 'a/x': 'up-x', 'b/y': 'up-y' } },
    );
    assert.doesNotThrow(() => resolveByAccountRef(runtimeRoot, 'shared'));
  });

  it('empty alias map remains equivalent to absence (P1-14 control)', () => {
    seedPair(
      { authType: 'api_key', clientId: 'anthropic', modelAliases: {} },
      { authType: 'api_key', clientId: 'anthropic' },
    );
    assert.doesNotThrow(() => resolveByAccountRef(runtimeRoot, 'shared'));
  });

  const UNUSABLE = [
    {
      title: 'models holding a map',
      runtime: { models: { 'gpt-leak': 'x' } },
      workspace: {},
      secret: 'sk-models-object',
    },
    { title: 'null models', runtime: { models: null }, workspace: {}, secret: 'sk-models-null' },
    {
      title: 'blank model entry',
      runtime: { models: ['a/x', '   '] },
      workspace: { models: ['a/x'] },
      secret: 'sk-models-blank',
    },
    {
      title: 'non-string model entry',
      runtime: { models: ['a/x', 4711] },
      workspace: { models: ['a/x', '4711'] },
      secret: 'sk-models-coerced',
      mustNotPrint: '4711',
    },
    { title: 'null baseUrl', runtime: { baseUrl: null }, workspace: {}, secret: 'sk-baseurl-null' },
    { title: 'blank baseUrl', runtime: { baseUrl: '   ' }, workspace: {}, secret: 'sk-baseurl-blank' },
    { title: 'null displayName', runtime: { displayName: null }, workspace: {}, secret: 'sk-displayname-null' },
    { title: 'blank displayName', runtime: { displayName: '   ' }, workspace: {}, secret: 'sk-displayname-blank' },
    { title: 'null envVars', runtime: { envVars: null }, workspace: {}, secret: 'sk-envvars-null' },
    {
      title: 'envVars list vs spread map',
      runtime: { envVars: ['ENVLEAK'] },
      workspace: { envVars: { 0: 'ENVLEAK' } },
      secret: 'sk-envvars-array',
      mustNotPrint: 'ENVLEAK',
    },
  ];

  for (const scenario of UNUSABLE) {
    it(`${scenario.title} is unusable content, not an equivalent account (P1-16)`, () => {
      seedPair(
        { authType: 'api_key', clientId: 'anthropic', ...scenario.runtime },
        { authType: 'api_key', clientId: 'anthropic', ...scenario.workspace },
        scenario.secret,
      );
      assertRejected(scenario.title, scenario.secret);
      if (scenario.mustNotPrint) {
        try {
          resolveByAccountRef(runtimeRoot, 'shared');
        } catch (err) {
          assert.equal(String(err.message).includes(scenario.mustNotPrint), false);
        }
      }
    });
  }

  const EQUIVALENT = [
    {
      title: 'trailing slash on baseUrl',
      runtime: { baseUrl: 'https://x.test/' },
      workspace: { baseUrl: 'https://x.test' },
    },
    {
      title: 'padding around baseUrl',
      runtime: { baseUrl: '  https://x.test  ' },
      workspace: { baseUrl: 'https://x.test' },
    },
    { title: 'padding around displayName', runtime: { displayName: ' shared ' }, workspace: { displayName: 'shared' } },
    {
      title: 'padding in models (order preserved)',
      runtime: { models: [' a/x ', 'b'] },
      workspace: { models: ['a/x', 'b'] },
    },
    { title: 'repeated model keeps first', runtime: { models: ['a', 'b', 'a'] }, workspace: { models: ['a', 'b'] } },
    { title: 'empty models list', runtime: { models: [] }, workspace: {} },
    { title: 'empty envVars map', runtime: { envVars: {} }, workspace: {} },
  ];

  for (const scenario of EQUIVALENT) {
    it(`${scenario.title} remains equivalent (P1-16 control)`, () => {
      seedPair(
        { authType: 'api_key', clientId: 'anthropic', ...scenario.runtime },
        { authType: 'api_key', clientId: 'anthropic', ...scenario.workspace },
      );
      assert.doesNotThrow(() => resolveByAccountRef(runtimeRoot, 'shared'), scenario.title);
    });
  }

  it('canonicalizeAccount itself rejects trim-colliding aliases without leaking values', () => {
    assert.throws(
      () =>
        canonicalizeAccount({
          authType: 'api_key',
          modelAliases: { a: 'secret-x', ' a ': 'secret-y' },
        }),
      /modelAliases invalid \(values not shown\)/,
    );
  });

  /**
   * R19: JSON own-key "__proto__" is data. z.record / plain `{}` assignment used
   * to drop it, so a runtime-only `__proto__` alias compared equal to a clean
   * workspace account (both-equal). Fixtures must come from JSON.parse — a JS
   * object literal `{ __proto__: x }` invokes the prototype setter.
   */
  it('reviewer repro: modelAliases.__proto__ must not collapse into both-equal (R19)', () => {
    const runtimeAccount = JSON.parse(
      '{"authType":"api_key","clientId":"anthropic","modelAliases":{"__proto__":"model-x"}}',
    );
    const workspaceAccount = JSON.parse('{"authType":"api_key","clientId":"anthropic"}');
    seedPair(runtimeAccount, workspaceAccount, 'sk-proto-alias');
    assertRejected('modelAliases.__proto__', 'sk-proto-alias');
  });

  it('reviewer repro: envVars.__proto__ must not collapse into both-equal (R19)', () => {
    const runtimeAccount = JSON.parse('{"authType":"api_key","clientId":"anthropic","envVars":{"__proto__":"value"}}');
    const workspaceAccount = JSON.parse('{"authType":"api_key","clientId":"anthropic"}');
    seedPair(runtimeAccount, workspaceAccount, 'sk-proto-env');
    assertRejected('envVars.__proto__', 'sk-proto-env');
  });

  it('identical __proto__ aliases on both roots remain both-equal (R19 control)', () => {
    const account = JSON.parse(
      '{"authType":"api_key","clientId":"anthropic","modelAliases":{"__proto__":"model-x","ok":"y"}}',
    );
    seedPair(structuredClone(account), structuredClone(account));
    const profile = resolveByAccountRef(runtimeRoot, 'shared');
    assert.ok(profile);
    assert.ok(profile.modelAliases);
    assert.equal(Object.hasOwn(profile.modelAliases, '__proto__'), true);
    assert.equal(Object.getOwnPropertyDescriptor(profile.modelAliases, '__proto__')?.value, 'model-x');
    assert.equal(profile.modelAliases.ok, 'y');
  });

  it('parseStoredAccount + canonicalizeAccount preserve __proto__ maps as own data', async () => {
    const { parseStoredAccount } = await import('../dist/config/account-store-format.js');
    const raw = JSON.parse(
      '{"authType":"api_key","modelAliases":{"__proto__":"model-x"},"envVars":{"__proto__":"ENV"}}',
    );
    const parsed = parseStoredAccount(raw, 'r19-proto-fixture');
    assert.equal(Object.hasOwn(parsed.modelAliases, '__proto__'), true);
    assert.equal(Object.getOwnPropertyDescriptor(parsed.modelAliases, '__proto__')?.value, 'model-x');
    assert.equal(Object.hasOwn(parsed.envVars, '__proto__'), true);
    assert.equal(Object.getOwnPropertyDescriptor(parsed.envVars, '__proto__')?.value, 'ENV');

    const canonical = canonicalizeAccount(parsed);
    assert.equal(Object.hasOwn(canonical.modelAliases, '__proto__'), true);
    assert.equal(Object.getOwnPropertyDescriptor(canonical.modelAliases, '__proto__')?.value, 'model-x');
    assert.equal(Object.hasOwn(canonical.envVars, '__proto__'), true);
    assert.equal(Object.getOwnPropertyDescriptor(canonical.envVars, '__proto__')?.value, 'ENV');
    assert.notEqual(Object.getPrototypeOf(canonical.modelAliases), Object.prototype);
    assert.notEqual(Object.getPrototypeOf(canonical.envVars), Object.prototype);
  });
});
