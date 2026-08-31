import type { MetricResult } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const RESULT_PREFIX = 'harness-metric-result:';
const RESULT_INDEX_PREFIX = 'harness-metric-result-index:';

const resultKey = (resultId: string) => `${RESULT_PREFIX}${resultId}`;
const resultIndexKey = (result: MetricResult) =>
  `${RESULT_INDEX_PREFIX}${result.ownerUserId}:${result.objectiveId}:${result.metricId}`;
const metricIndexKey = (ownerUserId: string, objectiveId: string, metricId: string) =>
  `${RESULT_INDEX_PREFIX}${ownerUserId}:${objectiveId}:${metricId}`;

export class MetricResultStore {
  constructor(private readonly redis: RedisClient) {}

  async append(result: MetricResult): Promise<{ outcome: 'created' | 'duplicate' }> {
    const serialized = JSON.stringify(result);
    const created = await this.redis.set(resultKey(result.resultId), serialized, 'NX');
    if (created !== 'OK') {
      const existing = await this.redis.get(resultKey(result.resultId));
      if (existing !== serialized) throw new Error(`metric_result_conflict:${result.resultId}`);
    }
    await this.redis.zadd(resultIndexKey(result), result.evaluatedAt, result.resultId);
    return { outcome: created === 'OK' ? 'created' : 'duplicate' };
  }

  async get(resultId: string): Promise<MetricResult | null> {
    const raw = await this.redis.get(resultKey(resultId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as MetricResult;
    } catch {
      return null;
    }
  }

  async queryMetricWindow(
    ownerUserId: string,
    objectiveId: string,
    metricId: string,
    startMs: number,
    endMs: number,
  ): Promise<MetricResult[]> {
    // Half-open [start, end): a result at exactly endMs belongs to the next window.
    const ids = await this.redis.zrangebyscore(
      metricIndexKey(ownerUserId, objectiveId, metricId),
      String(startMs),
      `(${endMs}`,
    );
    const results: MetricResult[] = [];
    for (const id of ids) {
      const result = await this.get(id);
      if (result) results.push(result);
    }
    return results;
  }
}
