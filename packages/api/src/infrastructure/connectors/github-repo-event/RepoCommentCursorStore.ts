/**
 * F168 Phase C — C0.3 RepoCommentCursorStore
 *
 * Per-repo collection cursor for the repo-level comment poller (RepoCommentPollTaskSpec).
 * Stores the max comment `updatedAt` (ISO-8601 UTC) observed per repo, used as the
 * `since` lower bound on the next poll.
 *
 * Persisted WITHOUT TTL: an expiring cursor would reset the `since` bound and force
 * the poller to re-scan + re-dedup the full comment history every interval (polling
 * churn). Monotonic advance is the caller's (poller's) responsibility — this store
 * only persists the latest written value.
 *
 * Mirrors the ReconciliationDedup pattern (bare keys; ioredis keyPrefix applied by
 * the client factory).
 */
import { CommunityKeys } from '../../../domains/community/community-keys.js';

export interface RepoCommentCursorRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

export class RedisRepoCommentCursorStore {
  constructor(private readonly redis: RepoCommentCursorRedisLike) {}

  /** Read the per-repo cursor, or undefined on first poll (no cursor stored yet). */
  async read(repo: string): Promise<string | undefined> {
    const value = await this.redis.get(CommunityKeys.repoCommentCursor(repo));
    return value ?? undefined;
  }

  /** Persist the per-repo cursor (no TTL — see file header on churn). */
  async write(repo: string, cursor: string): Promise<void> {
    await this.redis.set(CommunityKeys.repoCommentCursor(repo), cursor);
  }
}
