import type { TraceEpisodeRef } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { SemanticSweepRunResult } from './SemanticSweepService.js';

const JOB_PREFIX = 'harness-semantic-sweep-job:';
const COMPLETION_PREFIX = 'harness-semantic-sweep-completion:';

export interface SemanticSweepJob {
  jobId: string;
  ownerUserId: string;
  evaluatorCatId: string;
  window: { start: number; end: number };
  episodeRefs: TraceEpisodeRef[];
  createdAt: number;
}

export interface SemanticSweepCompletion {
  submissionDigest: string;
  result: SemanticSweepRunResult;
  completedAt: number;
}

export class SemanticSweepJobStore {
  constructor(private readonly redis: RedisClient) {}

  async append(job: SemanticSweepJob): Promise<{ outcome: 'created' | 'duplicate' }> {
    const key = `${JOB_PREFIX}${job.jobId}`;
    const serialized = JSON.stringify(job);
    const created = await this.redis.set(key, serialized, 'NX');
    if (created !== 'OK') {
      const existing = await this.redis.get(key);
      if (existing !== serialized) throw new Error(`semantic_sweep_job_conflict:${job.jobId}`);
    }
    return { outcome: created === 'OK' ? 'created' : 'duplicate' };
  }

  async get(jobId: string): Promise<SemanticSweepJob | null> {
    const raw = await this.redis.get(`${JOB_PREFIX}${jobId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SemanticSweepJob;
    } catch {
      return null;
    }
  }

  async getCompletion(jobId: string): Promise<SemanticSweepCompletion | null> {
    const raw = await this.redis.get(`${COMPLETION_PREFIX}${jobId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SemanticSweepCompletion;
    } catch {
      return null;
    }
  }

  async complete(jobId: string, completion: SemanticSweepCompletion): Promise<'created' | 'duplicate'> {
    const key = `${COMPLETION_PREFIX}${jobId}`;
    const serialized = JSON.stringify(completion);
    const created = await this.redis.set(key, serialized, 'NX');
    if (created !== 'OK') {
      const existing = await this.redis.get(key);
      if (!existing) throw new Error(`semantic_sweep_completion_conflict:${jobId}`);
      const parsed = JSON.parse(existing) as SemanticSweepCompletion;
      if (
        parsed.submissionDigest !== completion.submissionDigest ||
        JSON.stringify(parsed.result) !== JSON.stringify(completion.result)
      ) {
        throw new Error(`semantic_sweep_completion_conflict:${jobId}`);
      }
    }
    return created === 'OK' ? 'created' : 'duplicate';
  }
}
