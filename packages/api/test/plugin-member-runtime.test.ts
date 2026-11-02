import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { CatConfig } from '@cat-cafe/shared';
import type { RuntimeProviderProfile } from '../src/config/account-resolver.js';
import type { AgentService } from '../src/domains/cats/services/types.js';
import { createMemberRuntime } from '../src/domains/plugin/member-sessions/runtime.js';
import type { MemberSessionGrant, MemberSessionScope } from '../src/domains/plugin/member-sessions/types.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'member-runtime-'));
  const previous = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const dir = join(root, '.cat-cafe');
  mkdirSync(dir);
  const accounts = {
    selected: { clientId: 'kimi', authType: 'api_key' },
    outside: { clientId: 'kimi', authType: 'api_key' },
  };
  const credentials = { selected: { apiKey: 'fixture-member-secret' }, outside: { apiKey: 'fixture-outside-secret' } };
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify(accounts));
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify(credentials));
  const cat = {
    id: 'kimi31-pro',
    clientId: 'kimi',
    defaultModel: 'kimi-code/k3.1-pro',
    accountRef: 'selected',
  } as CatConfig;
  let releases = 0,
    supported = true,
    active = true;
  const service: AgentService = {
    async *invoke() {
      throw new Error('tests must not start a model');
    },
    supportsToolExecutionPolicy: () => supported,
    freshnessCarrierCapability: () => ({
      provider: 'kimi',
      carrier: 'kimi_stream_json',
      deliverySemantics: 'unsupported',
      activeInvocationGuidance: 'unsupported',
    }),
    forInvocation: () => ({
      ...service,
      releaseInvocation: async () => {
        releases++;
      },
    }),
  };
  const scope: MemberSessionScope = {
    pluginInstanceId: 'instance',
    packageDigest: 'digest',
    ownerUserId: 'owner',
    assertCurrent: async () => {
      if (!active) throw new Error('stopped');
    },
  };
  const input = {
    threadId: 'game-thread',
    catId: cat.id,
    contributionId: 'game-mcp',
    identity: 'identity',
    memory: [],
  };
  const runtime = createMemberRuntime({
    config: () => cat,
    service: () => service,
    workspace: async () => ({ usesDefaultWorkspace: false, workingDirectory: root, workingProjectRoot: root }),
  });
  return {
    root,
    dir,
    cat,
    scope,
    input,
    runtime,
    service,
    credentials,
    releases: () => releases,
    unsupported: () => {
      supported = false;
    },
    stop: () => {
      active = false;
    },
  };
}

test('stored member account remains pinned when the ordinary cat default changes; no secret or catalog writes', async (t) => {
  const f = fixture(t);
  const before = readFileSync(join(f.dir, 'accounts.json'), 'utf8');
  const first = await f.runtime.snapshot(f.input, f.scope);
  assert.equal(first.account.accountRef, 'selected');
  f.cat.accountRef = 'outside';
  const stored = { ...f.input, schema: 'host.member-session.v1', runtime: first } as MemberSessionGrant;
  const frame = await f.runtime.acquire(stored, f.scope);
  try {
    assert.deepEqual(frame.runtime, first);
    assert.equal(frame.binding.resolvedAccount?.apiKey, 'fixture-member-secret');
    assert.ok(!JSON.stringify(first).includes('secret'));
    assert.equal(f.cat.accountRef, 'outside');
    assert.equal(readFileSync(join(f.dir, 'accounts.json'), 'utf8'), before);
  } finally {
    await frame.release();
  }
  assert.equal(f.releases(), 2);
});

test('changed or deleted selected credential pauses instead of selecting an outside account', async (t) => {
  const f = fixture(t);
  const first = await f.runtime.snapshot(f.input, f.scope);
  const stored = { ...f.input, schema: 'host.member-session.v1', runtime: first } as MemberSessionGrant;
  f.cat.accountRef = 'outside';
  f.credentials.selected.apiKey = 'rotated-fixture-secret';
  writeFileSync(join(f.dir, 'credentials.json'), JSON.stringify(f.credentials));
  await assert.rejects(f.runtime.acquire(stored, f.scope), /revision changed/);
  writeFileSync(join(f.dir, 'credentials.json'), JSON.stringify({ outside: f.credentials.outside }));
  await assert.rejects(f.runtime.acquire(stored, f.scope), /key/i);
  assert.equal(f.releases(), 3);
});

