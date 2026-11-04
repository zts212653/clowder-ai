import { isLifecycleStoredMessageMetadata } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { QueueLedgerStore } from '../../agents/invocation/queue-ledger/QueueLedger.js';
import { queueEntryId } from '../../agents/invocation/queue-ledger/QueueLedger.js';
import { QueueLedgerKeys } from '../../agents/invocation/queue-ledger/queue-ledger-keys.js';
import {
  hydrateQueueLedgerEntry,
  RedisQueueLedgerStore,
} from '../../agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import {
  type LifecycleAppendRecoveryInput,
  type LifecycleAppendRecoveryResult,
  prepareLifecycleAppendRecovery,
} from '../lifecycle-append-recovery.js';
import { hasUnresolvedLifecycleAppend } from '../lifecycle-append-state.js';
import type { IMessageStore } from '../ports/MessageStore.js';
import { MessageKeys } from '../redis-keys/message-keys.js';
import { APPEND_INDEX_LUA } from './redis-lifecycle-append-index.js';

const COMMIT = `${APPEND_INDEX_LUA}
local expectedTypes = {'hash', 'hash', 'hash', 'list', 'hash', 'set', 'set'}
for i = 1, #KEYS do
  local kind = redis.call('TYPE', KEYS[i]).ok
  if kind ~= 'none' and kind ~= expectedTypes[i] then return redis.error_reply('APPEND_RECOVERY_WRONG_KEY_TYPE') end
end
for i = 1, 2 do
  if redis.call('EXISTS', KEYS[i]) == 0 then return -1 end
  if redis.call('HGET', KEYS[i], 'recall') or redis.call('HGET', KEYS[i], '_tombstone') or
     redis.call('HGET', KEYS[i], 'deletedAt') or redis.call('HGET', KEYS[i], 'deliveryStatus') == 'canceled' then return -2 end
  if (redis.call('HGET', KEYS[i], 'lifecycle') or '') ~= ARGV[i * 2 - 1] then return 0 end
end
if (redis.call('HGET', KEYS[3], ARGV[5]) or '') ~= ARGV[6] then return 0 end
for i = 1, 2 do redis.call('HSET', KEYS[i], 'lifecycle', ARGV[i * 2]) end
if ARGV[7] == '' then
  redis.call('HDEL', KEYS[3], ARGV[5])
  redis.call('LREM', KEYS[4], 0, ARGV[5])
  redis.call('HDEL', KEYS[5], ARGV[8])
else
  redis.call('HSET', KEYS[3], ARGV[5], ARGV[7])
  if ARGV[6] == '' then redis.call('RPUSH', KEYS[4], ARGV[5]) end
  redis.call('HSET', KEYS[5], ARGV[8], ARGV[9])
end
syncAppendIndex(KEYS[6], KEYS[7], ARGV[11], ARGV[8], ARGV[10])
return 1
`;

/** The source receipt, response membership, and original Queue identity commit together. */
export async function commitRedisLifecycleAppendRecovery(
  redis: RedisClient,
  store: Pick<IMessageStore, 'getById'>,
  input: LifecycleAppendRecoveryInput,
  ledger: QueueLedgerStore,
): Promise<LifecycleAppendRecoveryResult> {
  if (!(ledger instanceof RedisQueueLedgerStore) || !ledger.usesRedisClient(redis))
    throw new Error('Append recovery requires the matching Redis Queue ledger');
  const sourceId = input.sourceMessageId ?? input.entry?.payload.messageId;
  const threadId = input.threadId ?? input.entry?.threadId;
  if (!sourceId || !threadId) return { kind: 'conflict', reason: 'missing_source' };
  const entryId = queueEntryId(sourceId);
  const keys = [
    MessageKeys.detail(sourceId),
    MessageKeys.detail(input.failure.responseMessageId),
    QueueLedgerKeys.entries(threadId),
    QueueLedgerKeys.order(threadId),
    QueueLedgerKeys.messageIndex(threadId),
    MessageKeys.appendPending(threadId),
    MessageKeys.APPEND_PENDING_THREADS,
  ];
  for (let attempt = 0; attempt < 4; attempt++) {
    const [source, response, sourceRaw, responseRaw, queueRaw] = await Promise.all([
      store.getById(sourceId),
      store.getById(input.failure.responseMessageId),
      redis.hget(keys[0]!, 'lifecycle'),
      redis.hget(keys[1]!, 'lifecycle'),
      redis.hget(keys[2]!, entryId),
    ]);
    if (!source || !response) return { kind: 'not_found' };
    const sourceLifecycle: unknown = sourceRaw ? JSON.parse(sourceRaw) : undefined;
    const responseLifecycle: unknown = responseRaw ? JSON.parse(responseRaw) : undefined;
    if (!isLifecycleStoredMessageMetadata(sourceLifecycle) || !isLifecycleStoredMessageMetadata(responseLifecycle))
      return { kind: 'conflict', reason: 'invalid_lifecycle' };
    // Prepare from the exact CAS bytes, so an inputRead arriving between reads cannot be overwritten.
    source.lifecycle = sourceLifecycle;
    response.lifecycle = responseLifecycle;
    const prepared = prepareLifecycleAppendRecovery(
      source,
      response,
      queueRaw ? hydrateQueueLedgerEntry(queueRaw) : null,
      input,
    );
    if (prepared.kind !== 'prepared') return prepared;
    const outcome = Number(
      await redis.eval(
        COMMIT,
        keys.length,
        ...keys,
        sourceRaw ?? '',
        JSON.stringify(prepared.lifecycles[0]),
        responseRaw ?? '',
        JSON.stringify(prepared.lifecycles[1]),
        entryId,
        queueRaw ?? '',
        prepared.entry ? JSON.stringify(prepared.entry) : '',
        sourceId,
        JSON.stringify([entryId]),
        hasUnresolvedLifecycleAppend(prepared.lifecycles[0]) ? '1' : '0',
        threadId,
      ),
    );
    if (outcome === 0) continue;
    if (outcome === -1) return { kind: 'not_found' };
    if (outcome === -2) return { kind: 'conflict', reason: 'source_changed' };
    if (outcome !== 1) throw new Error(`unexpected Append recovery result: ${outcome}`);
    return {
      kind: 'applied',
      entry: prepared.entry,
      resumed: prepared.resumed,
      messages: [
        { ...source, lifecycle: prepared.lifecycles[0] },
        { ...response, lifecycle: prepared.lifecycles[1] },
      ],
    };
  }
  return { kind: 'conflict', reason: 'concurrent_change' };
}
