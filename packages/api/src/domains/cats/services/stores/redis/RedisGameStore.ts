/**
 * Redis Game Store (F101)
 *
 * Persists game state to Redis. Enforces single active game per thread (KD-15).
 * Uses optimistic concurrency via version field.
 */

import type { GameRuntime } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IGameStore } from '../ports/GameStore.js';
import { GameKeys } from '../redis-keys/game-keys.js';

export class RedisGameStore implements IGameStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async createGame(runtime: GameRuntime): Promise<GameRuntime> {
    // KD-15: check no active game on this thread
    const existingGameId = await this.redis.get(GameKeys.threadActive(runtime.threadId));
    if (existingGameId) {
      throw new Error(`Thread ${runtime.threadId} already has an active game: ${existingGameId}`);
    }

    const pipeline = this.redis.multi();
    pipeline.set(GameKeys.detail(runtime.gameId), JSON.stringify(runtime));
    pipeline.set(GameKeys.threadActive(runtime.threadId), runtime.gameId);
    await pipeline.exec();

    return runtime;
  }

  async getGame(gameId: string): Promise<GameRuntime | null> {
    const data = await this.redis.get(GameKeys.detail(gameId));
    if (!data) return null;
    return JSON.parse(data) as GameRuntime;
  }

  async getActiveGame(threadId: string): Promise<GameRuntime | null> {
    const gameId = await this.redis.get(GameKeys.threadActive(threadId));
    if (!gameId) return null;
    return this.getGame(gameId);
  }

  async updateGame(gameId: string, runtime: GameRuntime): Promise<void> {
    const existing = await this.redis.get(GameKeys.detail(gameId));
    if (!existing) throw new Error(`Game ${gameId} not found`);

    const current = JSON.parse(existing) as GameRuntime;
    // OCC: reject if Redis version moved forward since we read (concurrent write).
    // A single handlePlayerAction/tick may increment version multiple times
    // (appendEvent × N + submitAction), so we check >= not ===+1.
    if (runtime.version <= current.version) {
      throw new Error(
        `Version conflict for game ${gameId}: runtime version ${runtime.version} must be greater than stored version ${current.version}`,
      );
    }

    await this.redis.set(GameKeys.detail(gameId), JSON.stringify(runtime));
  }

  async listActiveGames(): Promise<GameRuntime[]> {
    // IMPORTANT: ioredis keyPrefix does NOT auto-apply to keys()/scan().
    // Must manually prepend prefix for pattern matching, then strip it for get().
    const prefix = (this.redis.options as { keyPrefix?: string }).keyPrefix ?? '';
    const games: GameRuntime[] = [];
    const seen = new Set<string>();
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', `${prefix}game:thread:*:active`, 'COUNT', 100);
      cursor = nextCursor;
      // SCAN can repeat keys and return an empty nonterminal page. COUNT is a
      // hint, so bound MGET batches independently of the returned page size.
      for (let offset = 0; offset < keys.length; offset += 100) {
        const bareKeys = keys.slice(offset, offset + 100).map((key) => key.slice(prefix.length));
        const gameIds = (await this.redis.mget(...bareKeys)).filter((id): id is string => id !== null && !seen.has(id));
        const uniqueIds = [...new Set(gameIds)];
        if (uniqueIds.length === 0) continue;
        for (const id of uniqueIds) seen.add(id);
        const details = await this.redis.mget(...uniqueIds.map(GameKeys.detail));
        for (const detail of details) if (detail) games.push(JSON.parse(detail) as GameRuntime);
      }
    } while (cursor !== '0');
    return games;
  }

  async endGame(gameId: string, winner: string): Promise<void> {
    const existing = await this.redis.get(GameKeys.detail(gameId));
    if (!existing) throw new Error(`Game ${gameId} not found`);

    const runtime = JSON.parse(existing) as GameRuntime;
    runtime.status = 'finished';
    runtime.winner = winner;
    runtime.version++;
    runtime.updatedAt = Date.now();

    const pipeline = this.redis.multi();
    pipeline.set(GameKeys.detail(gameId), JSON.stringify(runtime));
    // Remove from active, add to history
    pipeline.del(GameKeys.threadActive(runtime.threadId));
    pipeline.zadd(GameKeys.threadHistory(runtime.threadId), runtime.updatedAt, gameId);
    await pipeline.exec();
  }
}
