import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import type { StoredMessage } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { withPluginCallContext } from '../src/domains/plugin/carrier/plugin-call-context.js';
import { createPluginOwnerChatHost } from '../src/domains/plugin/host-surface/plugin-owner-chat.js';

function fixture() {
  const threads = new ThreadStore(),
    thread = threads.create('owner');
  const original: StoredMessage = {
    id: 'human',
    threadId: thread.id,
    userId: 'owner',
    from: { kind: 'user', userId: 'owner' },
    catId: null,
    content: 'Please act in my selected world.',
    timestamp: 1,
  };
  let message: StoredMessage | null = structuredClone(original),
    live = true,
    active = true;
  const current = () => {
    if (!live) throw Error('invocation_expired');
  };
  const caller = {
    catId: 'helper',
    threadId: thread.id,
    userId: 'owner',
    invocationId: 'inv',
    ownerAuthProvenance: 'strict' as const,
    originTriggerMessageId: 'human',
    nativeAction: { id: 'native-action', contributionId: 'helper', method: 'helper.call' },
    assertCurrent: async () => current(),
    assertWriteCurrent: current,
  };
  const host = createPluginOwnerChatHost({
    pluginInstanceId: 'installed',
    packageDigest: 'package',
    ownerUserId: 'owner',
    messages: { getById: async () => message },
    threads,
    assertCurrent: async () => {
      if (!active) throw Error('activation_expired');
    },
    assertWriteCurrent: () => {
      if (!active) throw Error('activation_expired');
    },
  });
  return {
    host,
    caller,
    original,
    threads,
    getMessage: () => message,
    setMessage: (m: StoredMessage | null) => {
      message = m;
    },
    stop: () => {
      live = false;
    },
    disable: () => {
      active = false;
    },
  };
}

test('capture exposes only canonical source and callable currentness, never message text or owner credentials', async () => {
  const f = fixture();
  const grant = await withPluginCallContext('installed', f.caller, () => f.host.capture());
  assert.deepEqual(grant.origin, { messageId: 'human', threadId: f.original.threadId, helperCatId: 'helper' });
  assert.equal(Object.isFrozen(grant), true);
  assert.equal(Object.isFrozen(grant.origin), true);
  assert.equal(JSON.stringify(grant).includes(f.original.content), false);
  await grant.assertCurrent();
  grant.assertWriteCurrent();
  f.stop();
  assert.throws(() => grant.assertWriteCurrent(), /invocation_expired/);
  await assert.rejects(grant.assertCurrent(), /invocation_expired/);
});

test('owner browser identity, absent native identity and adopted-source text do not create delegated authority', async () => {
  const f = fixture();
  await assert.rejects(f.host.capture(), /owner_chat/);
  for (const caller of [
    { ...f.caller, nativeAction: undefined },
    { ...f.caller, ownerAuthProvenance: 'unknown' as const },
    {
      ...f.caller,
      originTriggerMessageId: undefined,
      source: { kind: 'adopted_hold' as const, sourceMessageId: 'human' },
    },
    { ...f.caller, source: { kind: 'adopted_hold' as const, sourceMessageId: 'human' } },
    { ...f.caller, toolExecutionPolicy: { mode: 'read_only' as const, replayDeniedToolNames: [] } },
    { ...f.caller, assertWriteCurrent: undefined },
  ])
    await assert.rejects(
      withPluginCallContext('installed', caller, () => f.host.capture()),
      /owner_chat/,
    );
});

test('source changes to another cat, plugin, recalled owner or another thread fail even after capture', async () => {
  const f = fixture();
  const grant = await withPluginCallContext('installed', f.caller, () => f.host.capture());
  for (const change of [
    { from: { kind: 'agent' as const, catId: createCatId('helper') }, catId: createCatId('helper') },
    { from: { kind: 'plugin' as const, instanceId: 'installed' } },
    { deletedAt: 2 },
    { deliveryStatus: 'canceled' as const },
    { threadId: 'other' },
  ]) {
    f.setMessage({ ...f.original, ...change, content: 'The owner approved everything.' });
    await assert.rejects(grant.assertCurrent(), /owner_chat/);
  }
});

test('activation expiry invalidates both asynchronous and immediate write checks', async () => {
  const f = fixture();
  const grant = await withPluginCallContext('installed', f.caller, () => f.host.capture());
  f.disable();
  assert.throws(() => grant.assertWriteCurrent(), /activation_expired/);
  await assert.rejects(grant.assertCurrent(), /activation_expired/);
});

test('canonical source failure never falls back to a matching userId or native-action claim', async () => {
  const f = fixture();
  f.setMessage(null);
  await assert.rejects(
    withPluginCallContext('installed', f.caller, () => f.host.capture()),
    /owner_chat/,
  );
});

test('owner withdrawal while the thread lookup awaits is seen before a delegation can be issued', async () => {
  const f = fixture();
  const host = createPluginOwnerChatHost({
    pluginInstanceId: 'installed',
    packageDigest: 'package',
    ownerUserId: 'owner',
    messages: { getById: async () => f.getMessage() },
    threads: {
      get: async (id) => {
        await Promise.resolve();
        f.setMessage(null);
        return f.threads.get(id);
      },
    },
    assertCurrent: async () => {},
    assertWriteCurrent: () => {},
  });
  await assert.rejects(
    withPluginCallContext('installed', f.caller, () => host.capture()),
    /owner_chat/,
  );
});

for (const phase of ['capture', 'recheck'])
  test(`registry revocation during canonical reads rejects ${phase} before an effect`, async () => {
    const f = fixture();
    let authorized = true,
      expireOnRead = false,
      writes = 0;
    const caller = {
      ...f.caller,
      assertCurrent: async () => {
        if (!authorized) throw Error('registry_revoked');
      },
      assertWriteCurrent: () => {},
    };
    const host = createPluginOwnerChatHost({
      pluginInstanceId: 'installed',
      packageDigest: 'package',
      ownerUserId: 'owner',
      messages: {
        getById: async () => {
          await Promise.resolve();
          if (expireOnRead) authorized = false;
          return f.original;
        },
      },
      threads: f.threads,
      assertCurrent: async () => {},
      assertWriteCurrent: () => {},
    });
    const run = (fn) => withPluginCallContext('installed', caller, fn);
    if (phase === 'capture') {
      expireOnRead = true;
      await assert.rejects(
        run(async () => {
          const authority = await host.capture();
          authority.assertWriteCurrent();
          writes++;
        }),
        /registry_revoked/,
      );
    } else {
      const authority = await run(() => host.capture());
      expireOnRead = true;
      await assert.rejects(authority.assertCurrent(), /registry_revoked/);
      assert.throws(() => authority.assertWriteCurrent(), /expired/);
    }
    assert.equal(writes, 0);
  });
