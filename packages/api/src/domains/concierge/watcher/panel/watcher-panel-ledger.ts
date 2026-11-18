import { type WatcherPanelRound, watcherPanelRoundSchema } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

/** Durable experiment ledger (TTL=0). Rounds are append-mostly; members are updated as they finish. */
export interface WatcherPanelLedger {
  get(roundId: string): Promise<WatcherPanelRound | null>;
  save(round: WatcherPanelRound): Promise<void>;
  /** Newest first. */
  list(query: {
    userId: string;
    threadId?: string;
    since?: number;
    until?: number;
    limit: number;
  }): Promise<WatcherPanelRound[]>;
}

export const WatcherPanelKeys = {
  round: (roundId: string) => `watcher-panel:round:${roundId}`,
  byUser: (userId: string) => `watcher-panel:rounds:${userId}`,
  byThread: (threadId: string) => `watcher-panel:thread-rounds:${threadId}`,
} as const;

/** One round per settled source turn; replaying the same source never opens a second round. */
export function watcherPanelRoundId(sourceInvocationId: string): string {
  return `wpr:${sourceInvocationId}`;
}

function parse(raw: string | null): WatcherPanelRound | null {
  if (!raw) return null;
  const parsed = watcherPanelRoundSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('watcher_panel_round_corrupt');
  return parsed.data;
}

export class RedisWatcherPanelLedger implements WatcherPanelLedger {
  constructor(private readonly redis: RedisClient) {}

  async get(roundId: string): Promise<WatcherPanelRound | null> {
    return parse(await this.redis.get(WatcherPanelKeys.round(roundId)));
  }

  async save(round: WatcherPanelRound): Promise<void> {
    const value = watcherPanelRoundSchema.parse(round);
    await this.redis
      .multi()
      .set(WatcherPanelKeys.round(value.roundId), JSON.stringify(value))
      .zadd(WatcherPanelKeys.byUser(value.userId), value.createdAt, value.roundId)
      .zadd(WatcherPanelKeys.byThread(value.threadId), value.createdAt, value.roundId)
      .exec();
  }

  async list(query: {
    userId: string;
    threadId?: string;
    since?: number;
    until?: number;
    limit: number;
  }): Promise<WatcherPanelRound[]> {
    const key = query.threadId ? WatcherPanelKeys.byThread(query.threadId) : WatcherPanelKeys.byUser(query.userId);
    const ids = await this.redis.zrevrangebyscore(
      key,
      query.until ?? '+inf',
      query.since ?? '-inf',
      'LIMIT',
      0,
      Math.max(1, Math.min(query.limit, 500)),
    );
    if (ids.length === 0) return [];
    const rows = await this.redis.mget(ids.map((id) => WatcherPanelKeys.round(id)));
    return rows
      .map((raw) => parse(raw))
      .filter((round): round is WatcherPanelRound => round !== null && round.userId === query.userId);
  }
}

export class InMemoryWatcherPanelLedger implements WatcherPanelLedger {
  private readonly rounds = new Map<string, WatcherPanelRound>();

  async get(roundId: string): Promise<WatcherPanelRound | null> {
    const round = this.rounds.get(roundId);
    return round ? structuredClone(round) : null;
  }

  async save(round: WatcherPanelRound): Promise<void> {
    this.rounds.set(round.roundId, structuredClone(watcherPanelRoundSchema.parse(round)));
  }

  async list(query: {
    userId: string;
    threadId?: string;
    since?: number;
    until?: number;
    limit: number;
  }): Promise<WatcherPanelRound[]> {
    return [...this.rounds.values()]
      .filter(
        (round) =>
          round.userId === query.userId &&
          (!query.threadId || round.threadId === query.threadId) &&
          round.createdAt >= (query.since ?? 0) &&
          round.createdAt <= (query.until ?? Number.MAX_SAFE_INTEGER),
      )
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, query.limit)
      .map((round) => structuredClone(round));
  }
}
