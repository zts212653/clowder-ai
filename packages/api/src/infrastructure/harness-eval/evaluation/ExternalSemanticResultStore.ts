import type { MetricResult } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const RESULT_PREFIX = 'harness-unit-semantic-result:';

const resultKey = (snapshotId: string, metricId: string) => `${RESULT_PREFIX}${snapshotId}:${metricId}`;

/**
 * Durable staging area for semantic MetricResults produced by the asynchronous
 * eval cat. The final Unit commit copies these immutable results into the
 * canonical MetricResult index atomically with the ObjectiveJudgment.
 */
export class ExternalSemanticResultStore {
  constructor(private readonly redis: RedisClient) {}

  async append(result: MetricResult): Promise<{ outcome: 'created' | 'duplicate' }> {
    if (result.kind !== 'semantic' || result.value.kind !== 'semantic') {
      throw new Error(`external_semantic_result_kind_mismatch:${result.metricId}`);
    }
    const key = resultKey(result.snapshotId, result.metricId);
    const serialized = JSON.stringify(result);
    const created = await this.redis.set(key, serialized, 'NX');
    if (created !== 'OK') {
      const existing = await this.redis.get(key);
      if (existing !== serialized) {
        throw new Error(`external_semantic_result_conflict:${result.snapshotId}:${result.metricId}`);
      }
    }
    return { outcome: created === 'OK' ? 'created' : 'duplicate' };
  }

  async get(snapshotId: string, metricId: string): Promise<MetricResult | null> {
    const raw = await this.redis.get(resultKey(snapshotId, metricId));
    if (!raw) return null;
    try {
      const result = JSON.parse(raw) as MetricResult;
      return result.kind === 'semantic' && result.value.kind === 'semantic' ? result : null;
    } catch {
      return null;
    }
  }
}
