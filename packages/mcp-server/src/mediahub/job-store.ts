/**
 * MediaHub — Job Store (Redis-backed)
 * F139: Persists job metadata in Redis. Media files stored on local filesystem.
 */

import type { JobRecord, JobStatus } from './types.js';

const KEY_PREFIX = 'mediahub:job:';
const INDEX_KEY = 'mediahub:jobs:timeline';
const JOB_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** Minimal Redis interface — compatible with ioredis and node-redis */
export interface RedisClient {
  hset(key: string, data: Record<string, string>): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  expire(key: string, seconds: number): Promise<number>;
  zadd(key: string, ...args: Array<string | number>): Promise<number>;
  zrevrangebyscore(key: string, max: string | number, min: string | number, ...args: string[]): Promise<string[]>;
  del(key: string): Promise<number>;
}

function jobToHash(job: JobRecord): Record<string, string> {
  const hash: Record<string, string> = {
    jobId: job.jobId,
    providerId: job.providerId,
    capability: job.capability,
    model: job.model,
    prompt: job.prompt,
    status: job.status,
    createdAt: String(job.createdAt),
    updatedAt: String(job.updatedAt),
  };
  if (job.providerTaskId) hash['providerTaskId'] = job.providerTaskId;
  if (job.outputPath) hash['outputPath'] = job.outputPath;
  if (job.providerResultUrl) hash['providerResultUrl'] = job.providerResultUrl;
  if (job.error) hash['error'] = job.error;
  return hash;
}

function hashToJob(hash: Record<string, string>): JobRecord | null {
  if (!hash['jobId']) return null;
  return {
    jobId: hash['jobId'],
    providerId: hash['providerId'] ?? '',
    providerTaskId: hash['providerTaskId'],
    capability: (hash['capability'] ?? 'text2video') as JobRecord['capability'],
    model: hash['model'] ?? '',
    prompt: hash['prompt'] ?? '',
    status: (hash['status'] ?? 'queued') as JobStatus,
    outputPath: hash['outputPath'],
    providerResultUrl: hash['providerResultUrl'],
    error: hash['error'],
    createdAt: Number(hash['createdAt'] ?? 0),
    updatedAt: Number(hash['updatedAt'] ?? 0),
  };
}

export class JobStore {
  constructor(private readonly redis: RedisClient) {}

  async save(job: JobRecord): Promise<void> {
    const key = KEY_PREFIX + job.jobId;
    await this.redis.hset(key, jobToHash(job));
    await this.redis.expire(key, JOB_TTL_SECONDS);
    await this.redis.zadd(INDEX_KEY, job.createdAt, job.jobId);
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const hash = await this.redis.hgetall(KEY_PREFIX + jobId);
    return hashToJob(hash);
  }

  async updateStatus(
    jobId: string,
    status: JobStatus,
    extra?: Partial<Pick<JobRecord, 'outputPath' | 'providerResultUrl' | 'error' | 'providerTaskId'>>,
  ): Promise<void> {
    const updates: Record<string, string> = {
      status,
      updatedAt: String(Date.now()),
    };
    if (extra?.outputPath) updates['outputPath'] = extra.outputPath;
    if (extra?.providerResultUrl) updates['providerResultUrl'] = extra.providerResultUrl;
    if (extra?.error) updates['error'] = extra.error;
    if (extra?.providerTaskId) updates['providerTaskId'] = extra.providerTaskId;

    await this.redis.hset(KEY_PREFIX + jobId, updates);
  }

  async listRecent(limit = 20): Promise<JobRecord[]> {
    const jobIds = await this.redis.zrevrangebyscore(INDEX_KEY, '+inf', '-inf', 'LIMIT', '0', String(limit));
    const jobs: JobRecord[] = [];
    for (const jobId of jobIds) {
      const job = await this.get(jobId);
      if (job) jobs.push(job);
    }
    return jobs;
  }
}
