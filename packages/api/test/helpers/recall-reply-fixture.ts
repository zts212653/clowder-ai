import type { RedisClient } from '@cat-cafe/shared/utils';
import { RedisMessageStore } from '../../src/domains/cats/services/stores/redis/RedisMessageStore.js';

export type MessageHash = Record<string, string> & { id: string };

export function fixtureRedis(
  hashes: MessageHash[],
  fault?: 'command' | 'missing' | 'null',
  afterFirstIndexRead?: (rows: MessageHash[]) => void,
) {
  const byId = new Map(hashes.map((hash) => [hash.id, hash]));
  const calls: Array<{ method: string; fields?: string[]; size?: number }> = [];
  const descending = [...hashes].sort(
    (a, b) =>
      Number(b.timelineOrderAt ?? b.timestamp) - Number(a.timelineOrderAt ?? a.timestamp) || b.id.localeCompare(a.id),
  );
  const score = (hash: MessageHash) => Number(hash.timelineOrderAt ?? hash.timestamp);
  const range = (rows: MessageHash[], args: unknown[]) =>
    args.includes('WITHSCORES') ? rows.flatMap((row) => [row.id, String(score(row))]) : rows.map((row) => row.id);
  let indexReads = 0;
  const mutateAfterSnapshot = (snapshot: string[]) => {
    if (++indexReads === 1 && afterFirstIndexRead) {
      afterFirstIndexRead(descending);
      for (const row of descending) byId.set(row.id, row);
    }
    return snapshot;
  };
  function pipeline() {
    const commands: Array<() => unknown> = [];
    return {
      hgetall(key: string) {
        calls.push({ method: 'hgetall' });
        commands.push(() => byId.get(key.slice(key.lastIndexOf(':') + 1)) ?? {});
        return this;
      },
      hmget(key: string, ...fields: string[]) {
        calls.push({ method: 'hmget', fields });
        commands.push(() => fields.map((field) => byId.get(key.slice(key.lastIndexOf(':') + 1))?.[field] ?? null));
        return this;
      },
      async exec() {
        calls.push({ method: 'exec', size: commands.length });
        if (fault === 'null') return null;
        if (fault === 'missing') return [];
        return commands.map((command) =>
          fault === 'command' ? [new Error('projection unavailable'), null] : [null, command()],
        );
      },
    };
  }
  const redis = {
    options: {},
    pipeline,
    multi: pipeline,
    async zrevrange(_key: string, start: number, end: number, ...args: unknown[]) {
      calls.push({ method: 'zrevrange' });
      return mutateAfterSnapshot(range(descending.slice(start, end + 1), args));
    },
    async zrevrangebyscore(_key: string, max: string, _min: string, ...args: unknown[]) {
      calls.push({ method: 'zrevrangebyscore' });
      const exclusive = max.startsWith('(');
      const ceiling = Number(exclusive ? max.slice(1) : max);
      const rows = descending.filter((hash) => (exclusive ? score(hash) < ceiling : score(hash) <= ceiling));
      const limit = args.indexOf('LIMIT');
      return mutateAfterSnapshot(
        range(
          limit < 0 ? rows : rows.slice(Number(args[limit + 1]), Number(args[limit + 1]) + Number(args[limit + 2])),
          args,
        ),
      );
    },
    async zscore(_key: string, id: string) {
      const hash = byId.get(id);
      return hash ? String(score(hash)) : null;
    },
  };
  return { store: new RedisMessageStore(redis as unknown as RedisClient), calls };
}

export const hash = (id: string, timestamp: number, changes: Record<string, string> = {}) => ({
  id,
  threadId: 'thread-owned',
  userId: 'owner',
  catId: 'sonnet',
  timestamp: String(timestamp),
  content: 'unused message body',
  toolEvents: JSON.stringify([{ detail: 'irrelevant tool payload'.repeat(100) }]),
  contentBlocks: JSON.stringify([{ type: 'text', text: 'unused content' }]),
  metadata: JSON.stringify({ unrelated: 'unused metadata' }),
  extra: JSON.stringify({ stream: { invocationId: `parent-${id}`, turnInvocationId: `turn-${id}` } }),
  ...changes,
});
