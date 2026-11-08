import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import {
  ExecutionAdmissionConflict,
  StaleServiceSourceConflict,
} from '../../dist/domains/cats/services/agents/registry/AgentServiceUnavailableError.js';

async function fixture(t, memberEnvironment) {
  const root = mkdtempSync(join(tmpdir(), 'acp-effective-configuration-'));
  const pools = new Map();
  const services = [];
  const profileId = 'effective-configuration';
  const input = {
    projectRoot: root,
    bootstrapRoot: join(root, 'bootstrap'),
    profileId,
    config: {
      ...catRegistry.getAllConfigs().codex,
      id: profileId,
      clientId: 'acp',
      configurationSource: 'native_tool',
      accountRef: undefined,
      mcpSupport: false,
      ...(memberEnvironment ? { env: memberEnvironment } : {}),
    },
    effectiveModel: 'fixture-model',
    acpConfig: { command: process.execPath, startupArgs: [] },
    poolRegistry: pools,
    log: { info() {}, warn() {} },
  };
  t.after(async () => {
    await Promise.allSettled(services.map((service) => service.disposeHostService()));
    await Promise.allSettled([...pools.values()].map((pool) => pool.closeAll()));
    rmSync(root, { recursive: true, force: true });
  });
  return {
    input,
    root,
    pools,
    profileId,
    options: { workingDirectory: root, mcpSupport: false },
    async create() {
      const service = await createAcpServiceForConfig(input);
      assert.ok(service);
      services.push(service);
      return service;
    },
  };
}

function environment(t, name, value) {
  const original = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
}

test('unrelated Host environment changes neither admission nor compatible ACP pool identity', async (t) => {
  const key = 'ROLE_CONFIGURATION_UNUSED';
  environment(t, key, 'first');
  const f = await fixture(t);
  const service = await f.create();
  await service.captureInvocationOptions(f.options);
  const pool = f.pools.get(f.profileId);
  process.env[key] = 'second';
  await service.captureInvocationOptions(f.options);
  const next = await f.create();
  await next.captureInvocationOptions(f.options);
  assert.equal(f.pools.get(f.profileId), pool, 'an unrelated Host key must not retire a compatible pool');
  assert.equal(pool.clientFactory().config.preparedEnv[key], 'first', 'the admitted spawn snapshot stays frozen');
});

test(
  'a rewritten shell startup path remains a declared process dependency',
  { skip: process.platform === 'win32' },
  async (t) => {
    environment(t, 'ROLE_SHELL_STARTUP', '/tmp/provider-shell-before');
    const f = await fixture(t, { ZDOTDIR: '${ROLE_SHELL_STARTUP}' });
    const service = await f.create();
    const env = f.pools.get(f.profileId).clientFactory().config.preparedEnv;
    assert.equal(env.CAT_CAFE_ORIGINAL_ZDOTDIR, '/tmp/provider-shell-before');
    assert.notEqual(env.ZDOTDIR, env.CAT_CAFE_ORIGINAL_ZDOTDIR, 'the guard rewrites the public shell directory');
    process.env.ROLE_SHELL_STARTUP = '/tmp/provider-shell-after';
    await assert.rejects(service.captureInvocationOptions(f.options), StaleServiceSourceConflict);
  },
);

test('display-only account edits keep the pool; effective credentials refresh and drain it', async (t) => {
  const f = await fixture(t, { VENDOR_SECRET: 'member-must-not-override-account' });
  environment(t, 'CAT_CAFE_GLOBAL_CONFIG_ROOT', f.root);
  mkdirSync(join(f.root, '.cat-cafe'));
  const account = {
    clientId: 'openai',
    authType: 'api_key',
    displayName: 'before',
    models: ['gpt-test'],
    envVars: { VENDOR_SECRET: '${api_key}' },
  };
  const saveAccount = () =>
    writeFileSync(join(f.root, '.cat-cafe/accounts.json'), JSON.stringify({ fixture: account }));
  const saveKey = (apiKey) =>
    writeFileSync(join(f.root, '.cat-cafe/credentials.json'), JSON.stringify({ fixture: { apiKey } }));
  saveAccount();
  saveKey('synthetic-first');
  Object.assign(f.input.config, {
    clientId: 'openai',
    defaultModel: 'gpt-test',
    configurationSource: 'managed_account',
    accountRef: 'fixture',
  });
  f.input.effectiveModel = 'gpt-test';
  const first = await f.create();
  const pool = f.pools.get(f.profileId);
  assert.equal(pool.clientFactory().config.preparedEnv.VENDOR_SECRET, 'synthetic-first');
  account.displayName = 'after';
  saveAccount();
  await first.captureInvocationOptions({ ...f.options, accountRef: 'fixture' });
  await f.create();
  assert.equal(f.pools.get(f.profileId), pool);
  let retired = 0;
  const retire = pool.retireWhenIdle.bind(pool);
  pool.retireWhenIdle = () => {
    retired++;
    return retire();
  };
  saveKey('synthetic-second');
  await assert.rejects(
    first.captureInvocationOptions({ ...f.options, accountRef: 'fixture' }),
    StaleServiceSourceConflict,
  );
  await f.create();
  assert.notEqual(f.pools.get(f.profileId), pool);
  assert.equal(retired, 1);
  assert.equal(pool.clientFactory().config.preparedEnv.VENDOR_SECRET, 'synthetic-first');
  assert.equal(f.pools.get(f.profileId).clientFactory().config.preparedEnv.VENDOR_SECRET, 'synthetic-second');
  assert.ok(!f.pools.get(f.profileId).spawnSignature.includes('synthetic-second'));
});

