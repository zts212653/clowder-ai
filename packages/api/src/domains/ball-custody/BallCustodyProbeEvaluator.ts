import type { TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { validateUrl } from '../../infrastructure/scheduler/content-fetcher.js';
import type { BallCustodyProbeEvaluator, BallCustodyProbeResult } from './BallCustodyProbeScheduler.js';

export interface DefaultBallCustodyProbeEvaluatorOptions {
  readonly redis?: Pick<RedisClient, 'exists'> | null;
  readonly fetch?: typeof fetch;
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return undefined;
  return AbortSignal.timeout(timeoutMs);
}

export class DefaultBallCustodyProbeEvaluator implements BallCustodyProbeEvaluator {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: DefaultBallCustodyProbeEvaluatorOptions = {}) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  async evaluate(input: { task: TaskItem }): Promise<BallCustodyProbeResult> {
    const probe = input.task.probe;
    if (!probe) return { satisfied: false, reason: 'missing_probe' };

    if (probe.kind === 'redis_exists') {
      if (!this.opts.redis) return { satisfied: false, reason: 'redis_unavailable' };
      const count = await this.opts.redis.exists(probe.key);
      return { satisfied: count > 0, reason: count > 0 ? 'redis_key_exists' : 'redis_key_missing' };
    }

    const expectedStatus = probe.expectStatus ?? 200;
    const timeoutMs = probe.timeoutMs ?? 5_000;
    validateUrl(probe.url);
    const response = await this.fetchFn(probe.url, { method: 'GET', signal: timeoutSignal(timeoutMs) });
    return {
      satisfied: response.status === expectedStatus,
      reason: `http_status_${response.status}`,
    };
  }
}
