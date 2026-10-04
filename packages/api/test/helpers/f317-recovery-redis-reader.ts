import { Redis } from 'ioredis';
import { LiveRecoveryReader } from '../../src/domains/concierge/live/recovery/LiveRecoveryReader.js';
import type { LiveRecoveryCursor } from '../../src/domains/concierge/live/recovery/live-recovery-contract.js';
import { scope } from './f317-recovery-fixture.js';
import { isolatedRecoveryRedisUrl, redisRecoverySources } from './f317-recovery-redis-sources.js';

const keyPrefix = process.env.F317_RECOVERY_TEST_PREFIX;
if (!keyPrefix?.startsWith('f317-recovery-')) throw new Error('Fixture prefix required');
const redis = new Redis(isolatedRecoveryRedisUrl(), { keyPrefix, maxRetriesPerRequest: 1 });
try {
  const reader = new LiveRecoveryReader(redisRecoverySources(redis));
  const taskIds: string[] = [];
  const summaryItems: unknown[] = [];
  const proposalIds: string[] = [];
  let cursor: LiveRecoveryCursor | undefined;
  for (let i = 0; i < 30; i++) {
    const page = await reader.read(
      { ...scope, invocationId: 'reconnected-child', generation: 2 },
      { signal: new AbortController().signal, cursor, pageSize: 13 },
    );
    taskIds.push(...page.tasks.items.map((item) => item.taskId));
    if (page.summaries.coverage !== 'unavailable_viewer_evidence') throw new Error('Unproven Summary coverage');
    summaryItems.push(...page.summaries.items);
    proposalIds.push(...page.decisions.items.map((item) => item.proposalId));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  if (cursor) throw new Error('Fixture pagination did not finish');
  process.stdout.write(JSON.stringify({ taskIds, summaryItems, proposalIds }));
} finally {
  await redis.quit();
}
