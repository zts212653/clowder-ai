import assert from 'node:assert/strict';
import test from 'node:test';
import { withPluginCallContext } from '../src/domains/plugin/carrier/plugin-call-context.js';
import { createPluginMemberSessions } from '../src/domains/plugin/member-sessions/service.js';
import { memberSessionFixture } from './helpers/plugin-member-session-fixture.js';

test('automatic authenticated owner operation reads cannot create a grant', async () => {
  const f = memberSessionFixture(),
    port = createPluginMemberSessions(f.deps).forInstance(f.scope());
  await assert.rejects(
    () => f.owner(() => port.prepare(f.prepareInput), 'automatic-list', false),
    /owner_confirmation_required/,
  );
  assert.equal(f.rows.size, 0);
  assert.equal(f.sends(), 0);
});

test('an authentic unconfirmed owner operation can revoke an existing grant but cannot renew it', async () => {
  const f = memberSessionFixture(),
    port = createPluginMemberSessions(f.deps).forInstance(f.scope());
  const grant = await f.owner(() => port.prepare(f.prepareInput));
  const revoked = await f.owner(() => port.revoke(grant.sessionId), 'owner-pause', false);
  assert.equal(revoked.revoked, true);
  await assert.rejects(
    () => f.owner(() => port.prepare(f.prepareInput), 'unconfirmed-resume', false),
    /owner_confirmation_required/,
  );
  const resumed = await f.owner(() => port.prepare(f.prepareInput), 'confirmed-resume');
  assert.equal(resumed.generation, grant.generation + 1);
});

test('a live native action can prepare for a verified direct owner request without another browser confirmation', async () => {
  const f = memberSessionFixture();
  let checks = 0;
  const port = createPluginMemberSessions({
    ...f.deps,
    assertOwnerDelegation: async () => {
      checks++;
    },
  }).forInstance(f.scope());
  const caller = {
    catId: 'operator',
    threadId: 'owner-thread',
    userId: f.scope().ownerUserId,
    invocationId: 'owner-invocation',
    ownerAuthProvenance: 'strict' as const,
    originTriggerMessageId: 'canonical-owner-request',
    nativeAction: { id: 'host-native-call', contributionId: 'manager', method: 'manager.start' },
    assertCurrent: async () => {},
  };
  const grant = await withPluginCallContext('installed', caller, () => port.prepare(f.prepareInput));
  assert.equal(grant.revoked, false);
  assert.ok(checks > 0, 'the actual owner source must be checked before issuing authority');
  assert.equal(f.sends(), 0);
});

test('game policies and missing canonical verifier cannot borrow conversational owner authority', async () => {
  const f = memberSessionFixture();
  const caller = {
    catId: 'operator',
    threadId: 'owner-thread',
    userId: 'owner',
    invocationId: 'owner-invocation',
    ownerAuthProvenance: 'strict' as const,
    originTriggerMessageId: 'real-human',
    nativeAction: { id: 'host-call', contributionId: 'manager', method: 'manager.start' },
    assertCurrent: async () => {},
  };
  for (const toolExecutionPolicy of [
    { mode: 'read_only' as const, replayDeniedToolNames: [] },
    { mode: 'plugin_native' as const, pluginInstanceId: 'installed', contributionId: 'player-tools' },
  ]) {
    const port = createPluginMemberSessions({ ...f.deps, assertOwnerDelegation: async () => {} }).forInstance(
      f.scope(),
    );
    await assert.rejects(
      withPluginCallContext('installed', { ...caller, toolExecutionPolicy }, () => port.prepare(f.prepareInput)),
      /owner_authority_required/,
    );
  }
  const port = createPluginMemberSessions(f.deps).forInstance(f.scope());
  await assert.rejects(
    withPluginCallContext('installed', caller, () => port.prepare(f.prepareInput)),
    /owner_authority_required/,
  );
  assert.equal(f.rows.size, 0);
});

test('a direct owner source withdrawn during account resolution cannot leave an execution grant', async () => {
  const f = memberSessionFixture();
  let current = true;
  const port = createPluginMemberSessions({
    ...f.deps,
    assertOwnerDelegation: async () => {
      if (!current) throw new Error('owner_source_recalled');
    },
    resolveRuntime: async () => {
      const result = await f.deps.resolveRuntime();
      current = false;
      return result;
    },
  }).forInstance(f.scope());
  const caller = {
    catId: 'operator',
    threadId: 'owner-thread',
    userId: 'owner',
    invocationId: 'owner-invocation',
    ownerAuthProvenance: 'strict' as const,
    originTriggerMessageId: 'real-human',
    nativeAction: { id: 'host-call', contributionId: 'manager', method: 'manager.start' },
    assertCurrent: async () => {},
  };
  await assert.rejects(
    withPluginCallContext('installed', caller, () => port.prepare(f.prepareInput)),
    /owner_source_recalled/,
  );
  assert.equal(f.rows.size, 0);
  assert.equal(f.sends(), 0);
});
