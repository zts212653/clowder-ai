import { Redis } from 'ioredis';
import { RedisMessageStore } from '../../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import type { LiveInboxReference, LiveInboxScope } from '../../src/domains/concierge/live/inbox/live-inbox-contract.js';
import { MessageLiveInboxSource } from '../../src/domains/concierge/live/inbox/MessageLiveInboxSource.js';

const url = process.env.F317_INBOX_TEST_REDIS_URL;
const prefix = process.env.F317_INBOX_TEST_PREFIX;
if (!url || new URL(url).port !== '6398' || !prefix?.startsWith('f317-inbox-'))
  throw new Error('Isolated fixture required');
const redis = new Redis(url, { keyPrefix: prefix, maxRetriesPerRequest: 1 });
try {
  const source = new MessageLiveInboxSource({ store: new RedisMessageStore(redis), authorize: async () => true });
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
