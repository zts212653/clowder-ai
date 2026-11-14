import type { DshConnectionCheckFact } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

/** DSH-only observation facts. No TTL and no member-configuration writes. */
export class RedisDshMemberConnectionCheckStore {
  constructor(private readonly redis: RedisClient) {}

  async attempt(scope: string, attemptId: string): Promise<DshConnectionCheckFact | null> {
    const value = await this.redis.get(`dsh-check:${scope}:attempt:${attemptId}`);
    return value ? (JSON.parse(value) as DshConnectionCheckFact) : null;
  }

  async latest(scope: string) {
    const attemptId = await this.redis.get(`dsh-check:${scope}:latest`);
    return attemptId ? this.attempt(scope, attemptId) : null;
  }

  async start(scope: string, fact: DshConnectionCheckFact) {
    const written = await this.redis.set(`dsh-check:${scope}:attempt:${fact.attemptId}`, JSON.stringify(fact), 'NX');
    if (!written) return false;
    // A prompt is allowed only after both writes succeed. A crash before this
    // index cannot leave an unindexed billable request.
    await this.redis.set(`dsh-check:${scope}:latest`, fact.attemptId);
    return true;
  }

  async finish(scope: string, fact: DshConnectionCheckFact) {
    await this.redis.set(`dsh-check:${scope}:attempt:${fact.attemptId}`, JSON.stringify(fact));
    // Do not change latest: an older check may finish after a newer one starts.
  }
}