test('a transport-owned real native account is frozen without inventing a builtin ACP account or writing the catalog', async (t) => {
  const f = fixture(t);
  f.cat.clientId = 'acp';
  f.cat.defaultModel = '["deepseek-official","deepseek-flash"]';
  delete f.cat.accountRef;
  const account: RuntimeProviderProfile = {
    id: 'native-dsh-fixture',
    persistedClientId: 'acp',
    authType: 'api_key',
    displayName: 'Existing native credential',
    apiKey: 'EXAMPLE',
  };
  Object.assign(f.service, { resolveScopedNativeAccount: async () => structuredClone(account) });
  f.service.contextCapability = () => ({
    provider: 'acp',
    carrier: 'acp',
    reportsRuntimeWindow: true,
    authoritativeUsage: true,
    usageTelemetry: 'conditional',
    nativeWindowControl: false,
    nativeCompressionControl: false,
    observesCompression: false,
    reason: 'actual ACP carrier',
  });
  const before = readFileSync(join(f.dir, 'accounts.json'), 'utf8');
  const first = await f.runtime.snapshot(f.input, f.scope);
  assert.equal(first.account.accountRef, account.id);
  assert.equal(first.account.authType, 'api_key');
  assert.equal(first.carrier, 'acp');
  assert.ok(!JSON.stringify(first).includes('EXAMPLE'));
  assert.equal(f.cat.accountRef, undefined);
  assert.equal(readFileSync(join(f.dir, 'accounts.json'), 'utf8'), before);
  const stored = { ...f.input, schema: 'host.member-session.v1', runtime: first } as MemberSessionGrant;
  account.apiKey = 'PLACEHOLDER';
  await assert.rejects(f.runtime.acquire(stored, f.scope), /revision changed/);
  assert.equal(f.releases(), 2);
});

test('a transport-owned account cannot override a builtin client account family', async (t) => {
  const f = fixture(t);
  Object.assign(f.service, {
    resolveScopedNativeAccount: async () => ({
      id: 'foreign-native',
      persistedClientId: 'acp',
      authType: 'api_key',
      apiKey: 'foreign-key',
    }),
  });
  await assert.rejects(f.runtime.snapshot(f.input, f.scope), /native account carrier mismatch/);
  assert.equal(f.releases(), 1);
});

test('unsupported native policy and a stop during workspace resolution never launch and always release', async (t) => {
  const f = fixture(t);
  f.unsupported();
  await assert.rejects(f.runtime.snapshot(f.input, f.scope), /member_native_carrier_unavailable/);
  assert.equal(f.releases(), 1);
  const duringAwait = createMemberRuntime({
    config: () => f.cat,
    service: () => ({
      async *invoke() {
        throw new Error('no launch');
      },
      releaseInvocation: async () => {},
      supportsToolExecutionPolicy: () => true,
    }),
    workspace: async () => {
      f.stop();
      return { usesDefaultWorkspace: false, workingDirectory: f.root };
    },
  });
  await assert.rejects(duringAwait.snapshot(f.input, f.scope), /stopped/);
});

test('the concrete carrier can reject the selected account before a runtime grant is returned', async (t) => {
  const f = fixture(t);
  let seen = '';
  f.service.assertScopedMemberAccount = (account) => {
    seen = `${account.accountRef}:${account.authType}`;
    throw new Error('selected_combination_unavailable');
  };
  await assert.rejects(f.runtime.acquire(f.input, f.scope), /selected_combination_unavailable/);
  assert.equal(seen, 'selected:api_key');
  assert.equal(f.releases(), 1);
  assert.equal(f.cat.accountRef, 'selected');
});
