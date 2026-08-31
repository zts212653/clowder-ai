import type { ObjectiveJudgment } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const JUDGMENT_PREFIX = 'harness-objective-judgment:';
const JUDGMENT_INDEX_PREFIX = 'harness-objective-judgment-index:';

const judgmentKey = (judgmentId: string) => `${JUDGMENT_PREFIX}${judgmentId}`;
const judgmentIndexKey = (ownerUserId: string, objectiveId: string) =>
  `${JUDGMENT_INDEX_PREFIX}${ownerUserId}:${objectiveId}`;

export class ObjectiveJudgmentStore {
  constructor(private readonly redis: RedisClient) {}

  async append(judgment: ObjectiveJudgment): Promise<{ outcome: 'created' | 'duplicate' }> {
    const serialized = JSON.stringify(judgment);
    const created = await this.redis.set(judgmentKey(judgment.judgmentId), serialized, 'NX');
    if (created !== 'OK') {
      const existing = await this.redis.get(judgmentKey(judgment.judgmentId));
      if (existing !== serialized) throw new Error(`objective_judgment_conflict:${judgment.judgmentId}`);
    }
    await this.redis.zadd(
      judgmentIndexKey(judgment.ownerUserId, judgment.objectiveId),
      judgment.evaluatedAt,
      judgment.judgmentId,
    );
    return { outcome: created === 'OK' ? 'created' : 'duplicate' };
  }

  async get(judgmentId: string): Promise<ObjectiveJudgment | null> {
    const raw = await this.redis.get(judgmentKey(judgmentId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ObjectiveJudgment;
    } catch {
      return null;
    }
  }

  async latest(ownerUserId: string, objectiveId: string): Promise<ObjectiveJudgment | null> {
    const ids = await this.redis.zrevrange(judgmentIndexKey(ownerUserId, objectiveId), 0, 0);
    return ids[0] ? this.get(ids[0]) : null;
  }

  async queryWindow(
    ownerUserId: string,
    objectiveId: string,
    startMs: number,
    endMs: number,
  ): Promise<ObjectiveJudgment[]> {
    const ids = await this.redis.zrangebyscore(
      judgmentIndexKey(ownerUserId, objectiveId),
      String(startMs),
      `(${endMs}`,
    );
    const judgments: ObjectiveJudgment[] = [];
    for (const id of ids) {
      const judgment = await this.get(id);
      if (judgment) judgments.push(judgment);
    }
    return judgments;
  }
}
