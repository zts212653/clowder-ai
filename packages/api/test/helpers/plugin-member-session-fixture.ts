import assert from 'node:assert/strict';
import { withCurrentOwnerOperation } from '../../src/domains/plugin/carrier/plugin-owner-operation-context.js';
import { createPluginMemberSessions } from '../../src/domains/plugin/member-sessions/service.js';

export function memberSessionFixture() {
  const rows = new Map<string, { revision: number; value: unknown }>();
  let revision = 0,
    sends = 0,
    attempts = 0,
    loseAck = false,
    installation = true,
    accountRevision = 'account-v1';
  let afterSend: (() => Promise<void>) | undefined;
  const messages = new Map<
    string,
    {
      messageId: string;
      threadId: string;
      content: string;
      routedCatIds: string[];
      deliveryStatus?: 'queued' | 'delivered' | 'canceled';
    }
  >();
  const storage = {
    async get(namespace: string, key: string) {
      return structuredClone(rows.get(`${namespace}:${key}`));
    },
    async compareAndSet(namespace: string, key: string, expected: number | null, value: unknown) {
      const id = `${namespace}:${key}`;
      if ((rows.get(id)?.revision ?? null) !== expected) return { applied: false };
      rows.set(id, { revision: ++revision, value: structuredClone(value) });
      return { applied: true, revision };
    },
  };
  const deps = {
    storage,
    async assertInstallation() {
      if (!installation) throw new Error('installation_revoked');
    },
    async assertThread(userId: string, threadId: string, catId: string) {
      assert.equal(userId, 'owner');
      assert.equal(threadId, 'game-thread');
      assert.equal(catId, 'member');
    },
    async resolveRuntime() {
      return {
        clientId: 'openai',
        model: 'configured-model',
        carrier: 'exec_json',
        account: { accountRef: 'existing-oauth', authType: 'oauth' as const, accountRevision },
      };
    },
    async resolveMemory(ref: { sourceRef: string; revision: string }) {
      assert.deepEqual(ref, { sourceRef: 'member-owned:naming-story', revision: 'story-v1' });
      return { ...ref, text: '主人给我的真实名字。' };
    },
    messaging: {
      async findSent(input: { idempotencyKey: string }) {
        return structuredClone(messages.get(input.idempotencyKey) ?? null);
      },
      async send(input: {
        idempotencyKey: string;
        threadId: string;
        wake: { catId: string; exact: true };
        content: string;
      }) {
        attempts++;
        assert.deepEqual(input.wake, { catId: 'member', exact: true });
        if (!messages.has(input.idempotencyKey)) {
          sends++;
          messages.set(input.idempotencyKey, {
            messageId: sends === 1 ? 'canonical-trigger' : `canonical-trigger-${sends}`,
            threadId: input.threadId,
            content: input.content,
            routedCatIds: [input.wake.catId],
          });
        }
        await afterSend?.();
        if (loseAck) {
          loseAck = false;
          throw new Error('ack_lost_after_admission');
        }
      },
    },
  };
  const scope = (packageDigest = 'package-v1') => ({
    pluginInstanceId: 'installed',
    packageDigest,
    ownerUserId: 'owner',
    assertCurrent: async () => {},
  });
  const bind = (packageDigest = 'package-v1') => createPluginMemberSessions(deps).forInstance(scope(packageDigest));
  const prepareInput = {
    threadId: 'game-thread',
    catId: 'member',
    contributionId: 'player-tools',
    identity: 'game',
    memory: [{ sourceRef: 'member-owned:naming-story', revision: 'story-v1' }],
  };
  const owner = <T>(operation: () => Promise<T>, requestId = 'actual-owner-request', confirmed = true) =>
    withCurrentOwnerOperation(
      {
        kind: 'owner-operation',
        userId: 'owner',
        pluginInstanceId: 'installed',
        operationKey: 'prepare-game',
        actionId: 'prepare',
        requestId,
        confirmed,
        signal: new AbortController().signal,
        assertWriteCurrent() {},
        assertCurrent: async () => {},
      },
      operation,
    );
  return {
    deps,
    scope,
    bind,
    afterSend: (callback: () => Promise<void>) => {
      afterSend = callback;
    },
    owner,
    prepareInput,
    rows,
    sends: () => sends,
    attempts: () => attempts,
    loseAck: () => {
      loseAck = true;
    },
    changeAccount: () => {
      accountRevision = 'account-v2';
    },
    cancelOriginal: () => {
      for (const message of messages.values()) {
        message.deliveryStatus = 'canceled';
        message.routedCatIds = [];
      }
    },
    revokeInstallation: () => {
      installation = false;
    },
  };
}
