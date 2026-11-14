import type { RedisClient } from '@cat-cafe/shared/utils';
import { recoveryRedis } from '../../infrastructure/recovery/recovery-redis.js';
import { MessageKeys } from '../cats/services/stores/redis-keys/message-keys.js';
import { ThreadKeys } from '../cats/services/stores/redis-keys/thread-keys.js';
import { checkSearchExecution, type MessageSearchExecutionContext } from './message-search-lifetime.js';

export type SelectedSourceReference = { threadId: string; messageId: string };
/** A read-only witness, not an access decision or a Redis/SQLite transaction. */
export type SelectedSourceReadFence = <T>(
  references: readonly SelectedSourceReference[],
  userId: string,
  read: () => Promise<T>,
  lifetime: MessageSearchExecutionContext,
) => Promise<T | null>;

function checkWitnessReply(reply: [Error | null, unknown][]): void {
  if (reply.length !== 1 || reply[0][0] || reply[0][1] !== 'PONG')
    throw new Error('Selected source read fence unavailable');
}

/** One connection, one bounded read, no reconnect or retry. A connection loss or
 * intervening write (including ABA) invalidates the witness. No shared WATCH state. */
export function redisSelectedSourceReadFence(redis: RedisClient): SelectedSourceReadFence {
  return async (references, userId, read, lifetime) => {
    checkSearchExecution(lifetime);
    if (lifetime.deadlineAt === undefined || !Number.isFinite(lifetime.deadlineAt))
      throw new Error('Selected source witness requires a finite read deadline');
    if (!references.length || references.length > 43) throw new Error('Invalid selected source fence bound');
    const keys = [
      ...new Set([
        ThreadKeys.userList(userId),
        ...references.flatMap((ref) => [
          MessageKeys.detail(ref.messageId),
          ThreadKeys.detail(ref.threadId),
          ThreadKeys.participants(ref.threadId),
          ThreadKeys.tombstone(ref.threadId),
        ]),
      ]),
    ];
    const session = recoveryRedis(redis).duplicate({
      lazyConnect: true,
      retryStrategy: () => null,
      autoResendUnfulfilledCommands: false,
      enableOfflineQueue: false,
    });
    let invalid = false;
    const dispose = () => {
      if (invalid) return;
      invalid = true;
      session.disconnect();
      // ioredis disconnect() half-closes and can otherwise wait for its grace
      // timer. This socket belongs only to this read, so end it immediately.
      session.stream?.destroy();
    };
    let invalidate = () => {};
    let abort = () => {};
    let expire = () => {};
    const interrupted = new Promise<null>((resolve, reject) => {
      invalidate = () => {
        resolve(null);
        dispose();
      };
      abort = () => {
        reject(lifetime.signal?.reason);
        dispose();
      };
      expire = () => {
        reject(new DOMException('Selected source witness deadline exceeded', 'TimeoutError'));
        dispose();
      };
    });
    // Arm before connecting: even initial connection errors cannot yield a proof.
    const lost = () => invalidate();
    for (const event of ['close', 'end', 'reconnecting', 'error']) session.on(event, lost);
    lifetime.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(expire, Math.max(0, lifetime.deadlineAt - Date.now()));
    const intact = () => !invalid && session.status === 'ready';
    const execute = async () => {
      await session.connect();
      if (!intact()) return null;
      await session.watch(...keys);
      if (!intact()) return null;
      const result = await read();
      checkSearchExecution(lifetime);
      if (!intact()) return null;
      const committed = await session.multi().ping().exec();
      checkSearchExecution(lifetime);
      if (!intact() || committed === null) return null;
      checkWitnessReply(committed);
      return result;
    };
    try {
      checkSearchExecution(lifetime);
      return await Promise.race([interrupted, execute()]);
    } finally {
      clearTimeout(timer);
      lifetime.signal?.removeEventListener('abort', abort);
      for (const event of ['close', 'end', 'reconnecting', 'error']) session.off(event, lost);
      // Disconnect itself discards WATCH. Never wait for an UNWATCH round trip.
      dispose();
    }
  };
}
