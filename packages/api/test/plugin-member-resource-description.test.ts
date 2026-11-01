import assert from 'node:assert/strict';
import test from 'node:test';
import { type CatConfig, createCatId } from '@cat-cafe/shared';
import type { FrozenExecutionBinding } from '../src/domains/cats/services/agents/invocation/execution-account-binding.js';
import type { AgentService } from '../src/domains/cats/services/types.js';
import { createMemberResourceDescription } from '../src/domains/plugin/member-sessions/resources.js';

const scope = {
  pluginInstanceId: 'installed',
  packageDigest: 'package',
  ownerUserId: 'owner',
  assertCurrent: async () => {},
};
function fixture({ supported = true, failSelected = false, nativeDefault = false } = {}) {
  let freezes = 0,
    queries = 0;
  const config = { id: 'member', clientId: 'openai', defaultModel: 'gpt-6.1-sol' } as CatConfig;
  const account = (ref: string) => ({
    accountRef: ref,
    state: 'resolved' as const,
    entry: {
      root: '/private/credential-source',
      origin: 'canonical' as const,
      account: { clientId: 'openai' as const, authType: 'oauth' as const, displayName: ref },
    },
  });
  const service: AgentService = {
    catId: createCatId('member'),
    async *invoke() {
      queries++;
      yield { type: 'done', catId: createCatId('member'), timestamp: Date.now() };
    },
    supportsToolExecutionPolicy: () => supported,
    freshnessCarrierCapability: () => ({
      provider: 'openai',
      carrier: 'exec_json',
      deliverySemantics: 'unsupported',
      activeInvocationGuidance: 'unsupported',
    }),
  };
  const describe = createMemberResourceDescription({
    projectRoot: '/private/host-root',
    config: () => config,
    service: () => service,
    defaultAccount: () => 'existing',
    readAccounts: () => ({
      primaryRoot: '/private/credential-source',
      refs: ['existing', 'alternate'],
      resolve: (ref) => account(ref).entry,
      inspect: account,
    }),
    freezeAccount: (input) => {
      freezes++;
      if (failSelected && input.accountSelection) throw new Error('SECRET_KEY_SENTINEL /private/credential-source');
      const ref = input.accountSelection?.accountRef ?? 'existing';
      return {
        projectRoot: '/private/host-root',
        workspace: input.workspace,
        resolvedAccount: {
          id: ref,
          authType: 'oauth',
          client: 'openai',
          kind: 'builtin',
          apiKey: 'SECRET_KEY_SENTINEL',
          ...(nativeDefault && ref === 'existing' ? { syntheticNative: true } : {}),
        },
        executionAccount: { accountRef: ref, displayName: ref, authType: 'oauth', accountRevision: 'a'.repeat(64) },
      } as FrozenExecutionBinding;
    },
    memory: async () => [
      {
        sourceRef: 'cat-cafe-profile://corpus/current',
        revision: 'approved-revision',
        bytes: 12,
        text: 'PRIVATE_MEMORY_SENTINEL',
      },
    ],
  });
  return { describe, freezes: () => freezes, queries: () => queries };
}

test('the owner description exposes frozen nonsecret selections and approved references, never credential/profile content or paths', async () => {
  const f = fixture();
  const result = await f.describe('member', scope);
  assert.equal(result.available, true);
  assert.equal(result.accounts.length, 2);
  assert.deepEqual(result.accounts[1]?.selection, {
    accountRef: 'alternate',
    authType: 'oauth',
    expectedRevision: 'a'.repeat(64),
  });
  assert.deepEqual(result.memory, [
    { sourceRef: 'cat-cafe-profile://corpus/current', revision: 'approved-revision', bytes: 12 },
  ]);
  const encoded = JSON.stringify(result);
  for (const hidden of ['SECRET_KEY_SENTINEL', 'PRIVATE_MEMORY_SENTINEL', '/private/'])
    assert.ok(!encoded.includes(hidden));
  assert.equal(f.queries(), 0);
});

test('an unsupported actual carrier stays unavailable without freezing or invoking a different provider', async () => {
  const f = fixture({ supported: false });
  const result = await f.describe('member', scope);
  assert.equal(result.available, false);
  assert.equal(result.reason, 'member_native_carrier_unavailable');
  assert.ok(result.accounts.every((account) => !account.available));
  assert.equal(f.freezes(), 0);
  assert.equal(f.queries(), 0);
});

test('an unusable alternate account is reported with a safe code while the existing default remains selectable', async () => {
  const f = fixture({ failSelected: true });
  const result = await f.describe('member', scope);
  assert.equal(result.accounts[0]?.available, true);
  assert.equal(result.accounts[1]?.available, false);
  assert.equal(result.accounts[1]?.reason, 'member_account_unavailable');
  assert.ok(!JSON.stringify(result).includes('SECRET_KEY_SENTINEL'));
});

test('a synthetic native default keeps the existing implicit login path and is not advertised as a separately registered override', async () => {
  const f = fixture({ nativeDefault: true });
  const result = await f.describe('member', scope);
  assert.equal(result.accounts[0]?.available, true);
  assert.equal(result.accounts[0]?.selection, undefined);
  assert.equal(result.accounts[1]?.selection?.accountRef, 'alternate');
});
