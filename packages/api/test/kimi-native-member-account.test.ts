import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { type CatConfig, createCatId } from '@cat-cafe/shared';
import { readKimiNativeAccount } from '../src/config/native-accounts/kimi-account.js';
import { inspectKimiNativeLaunch } from '../src/config/native-accounts/kimi-installation.js';
import { freezeExecutionAccountBinding } from '../src/domains/cats/services/agents/invocation/execution-account-binding.js';
import { AcpAgentService } from '../src/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { AcpProcessPool } from '../src/domains/cats/services/agents/providers/acp/AcpProcessPool.js';
import { ensureKimiSecretHooks } from '../src/domains/cats/services/agents/providers/kimi-secret-hooks.js';
import { createMemberResourceDescription } from '../src/domains/plugin/member-sessions/resources.js';
import { createMemberRuntime } from '../src/domains/plugin/member-sessions/runtime.js';
import { createPluginMemberSessions } from '../src/domains/plugin/member-sessions/service.js';
import { memberSessionFixture } from './helpers/plugin-member-session-fixture.js';

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kimi-native-account-'))),
    home = join(root, 'native');
  const previousRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT,
    previousHome = process.env.KIMI_CODE_HOME;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  process.env.KIMI_CODE_HOME = home;
  let spawns = 0;
  const pool = new AcpProcessPool({ maxLiveProcesses: 1 }, {}, () => {
    spawns++;
    throw new Error('no_model');
  });
  t.after(async () => {
    await pool.closeAll();
    if (previousRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousRoot;
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'program/dist'), { recursive: true });
  mkdirSync(join(root, '.cat-cafe'));
  mkdirSync(home);
  const entry = join(root, 'program/dist/main.mjs'),
    command = join(root, 'kimi');
  writeFileSync(entry, '#!/usr/bin/env node\nprocess.exit(1);\n');
  chmodSync(entry, 0o700);
  symlinkSync(entry, command);
  writeFileSync(
    join(root, 'program/package.json'),
    JSON.stringify({ name: '@moonshot-ai/kimi-code', version: '2.3.1' }),
  );
  writeFileSync(
    join(root, '.cat-cafe/accounts.json'),
    JSON.stringify({
      existing: { clientId: 'kimi', authType: 'oauth' },
      gateway: { clientId: 'kimi', authType: 'api_key' },
    }),
  );
  writeFileSync(join(root, '.cat-cafe/credentials.json'), JSON.stringify({ gateway: { apiKey: 'EXAMPLE' } }));
  const configPath = join(home, 'config.toml');
  writeFileSync(
    configPath,
    'default_model = "kimi-code/k3.1-pro"\n[providers."managed:kimi-code"]\ntype = "kimi"\n[providers."managed:kimi-code".oauth]\nstorage = "file"\nkey = "oauth/kimi-code"\n[models."kimi-code/k3.1-pro"]\nprovider = "managed:kimi-code"\nmodel = "k3.1-pro"\n',
  );
  await ensureKimiSecretHooks({ KIMI_CODE_HOME: home });
  const native = inspectKimiNativeLaunch({
    command,
    args: ['acp'],
    env: {},
    projectRoot: root,
    accountRef: 'existing',
  });
  assert.ok(native);
  const config = {
    id: createCatId('member'),
    clientId: 'kimi',
    carrier: 'acp',
    defaultModel: 'kimi-code/k3.1-pro',
    accountRef: 'existing',
  } as CatConfig;
  const service = new AcpAgentService({
    catId: config.id,
    pool,
    poolKey: { projectPath: root, providerProfile: 'kimi' },
    projectRoot: root,
    providerName: 'kimi',
    modelName: config.defaultModel,
    nativeKimi: native,
  });
  const workspace = { workingDirectory: root, workingProjectRoot: root, usesDefaultWorkspace: false };
  const describe = createMemberResourceDescription({
    projectRoot: root,
    config: () => config,
    service: () => service,
    memory: async () => [],
  });
  const runtime = createMemberRuntime({
    config: () => config,
    service: () => service,
    workspace: async () => workspace,
  });
  return { root, home, configPath, native, config, service, workspace, describe, runtime, spawns: () => spawns };
}

test('owner discovery and runtime share the original native OAuth source revision without writes', async (t) => {
  const f = await fixture(t),
    before = readFileSync(f.configPath, 'utf8'),
    base = memberSessionFixture();
  const description = await f.describe(f.config.id, base.scope());
  const existing = description.accounts.find((account) => account.accountRef === 'existing');
  assert.equal(existing?.available, true);
  assert.ok(existing?.selection);
  assert.equal(description.accounts.find((account) => account.accountRef === 'gateway')?.available, false);
  const runtime = await f.runtime.snapshot(
    { ...base.prepareInput, catId: f.config.id, accountSelection: existing.selection },
    base.scope(),
  );
  assert.equal(runtime.carrier, 'acp');
  assert.equal(runtime.account.accountRevision, existing.accountRevision);
  assert.equal(readFileSync(f.configPath, 'utf8'), before);
  assert.equal(f.spawns(), 0);
});

