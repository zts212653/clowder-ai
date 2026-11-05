import { isLifecycleStoredMessageMetadata } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { QueueLedgerStore } from '../../agents/invocation/queue-ledger/QueueLedger.js';
import { QueueLedgerKeys } from '../../agents/invocation/queue-ledger/queue-ledger-keys.js';
import {
  hydrateQueueLedgerEntry,
  RedisQueueLedgerStore,
} from '../../agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import {
  type LifecycleWakeCoverageInput,
  type LifecycleWakeCoverageResult,
  prepareLifecycleWakeCoverage,
} from '../lifecycle-wake-coverage.js';
import type { IMessageStore, StoredMessage } from '../ports/MessageStore.js';
import { MessageKeys } from '../redis-keys/message-keys.js';
import { safeParseExtra } from './redis-message-parsers.js';

const COMMIT = `
local count = tonumber(ARGV[1])
local plan = cjson.decode(ARGV[2])
for i = 1, #KEYS do
  local kind = redis.call('TYPE', KEYS[i]).ok
  local expected = i == count + 3 and 'list' or 'hash'
  if kind ~= 'none' and kind ~= expected then return redis.error_reply('WAKE_COVERAGE_WRONG_KEY_TYPE') end
end
for i = 1, count + 1 do
  if redis.call('EXISTS', KEYS[i]) == 0 then return -1 end
  if redis.call('HGET', KEYS[i], 'recall') or redis.call('HGET', KEYS[i], '_tombstone') or
     redis.call('HGET', KEYS[i], 'deletedAt') or redis.call('HGET', KEYS[i], 'deliveryStatus') == 'canceled' then return -2 end
  if i <= count then
    if redis.call('HGET', KEYS[i], 'visibility') == 'whisper' then return -2 end
    if (redis.call('HGET', KEYS[i], 'deliveryStatus') or '') ~= plan.messages[i].deliveryBefore then return 0 end
  end
  if (redis.call('HGET', KEYS[i], 'lifecycle') or '') ~= plan.messages[i].before then return 0 end
end
if (redis.call('HGET', KEYS[count + 1], 'extra') or '') ~= plan.extra.before then return 0 end
for i = 1, count do
  local row = plan.entries[i]
  if (redis.call('HGET', KEYS[count + 2], row.id) or '') ~= row.before then return 0 end
  if (redis.call('HGET', KEYS[count + 4], row.messageId) or '') ~= row.indexBefore then return 0 end
end
for i = 1, count + 1 do
  redis.call('HSET', KEYS[i], 'lifecycle', plan.messages[i].after)
  if i <= count and plan.messages[i].deliveryBefore == 'queued' then
    redis.call('HSET', KEYS[i], 'deliveryStatus', 'delivered', 'deliveredAt', plan.messages[i].deliveredAt,
      'timelineOrderAt', plan.messages[i].timelineOrderAt)
  end
end
redis.call('HSET', KEYS[count + 1], 'extra', plan.extra.after)
for i = 1, count do
  local row = plan.entries[i]
  if row.after ~= '' then
    redis.call('HSET', KEYS[count + 2], row.id, row.after)
  else
    redis.call('HDEL', KEYS[count + 2], row.id)
    redis.call('LREM', KEYS[count + 3], 1, row.id)
    if row.indexAfter == '' then redis.call('HDEL', KEYS[count + 4], row.messageId)
    else redis.call('HSET', KEYS[count + 4], row.messageId, row.indexAfter) end
  end
end
return 1
`;

