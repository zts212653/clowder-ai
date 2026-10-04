import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const redisUrl = process.env.REDIS_URL;

test(
  'real Redis preserves scoped public and private Work authority across fresh clients without generic mutation',
  { skip: redisIsolationSkipReason(redisUrl) },
  async () => {
    assertRedisIsolationOrThrow(redisUrl, 'F290 persistent authority');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { RedisAuthInvocationBackend } = await import(
      '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js'
    );
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const keyPrefix = `f290-authority:${randomUUID()}:`;
    const first = createRedisClient({ url: redisUrl, keyPrefix });
    const second = createRedisClient({ url: redisUrl, keyPrefix });
    try {
      const source = {
        serviceInstanceId: 'svc_100000000000',
        collectiveId: 'col_100000000000',
        connectionId: 'con_100000000000',
        eventId: 'evt_100000000000',
        location: { channelId: 'A' },
        catId: 'codex-astra',
        participationRevision: 1,
        actor: { kind: 'human', humanId: 'human_guest00000', displayName: 'Guest' },
      };
      const grant = { kind: 'collective-participation', source, originTriggerMessageId: 'source-A' };
      const before = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(first) });
      const publicAuth = await before.create(
        'owner',
        source.catId,
        'public',
        undefined,
        undefined,
        { mode: 'collective_participation' },
        'source-A',
        'unknown',
        undefined,
        grant,
      );
      const workBinding = {
        v: 1,
        taskId: 'work',
        observedRevision: 3,
        resultRevision: 2,
        sourceRef: 'message:source-A',
        authorityRef: 'message:owner-receipt',
      };
      const privateAuth = await before.create(
        'owner',
        source.catId,
        'private',
        undefined,
        undefined,
        undefined,
        'work-trigger',
        'unknown',
        undefined,
        undefined,
        workBinding,
      );
      const messages = new RedisMessageStore(first);
      const receipt = { v: 1, sourceRef: 'message:source-A', catId: source.catId, ownerAuthProvenance: 'strict' };
      const ownerMessage = await messages.append({
        userId: 'owner',
        threadId: 'private',
        catId: null,
        content: 'Owner admission',
        mentions: [],
        timestamp: 1,
        extra: { collectiveOwnerAdmissionV1: receipt },
      });
      const delegation = {
        v: 1,
        taskId: 'work',
        observedRevision: 3,
        resultRevision: 2,
        ownerCatId: source.catId,
        targetCatIds: ['codex-sol'],
      };
      const restoredDelegation = { ...delegation, executionRevision: 1 };
      const delegatedMessage = await messages.append({
        userId: 'owner',
        threadId: 'private',
        catId: source.catId,
        content: '@codex-sol continue this private Work',
        mentions: ['codex-sol'],
        origin: 'callback',
        timestamp: 2,
        extra: { isExplicitPost: true, collectiveWorkDelegationV1: delegation },
      });
      await first.quit();

      const restarted = new InvocationRegistry({ backend: new RedisAuthInvocationBackend(second) });
      const publicResult = await restarted.verify(publicAuth.invocationId, publicAuth.callbackToken);
      assert.equal(publicResult.ok, true);
      assert.equal(publicResult.record.ownerAuthProvenance, 'unknown');
      assert.deepEqual(publicResult.record.executionGrant, grant);
      assert.deepEqual(publicResult.record.toolExecutionPolicy, { mode: 'collective_participation' });
      const privateResult = await restarted.verify(privateAuth.invocationId, privateAuth.callbackToken);
      assert.equal(privateResult.ok, true);
      assert.equal(privateResult.record.ownerAuthProvenance, 'unknown');
      assert.deepEqual(privateResult.record.collectiveWorkBinding, { ...workBinding, executionRevision: 1 });
      assert.equal(privateResult.record.executionGrant, undefined);

      const restoredMessages = new RedisMessageStore(second);
      assert.deepEqual((await restoredMessages.getById(ownerMessage.id)).extra.collectiveOwnerAdmissionV1, receipt);
      assert.deepEqual(
        (await restoredMessages.getById(delegatedMessage.id)).extra.collectiveWorkDelegationV1,
        restoredDelegation,
      );
      await restoredMessages.updateExtra(ownerMessage.id, {
        collectiveOwnerAdmissionV1: { ...receipt, sourceRef: 'message:forged' },
      });
      assert.deepEqual((await restoredMessages.getById(ownerMessage.id)).extra.collectiveOwnerAdmissionV1, receipt);
      await restoredMessages.updateExtra(delegatedMessage.id, {
        collectiveWorkDelegationV1: { ...delegation, targetCatIds: ['opus'] },
      });
      assert.deepEqual(
        (await restoredMessages.getById(delegatedMessage.id)).extra.collectiveWorkDelegationV1,
        restoredDelegation,
      );
    } finally {
      if (first.status !== 'end') await first.quit();
      await cleanupClientKeyspace(second);
      await second.quit();
    }
  },
);
