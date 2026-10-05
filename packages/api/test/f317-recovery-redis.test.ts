import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Redis } from 'ioredis';
import { scope } from './helpers/f317-recovery-fixture.js';
import { isolatedRecoveryRedisUrl, redisRecoverySources } from './helpers/f317-recovery-redis-sources.js';

test(
  'a separate process recovers 130 TTL-0 tasks and a settled approval while withholding 130 unproven recaps',
  { skip: !process.env.F317_INBOX_TEST_REDIS_URL, timeout: 30_000 },
  async () => {
    const url = isolatedRecoveryRedisUrl();
    const keyPrefix = `f317-recovery-${randomUUID()}:`;
    const redis = new Redis(url, { keyPrefix, maxRetriesPerRequest: 1 });
    const { tasks, summaries, messages, proposals } = redisRecoverySources(redis);
    try {
      const taskIds: string[] = [];
      const summaryIds: string[] = [];
      for (let i = 0; i < 130; i++) {
        const task = await tasks.create({
          threadId: scope.threadId,
          userId: scope.userId,
          title: `unfinished ${i}`,
          why: 'accepted work',
          createdBy: scope.catId,
        });
        taskIds.push(task.id);
        const summary = await summaries.create({
          threadId: scope.threadId,
          topic: `recap ${i}`,
          conclusions: ['recorded, not authorization'],
          openQuestions: [],
          createdBy: scope.catId,
        });
        summaryIds.push(summary.id);
      }
      const message = await messages.append({
        userId: scope.userId,
        threadId: scope.threadId,
        catId: scope.catId,
        content: 'proposal origin',
        mentions: [],
        timestamp: 1,
      });
      const proposal = await proposals.create({
        sourceThreadId: scope.threadId,
        sourceInvocationId: 'old-child',
        sourceCatId: scope.catId,
        sourceMessageId: message.id,
        title: 'approved',
        reason: 'source',
        parentThreadId: scope.threadId,
        preferredCats: [scope.catId],
        projectPath: '/test',
        createdBy: scope.userId,
      });
      await proposals.commitEnvelope(proposal.proposalId, {
        canonicalProposalId: proposal.proposalId,
        sourceFeatureId: 'F128',
        ownerUserId: scope.userId,
        requesterCatId: scope.catId,
        originRef: { kind: 'message', threadId: scope.threadId, messageId: message.id },
        approvalCardRef: { threadId: scope.threadId, messageId: message.id },
        createdAt: proposal.createdAt,
      });
      await proposals.claimForApproval({ proposalId: proposal.proposalId, approvedBy: scope.userId });
      await proposals.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: 'actual-child' });
      assert.equal(await redis.ttl(`task:${taskIds[0]}`), -1);
      assert.equal(await redis.ttl(`summary:${summaryIds[0]}`), -1);
      await redis.quit();
      const result = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'test/helpers/f317-recovery-redis-reader.ts'],
        {
          env: { ...process.env, F317_RECOVERY_TEST_PREFIX: keyPrefix },
          timeout: 15000,
          maxBuffer: 1_000_000,
        },
      );
      const restored = JSON.parse(result.stdout) as {
        taskIds: string[];
        summaryItems: unknown[];
        proposalIds: string[];
      };
      assert.deepEqual(restored.taskIds.sort(), taskIds.sort());
      assert.deepEqual(restored.summaryItems, []);
      assert.deepEqual(restored.proposalIds, [proposal.proposalId]);
    } finally {
      redis.disconnect();
      const cleanup = new Redis(url, { keyPrefix, maxRetriesPerRequest: 1 });
      try {
        const keys = await cleanup.keys(`${keyPrefix}*`);
        if (keys.length) await cleanup.del(...keys.map((key) => key.slice(keyPrefix.length)));
      } finally {
        await cleanup.quit();
      }
    }
  },
);