test('MCP whitelist changes are captured at the session boundary without replacing a compatible process', async (t) => {
  const f = await fixture(t);
  environment(t, 'CAT_CAFE_CONFIG_ROOT', f.root);
  mkdirSync(join(f.root, '.cat-cafe'));
  writeFileSync(
    join(f.root, '.cat-cafe/capabilities.json'),
    JSON.stringify({
      version: 1,
      capabilities: ['a', 'b'].map((id) => ({
        id,
        type: 'mcp',
        enabled: true,
        globalEnabled: true,
        mcpServer: { command: process.execPath, args: [`--fixture=${id}`] },
      })),
    }),
  );
  f.input.config.mcpSupport = true;
  f.input.acpConfig.mcpWhitelist = ['a'];
  f.input.resolveCurrentAcpConfig = () => f.input.acpConfig;
  const service = await f.create();
  const options = { ...f.options, mcpSupport: true };
  const first = await service.captureInvocationOptions(options);
  const pool = f.pools.get(f.profileId);
  f.input.acpConfig = { ...f.input.acpConfig, mcpWhitelist: ['b'] };
  const next = await service.captureInvocationOptions(options);
  assert.deepEqual(
    first.frozenAcpMcpServers.map((server) => server.name),
    ['a'],
  );
  assert.deepEqual(
    next.frozenAcpMcpServers.map((server) => server.name),
    ['b'],
  );
  f.input.acpConfig = { ...f.input.acpConfig, mcpWhitelist: undefined };
  const cleared = await service.captureInvocationOptions(options);
  assert.deepEqual(
    cleared.frozenAcpMcpServers.map((server) => server.name).sort(),
    ['a', 'b'],
    'removing a whitelist consumes the current default rather than the stale constructor list',
  );
  const raced = service.captureInvocationOptions(options);
  f.input.acpConfig = { ...f.input.acpConfig, mcpWhitelist: ['a'] };
  await assert.rejects(
    raced,
    ExecutionAdmissionConflict,
    'a session-source race must retry without rebuilding the process',
  );
  const mutated = service.captureInvocationOptions(options);
  f.input.acpConfig.mcpWhitelist.push('b');
  await assert.rejects(
    mutated,
    ExecutionAdmissionConflict,
    'capture owns its list even when the source mutates in place',
  );
  const disabled = service.captureInvocationOptions({ ...options, mcpSupport: false });
  f.input.acpConfig = { ...f.input.acpConfig, mcpWhitelist: ['a'] };
  assert.deepEqual((await disabled).frozenAcpMcpServers, [], 'disabled MCP does not depend on a whitelist');
  await f.create();
  assert.equal(f.pools.get(f.profileId), pool);
});

test('a member environment reference is resolved, frozen and refreshed only when its effective value changes', async (t) => {
  const source = 'ROLE_CONFIGURATION_SOURCE';
  environment(t, source, 'first-value');
  const f = await fixture(t, { MEMBER_SERVICE_ENDPOINT: '${ROLE_CONFIGURATION_SOURCE}' });
  const service = await f.create();
  const firstPool = f.pools.get(f.profileId);
  assert.equal(firstPool.clientFactory().config.preparedEnv.MEMBER_SERVICE_ENDPOINT, 'first-value');
  await service.captureInvocationOptions(f.options);
  process.env[source] = 'second-value';
  await assert.rejects(service.captureInvocationOptions(f.options), StaleServiceSourceConflict);
  assert.equal(firstPool.clientFactory().config.preparedEnv.MEMBER_SERVICE_ENDPOINT, 'first-value');
  const next = await f.create();
  await next.captureInvocationOptions(f.options);
  const nextPool = f.pools.get(f.profileId);
  assert.notEqual(nextPool, firstPool);
  assert.equal(nextPool.clientFactory().config.preparedEnv.MEMBER_SERVICE_ENDPOINT, 'second-value');
  await f.create();
  assert.equal(f.pools.get(f.profileId), nextPool, 'the same effective view must not rebuild again');
  f.input.config.env = { Z_LAST: 'z', ...f.input.config.env, A_FIRST: 'a' };
  await f.create();
  const reorderedPool = f.pools.get(f.profileId);
  f.input.config.env = Object.fromEntries(Object.entries(f.input.config.env).reverse());
  await f.create();
  assert.equal(f.pools.get(f.profileId), reorderedPool, 'environment declaration order is not process identity');
});
