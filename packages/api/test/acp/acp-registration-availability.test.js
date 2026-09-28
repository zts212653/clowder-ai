import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { skipAcpProfile } from '../../dist/domains/cats/services/agents/providers/acp/acp-registration-failure.js';
import { AgentRegistry } from '../../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { getService } from '../../dist/domains/cats/services/agents/routing/route-helpers.js';

let root;
let savedRoot;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acp-registration-availability-'));
  mkdirSync(join(root, '.cat-cafe'));
  savedRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
});
afterEach(() => {
  if (savedRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

function config(id, accountRef = id) {
  return {
    id,
    name: id,
    displayName: id,
    color: { primary: '#111111', secondary: '#eeeeee' },
    avatar: '/fixture.png',
    mentionPatterns: [`@${id}`],
    roleDescription: 'fixture',
    clientId: 'kimi',
    accountRef,
    defaultModel: 'kimi-code/k3',
    mcpSupport: false,
  };
}

test('rejected Kimi registration preserves the account diagnostic without creating a service or leaking a key', async () => {
  const secret = 'FAKE_ORPHAN_KEY_NOT_FOR_OUTPUT';
  writeFileSync(join(root, '.cat-cafe/credentials.json'), JSON.stringify({ kimi: { apiKey: secret } }));
  const registry = new AgentRegistry();
  const reasons = new Map();
  let closed = 0;
  const poolRegistry = new Map([
    [
      'kimi',
      {
        async closeAll() {
          closed++;
        },
      },
    ],
  ]);
  const service = await createAcpServiceForConfig({
    projectRoot: root,
    profileId: 'kimi',
    config: config('kimi'),
    effectiveModel: 'kimi-code/k3',
    acpConfig: { command: 'never-spawn', startupArgs: ['--acp'] },
    poolRegistry,
    log: { info() {}, warn() {} },
    onUnavailable: (reason) => reasons.set('kimi', reason),
  });
  assert.equal(service, null);
  assert.equal(closed, 1);
  assert.equal(poolRegistry.size, 0);
  // The actual downstream consumer is the RED oracle, not an observer-call count.
  assert.throws(
    () => getService({}, 'kimi', reasons),
    /kimi.*rejected-account-binding.*torn credential without account metadata/,
  );
  assert.doesNotMatch(JSON.stringify([...reasons]), new RegExp(secret));
  registry.markUnavailable('kimi', reasons.get('kimi'));
  assert.equal(registry.has('kimi'), false);
  assert.equal(registry.getAllEntries().size, 0);
  assert.throws(() => registry.get('kimi'), /torn credential without account metadata/);
});

test('native OAuth registration is healthy while a separate orphan stays unavailable', async () => {
  writeFileSync(
    join(root, '.cat-cafe/accounts.json'),
    JSON.stringify({ native: { authType: 'oauth', clientId: 'kimi' } }),
  );
  writeFileSync(join(root, '.cat-cafe/credentials.json'), JSON.stringify({ kimi: { apiKey: 'FAKE_ORPHAN' } }));
  const poolRegistry = new Map();
  const reasons = [];
  try {
    const service = await createAcpServiceForConfig({
      projectRoot: root,
      profileId: 'kimi',
      config: config('kimi', 'native'),
      effectiveModel: 'kimi-code/k3',
      acpConfig: { command: 'never-spawn', startupArgs: ['--acp'] },
      poolRegistry,
      log: { info() {}, warn() {} },
      onUnavailable: (reason) => reasons.push(reason),
    });
    assert.ok(service);
    assert.deepEqual(reasons, []);
    assert.equal(service.sessionModel, 'kimi-code/k3');
    assert.equal(poolRegistry.size, 1);
  } finally {
    await Promise.all([...poolRegistry.values()].map((pool) => pool.closeAll()));
  }
});

test('missing account binding reports why the configured cat cannot register', async () => {
  const reasons = new Map();
  const service = await createAcpServiceForConfig({
    projectRoot: root,
    profileId: 'kimi',
    config: config('kimi', 'missing-native'),
    effectiveModel: 'kimi-code/k3',
    acpConfig: { command: 'never-spawn', startupArgs: ['--acp'] },
    poolRegistry: new Map(),
    log: { info() {}, warn() {} },
    onUnavailable: (reason) => reasons.set('kimi', reason),
  });
  assert.equal(service, null);
  assert.throws(() => getService({}, 'kimi', reasons), /missing-account-binding/);
});

test('registry diagnostics are immutable snapshots and cannot make a removed member look present', () => {
  const registry = new AgentRegistry();
  const reason = { code: 'rejected-account-binding', message: 'account rejected' };
  registry.markUnavailable('kimi', reason);
  const snapshot = registry.getAllUnavailableEntries();
  reason.message = 'changed after registration';
  assert.equal(snapshot.get('kimi').message, 'account rejected');
  assert.equal(Object.isFrozen(snapshot.get('kimi')), true);
  const service = { async *invoke() {} };
  registry.register('kimi', service);
  assert.equal(registry.get('kimi'), service);
  assert.equal(registry.getAllUnavailableEntries().size, 0);
  assert.equal(snapshot.size, 1, 'an in-flight router retains its own generation');
  registry.markUnavailable('kimi', reason);
  assert.equal(registry.has('kimi'), false);
  registry.reset();
  assert.equal(registry.getAllUnavailableEntries().size, 0);
  assert.equal(registry.getAllEntries().size, 0);
});

test('a known cat without a registration is unavailable; an unknown identifier stays unknown', () => {
  assert.throws(() => getService({}, 'opus'), /AgentService unavailable.*not-registered/);
  assert.throws(() => getService({}, 'no-such-fixture-cat'), /^Error: Unknown cat ID: no-such-fixture-cat$/);
  assert.throws(() => getService({}, 'toString'), /^Error: Unknown cat ID: toString$/);
});

test('httpstream refusal is carried to the caller', async () => {
  const reasons = new Map();
  const service = await createAcpServiceForConfig({
    projectRoot: root,
    profileId: 'kimi',
    config: config('kimi'),
    effectiveModel: 'kimi-code/k3',
    acpConfig: { command: 'never-spawn', transport: 'httpstream', startupArgs: [] },
    poolRegistry: new Map(),
    log: { info() {}, warn() {} },
    onUnavailable: (reason) => reasons.set('kimi', reason),
  });
  assert.equal(service, null);
  assert.throws(() => getService({}, 'kimi', reasons), /httpstream-missing-experimental-opt-in/);
});

test('raw spawn and pool-close errors stay out of the public diagnostic', async () => {
  const secret = 'FAKE_SPAWN_ENV_SECRET';
  const rawError = new Error(`spawn failed with API_KEY=${secret}`);
  const reasons = new Map();
  const poolRegistry = new Map([
    [
      'kimi',
      {
        async closeAll() {
          throw rawError;
        },
      },
    ],
  ]);
  const result = await skipAcpProfile(
    {
      profileId: 'kimi',
      poolRegistry,
      log: { warn() {} },
      onUnavailable: (reason) => reasons.set('kimi', reason),
    },
    'invalid-spawn-env',
    { err: rawError, env: { API_KEY: secret } },
    'Invalid ACP spawn environment',
  );
  assert.equal(result, null);
  assert.equal(poolRegistry.size, 0, 'a failed pool retirement still removes the unusable registration');
  assert.throws(() => getService({}, 'kimi', reasons), /invalid-spawn-env.*Invalid ACP spawn environment/);
  assert.doesNotMatch(JSON.stringify([...reasons]), new RegExp(secret));
});