/** The exact projected sources, processing response and pending targets share one CAS. */
export async function commitRedisLifecycleWakeCoverage(
  redis: RedisClient,
  store: Pick<IMessageStore, 'getById'>,
  input: LifecycleWakeCoverageInput,
  ledger: QueueLedgerStore,
): Promise<LifecycleWakeCoverageResult> {
  if (!(ledger instanceof RedisQueueLedgerStore) || !ledger.usesRedisClient(redis))
    throw new Error('Wake coverage requires the matching Redis Queue ledger');
  // Also establish the canonical v2 index before reading raw CAS bytes.
  await ledger.getByMessageIds(
    input.threadId,
    input.entries.map((entry) => entry.messageId),
  );
  const ids = [...input.entries.map((entry) => entry.messageId), input.responseMessageId];
  const messageKeys = ids.map((id) => MessageKeys.detail(id));
  const queueKey = QueueLedgerKeys.entries(input.threadId);
  const indexKey = QueueLedgerKeys.messageIndex(input.threadId);
  for (let attempt = 0; attempt < 4; attempt++) {
    const [messages, lifecycles, extra, rows, indexes] = await Promise.all([
      Promise.all(ids.map((id) => store.getById(id))),
      Promise.all(messageKeys.map((key) => redis.hget(key, 'lifecycle'))),
      redis.hget(messageKeys.at(-1)!, 'extra'),
      Promise.all(input.entries.map((entry) => redis.hget(queueKey, entry.entryId))),
      Promise.all(input.entries.map((entry) => redis.hget(indexKey, entry.messageId))),
    ]);
    if (messages.some((message) => !message)) return { kind: 'not_found' };
    for (const [index, raw] of lifecycles.entries()) {
      const lifecycle: unknown = raw ? JSON.parse(raw) : undefined;
      if (lifecycle !== undefined && !isLifecycleStoredMessageMetadata(lifecycle))
        return { kind: 'conflict', reason: 'invalid_lifecycle' };
      messages[index]!.lifecycle = lifecycle;
    }
    // A concurrent receipt changes extra independently of lifecycle; use the exact fenced version.
    const rawExtra: unknown = extra ? JSON.parse(extra) : {};
    if (typeof rawExtra !== 'object' || rawExtra === null || Array.isArray(rawExtra))
      return { kind: 'conflict', reason: 'invalid_extra' };
    const parsedExtra = safeParseExtra(extra ?? undefined);
    if (
      ('coveredA2AFailureReturns' in rawExtra && !parsedExtra?.coveredA2AFailureReturns) ||
      ('a2aFailureReturn' in rawExtra && !parsedExtra?.a2aFailureReturn)
    )
      return { kind: 'conflict', reason: 'invalid_failure_provenance' };
    messages.at(-1)!.extra = parsedExtra;
    const prepared = prepareLifecycleWakeCoverage(
      messages.slice(0, -1) as StoredMessage[],
      messages.at(-1)!,
      rows.map((raw) => (raw ? hydrateQueueLedgerEntry(raw) : null)),
      input,
    );
    if (prepared.kind !== 'prepared') return prepared;
    if (prepared.replayed) return { kind: 'replayed', messages: prepared.messages, entries: prepared.entries };
    const plan = {
      messages: prepared.messages.map((message, index) => ({
        before: lifecycles[index] ?? '',
        after: JSON.stringify(message.lifecycle),
        deliveryBefore: messages[index]!.deliveryStatus ?? '',
        deliveredAt: message.deliveredAt ?? '',
        timelineOrderAt: message.timelineOrderAt ?? '',
      })),
      extra: { before: extra ?? '', after: JSON.stringify({ ...rawExtra, ...prepared.messages.at(-1)!.extra }) },
      entries: input.entries.map((entry, index) => {
        const indexed: unknown = indexes[index] ? JSON.parse(indexes[index]!) : [];
        if (!Array.isArray(indexed) || indexed.some((id) => typeof id !== 'string'))
          throw new Error('Wake coverage Queue message index corrupt');
        const remaining = indexed.filter((id) => id !== entry.entryId);
        return {
          id: entry.entryId,
          messageId: entry.messageId,
          before: rows[index] ?? '',
          after: prepared.entries[index] ? JSON.stringify(prepared.entries[index]) : '',
          indexBefore: indexes[index] ?? '',
          indexAfter: remaining.length ? JSON.stringify(remaining) : '',
        };
      }),
    };
    const keys = [...messageKeys, queueKey, QueueLedgerKeys.order(input.threadId), indexKey];
    const outcome = Number(
      await redis.eval(COMMIT, keys.length, ...keys, String(input.entries.length), JSON.stringify(plan)),
    );
    if (outcome === 0) continue;
    if (outcome === -1) return { kind: 'not_found' };
    if (outcome === -2) return { kind: 'conflict', reason: 'source_changed' };
    if (outcome !== 1) throw new Error(`unexpected wake coverage result: ${outcome}`);
    return { kind: 'applied', messages: prepared.messages, entries: prepared.entries };
  }
  return { kind: 'conflict', reason: 'concurrent_change' };
}
