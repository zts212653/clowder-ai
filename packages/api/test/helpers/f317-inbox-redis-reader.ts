import { Redis } from 'ioredis';
import { InvocationQueue } from '../../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { RedisQueueLedgerStore } from '../../src/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisMessageStore } from '../../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import type { LiveInboxReference, LiveInboxScope } from '../../src/domains/concierge/live/inbox/live-inbox-contract.js';
import { MessageLiveInboxSource } from '../../src/domains/concierge/live/inbox/MessageLiveInboxSource.js';

const socket = process.env.F317_INBOX_TEST_REDIS_SOCKET;
const prefix = process.env.F317_INBOX_TEST_PREFIX;
if (
  !socket?.startsWith('/tmp/a2a-live-inbox-') ||
  !socket.endsWith('/redis.sock') ||
  !prefix?.startsWith('f317-inbox-')
)
  throw new Error('Owned portless fixture required');
const redis = new Redis({ path: socket, keyPrefix: prefix, retryStrategy: () => null, maxRetriesPerRequest: 0 });
try {
  const store = new RedisMessageStore(redis);
  const queue = new InvocationQueue(new RedisQueueLedgerStore(redis));
  await queue.hydrateFromLedger(store);
  const source = new MessageLiveInboxSource({ store, queue, authorize: async () => true });
  const scope = JSON.parse(process.env.F317_INBOX_TEST_SCOPE ?? '{}') as LiveInboxScope;
  const items: LiveInboxReference[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < 20; n++) {
    const page = await source.page(scope, cursor, 37);
    items.push(...page.items);
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }
  process.stdout.write(JSON.stringify(items));
} finally {
  await redis.quit();
}
