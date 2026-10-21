import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { Redis } from 'ioredis';
import { OWNER_CAT, OWNER_THREAD, TASK_ID, TENANT } from './f167-delegate-test-helpers.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

const { TaskThreadProposalLister, ThreadDelegateBindingProvider } = await import(
  '../dist/domains/ball-custody/ProposalStoreDelegateProvider.js'
);
const { RedisProposalStore } = await import('../dist/domains/cats/services/stores/redis/RedisProposalStore.js');
const { RedisThreadStore } = await import('../dist/domains/cats/services/stores/redis/RedisThreadStore.js');

describe('F167 Redis proposal binding completeness', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  test('unrelated recent proposals cannot evict older approved Task bindings', async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F167 Redis proposal binding completeness');
    const redis = new Redis(REDIS_URL, { keyPrefix: `f167-binding-${randomUUID()}:` });
    try {
      const store = new RedisProposalStore(redis, { ttlSeconds: 0 });
      const children = [];
      const createInput = (proposalId, overrides = {}) => ({
        proposalId,
        sourceThreadId: OWNER_THREAD,
        sourceInvocationId: 'inv-window',
        sourceCatId: OWNER_CAT,
        sourceMessageId: `msg-${proposalId}`,
        title: proposalId,
        reason: 'authorization window regression',
        parentThreadId: OWNER_THREAD,
        preferredCats: ['codex6-sol'],
        projectPath: '/test',
        createdBy: TENANT,
        subjectTaskId: TASK_ID,
        subjectTaskTitle: 'Original Task',
        initialMessage: 'Implement the original Task and return verified results.',
        ...overrides,
      });
      const approve = async (proposalId, childThreadId) => {
        await store.create(createInput(proposalId));
        await store.claimForApproval({ proposalId, approvedBy: TENANT });
        await store.finalizeApproval({ proposalId, createdThreadId: childThreadId });
        children.push({
          id: childThreadId,
          parentThreadId: OWNER_THREAD,
          createdBy: TENANT,
          createdFromProposalId: proposalId,
        });
      };

      await approve('prop-old-approved', 'thread-old-approved');
      await approve('prop-new-approved', 'thread-new-approved');
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (let index = 0; index < 100; index += 1) {
        await store.create(createInput(`prop-unrelated-${index}`, { subjectTaskId: `task-unrelated-${index}` }));
      }

      assert.equal((await store.listByThread(OWNER_THREAD)).length, 100, 'default product listing remains bounded');
      const bindingProvider = new ThreadDelegateBindingProvider(
        new TaskThreadProposalLister(
          {
            get: async (proposalId) => store.get(proposalId),
            listAllByThread: async (sourceThreadId) => store.listAllByThread(sourceThreadId),
          },
          {
            getChildThreads: async () => children,
            get: async (threadId) => children.find((child) => child.id === threadId) ?? null,
          },
        ),
      );
      const bindings = await bindingProvider.getBindingsForTask(TASK_ID, OWNER_THREAD, TENANT);
      assert.deepEqual(
        bindings.map((binding) => binding.proposalId).sort(),
        ['prop-new-approved', 'prop-old-approved'],
        'authorization lookup must enumerate beyond the default product list window',
      );
    } finally {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });

  test('a proposal persisted in another source thread is found through the exact parent child', async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F167 Redis parent-bound proposal discovery');
    const redis = new Redis(REDIS_URL, { keyPrefix: `f167-parent-binding-${randomUUID()}:` });
    try {
      const store = new RedisProposalStore(redis, { ttlSeconds: 0 });
      const threads = new RedisThreadStore(redis, { ttlSeconds: 0 });
      const parent = await threads.create(TENANT, 'Task owner', '/test');
      const studio = await threads.create(TENANT, 'Studio', '/test');
      const proposalId = 'prop-studio-parent-bound';
      await store.create({
        proposalId,
        sourceThreadId: studio.id,
        sourceInvocationId: 'inv-studio',
        sourceCatId: OWNER_CAT,
        sourceMessageId: 'message-studio',
        title: proposalId,
        reason: 'approved parent-bound execution',
        parentThreadId: parent.id,
        preferredCats: ['codex6-luna'],
        projectPath: '/test',
        createdBy: TENANT,
        subjectTaskId: TASK_ID,
        subjectTaskTitle: 'Original Task',
        initialMessage: 'Implement the original Task and return verified results.',
      });
      await store.claimForApproval({ proposalId, approvedBy: TENANT });
      const child = await threads.create(TENANT, 'Approved child', '/test', parent.id, {
        createdFromProposalId: proposalId,
        sourceThreadId: studio.id,
        sourceInvocationId: 'inv-studio',
        sourceMessageId: 'message-studio',
        approvedBy: TENANT,
        approvedAt: Date.now(),
      });
      await store.finalizeApproval({ proposalId, createdThreadId: child.id });
      assert.deepEqual(await store.listAllByThread(parent.id), [], 'source index must remain separate');

      const provider = new ThreadDelegateBindingProvider(
        new TaskThreadProposalLister(
          {
            get: async (id) => store.get(id),
            listAllByThread: async (sourceThreadId) => store.listAllByThread(sourceThreadId),
          },
          {
            getChildThreads: async (parentThreadId) => threads.getChildThreads(parentThreadId),
            get: async (threadId) => threads.get(threadId),
          },
        ),
      );
      const bindings = await provider.getBindingsForTask(TASK_ID, parent.id, TENANT);
      assert.deepEqual(bindings, [{ proposalId, approvedUnderOwner: OWNER_CAT, approvedChildThreadId: child.id }]);
    } finally {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });
});