test('scoped native discovery preserves hooks installed by another Host checkout', async (t) => {
  const f = await fixture(t),
    base = memberSessionFixture();
  const config = readFileSync(f.configPath, 'utf8').replaceAll(
    '/dist/runtime/scripts/secret-kimi-hook.mjs',
    '/another-host/dist/runtime/scripts/secret-kimi-hook.mjs',
  );
  assert.notEqual(config, readFileSync(f.configPath, 'utf8'));
  writeFileSync(f.configPath, config);
  const description = await f.describe(f.config.id, base.scope());
  assert.equal(description.available, true);
  const existing = description.accounts.find((account) => account.accountRef === 'existing');
  assert.ok(existing?.selection);
  const runtime = await f.runtime.snapshot(
    { ...base.prepareInput, catId: f.config.id, accountSelection: existing.selection },
    base.scope(),
  );
  assert.equal(runtime.account.authType, 'oauth');
  assert.equal(readFileSync(f.configPath, 'utf8'), config);
  assert.equal(f.spawns(), 0);
  assert.equal(base.sends(), 0);
});

test('native config changes invalidate the saved choice while the ordinary account is preserved', async (t) => {
  const f = await fixture(t),
    options = { catId: f.config.id, catConfig: f.config, workspace: f.workspace };
  const ordinary = freezeExecutionAccountBinding(options);
  const account = await readKimiNativeAccount(f.native, f.config.defaultModel);
  const bound = freezeExecutionAccountBinding({ ...options, nativeAccount: account.profile });
  assert.ok(bound.executionAccount);
  writeFileSync(f.configPath, readFileSync(f.configPath, 'utf8') + '\n# changed native configuration\n');
  const changed = await readKimiNativeAccount(f.native, f.config.defaultModel);
  assert.throws(
    () =>
      freezeExecutionAccountBinding({
        ...options,
        nativeAccount: changed.profile,
        accountSelection: {
          accountRef: 'existing',
          authType: 'oauth',
          expectedRevision: bound.executionAccount.accountRevision,
        },
      }),
    /revision changed/,
  );
  assert.deepEqual(freezeExecutionAccountBinding(options).executionAccount, ordinary.executionAccount);
  assert.equal(f.spawns(), 0);
});

test('unsupported native versions, altered startup arguments and API choices stay unavailable', async (t) => {
  const f = await fixture(t);
  assert.equal(inspectKimiNativeLaunch({ ...f.native, args: ['acp', '--agent-file', 'other.md'] }), null);
  await assert.rejects(
    readKimiNativeAccount(f.native, f.config.defaultModel, 'gateway'),
    /kimi_native_account_unavailable/,
  );
  writeFileSync(f.native.packagePath, JSON.stringify({ name: '@moonshot-ai/kimi-code', version: '2.4.0' }));
  assert.equal(inspectKimiNativeLaunch(f.native), null);
  assert.equal((await f.describe(f.config.id, memberSessionFixture().scope())).available, false);
  assert.equal(f.spawns(), 0);
});

test('prepare rejects an API choice before writing a grant, while original native OAuth can prepare', async (t) => {
  const f = await fixture(t),
    base = memberSessionFixture();
  const port = createPluginMemberSessions({
    ...base.deps,
    resolveRuntime: (input, scope) => f.runtime.snapshot(input, scope),
  }).forInstance(base.scope());
  await assert.rejects(
    base.owner(() =>
      port.prepare({ ...base.prepareInput, accountSelection: { accountRef: 'gateway', authType: 'api_key' } }),
    ),
    /kimi_native_account_unavailable/,
  );
  assert.equal(
    [...base.rows.values()].some((row) => (row.value as { schema?: string }).schema === 'host.member-session.v1'),
    false,
  );
  const session = await base.owner(() => port.prepare(base.prepareInput));
  assert.equal(session.runtime.account.accountRef, 'existing');
  assert.equal(session.runtime.account.authType, 'oauth');
  assert.equal(f.spawns(), 0);
  assert.equal(base.sends(), 0);
});

test('a saved native choice stays pinned when the outside cat chooses another default account', async (t) => {
  const f = await fixture(t),
    base = memberSessionFixture();
  const port = createPluginMemberSessions({
    ...base.deps,
    resolveRuntime: (input, scope) => f.runtime.snapshot(input, scope),
  }).forInstance(base.scope());
  const session = await base.owner(() => port.prepare(base.prepareInput));
  f.config.accountRef = 'gateway';
  const saved = await f.runtime.snapshot(session, base.scope());
  assert.deepEqual(saved.account, session.runtime.account);
  assert.equal(
    freezeExecutionAccountBinding({ catId: f.config.id, catConfig: f.config, workspace: f.workspace }).executionAccount
      ?.accountRef,
    'gateway',
  );
  assert.equal(f.spawns(), 0);
  assert.equal(base.sends(), 0);
});
