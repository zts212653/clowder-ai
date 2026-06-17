/**
 * ConciergeInvestigationJobStore (F229 Phase B2)
 *
 * InvestigationJob 持久化。TTL=0（铁律 5 LL-048）。
 * 三件模式：port interface + Redis 实现 + Memory 实现（测试用）。
 *
 * 状态机：queued → running → done | failed | cancelled
 *         queued → cancelled
 *
 * INV I1: queued/running → cancelled（fail-closed on deadline）
 * INV I2: running → done 必须有 report
 * INV I3: 60s deadline 到期自动 cancel（不能 stuck running）
 */

import type { InvestigationJob, InvestigationJobStatus, InvestigationReport } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { ConciergeKeys } from './concierge-keys.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: ReadonlySet<InvestigationJobStatus> = new Set(['done', 'failed', 'cancelled']);

/**
 * Check if a job has exceeded its deadline and should be cancelled.
 * Only returns true for non-terminal statuses (queued/running).
 */
export function isJobExpired(job: InvestigationJob, now: number = Date.now()): boolean {
  if (TERMINAL_STATUSES.has(job.status)) return false;
  return now >= job.deadline;
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface IConciergeInvestigationJobStore {
  /** Create a new investigation job (status = 'queued') */
  create(job: InvestigationJob): Promise<void>;
  /** Get job by ID */
  get(jobId: string): Promise<InvestigationJob | null>;
  /** Get job by triagePlanId (1:1 relationship) */
  getByTriagePlan(triagePlanId: string): Promise<InvestigationJob | null>;
  /** Update job status (state transition) — sets timestamps */
  updateStatus(jobId: string, status: InvestigationJobStatus): Promise<void>;
  /**
   * Atomic compare-and-swap status transition.
   * Returns true if the job existed AND its current status matched `expectedStatus`,
   * in which case it is atomically updated to `newStatus`.
   */
  claimTransition(
    jobId: string,
    expectedStatus: InvestigationJobStatus,
    newStatus: InvestigationJobStatus,
  ): Promise<boolean>;
  /** Set investigation report on job */
  setReport(jobId: string, report: InvestigationReport): Promise<void>;
  /**
   * Atomic CAS: running → done WITH report in a single write.
   * Enforces INV I2 (done ⇒ report): status never reaches 'done'
   * unless the report is persisted in the same atomic operation.
   * Returns true if the job existed AND was 'running', in which case
   * both status='done' and report are written atomically.
   */
  claimDoneWithReport(jobId: string, report: InvestigationReport): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

/**
 * Lua CAS script for atomic status transition.
 * Returns 1 on success (status matched & updated), 0 on failure (missing or mismatch).
 */
const CLAIM_TRANSITION_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local job = cjson.decode(raw)
if job.status ~= ARGV[1] then return 0 end
job.status = ARGV[2]
job.updatedAt = tonumber(ARGV[3])
if ARGV[2] == 'running' then job.startedAt = job.updatedAt end
if ARGV[2] == 'done' or ARGV[2] == 'failed' or ARGV[2] == 'cancelled' then
  job.completedAt = job.updatedAt
end
redis.call('SET', KEYS[1], cjson.encode(job))
return 1
`;

/**
 * Lua CAS script for atomic running → done + report write (INV I2).
 * Returns 1 on success, 0 if missing or not 'running'.
 */
const CLAIM_DONE_WITH_REPORT_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local job = cjson.decode(raw)
if job.status ~= 'running' then return 0 end
job.status = 'done'
job.report = cjson.decode(ARGV[1])
job.updatedAt = tonumber(ARGV[2])
job.completedAt = job.updatedAt
redis.call('SET', KEYS[1], cjson.encode(job))
return 1
`;

export class RedisConciergeInvestigationJobStore implements IConciergeInvestigationJobStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async create(job: InvestigationJob): Promise<void> {
    // TTL=0 = persistent (铁律 5 LL-048)
    await this.redis.set(ConciergeKeys.investigationJob(job.id), JSON.stringify(job));
    // Index by triagePlanId for lookup
    await this.redis.set(ConciergeKeys.investigationJobByPlan(job.triagePlanId), job.id);
    // Index by userId for listing
    await this.redis.sadd(ConciergeKeys.investigationJobIndex(job.userId), job.id);
  }

  async get(jobId: string): Promise<InvestigationJob | null> {
    const raw = await this.redis.get(ConciergeKeys.investigationJob(jobId));
    return raw ? (JSON.parse(raw) as InvestigationJob) : null;
  }

  async getByTriagePlan(triagePlanId: string): Promise<InvestigationJob | null> {
    const jobId = await this.redis.get(ConciergeKeys.investigationJobByPlan(triagePlanId));
    if (!jobId) return null;
    return this.get(jobId);
  }

  async updateStatus(jobId: string, status: InvestigationJobStatus): Promise<void> {
    const raw = await this.redis.get(ConciergeKeys.investigationJob(jobId));
    if (!raw) return;
    const job = JSON.parse(raw) as InvestigationJob;
    job.status = status;
    job.updatedAt = Date.now();
    if (status === 'running') job.startedAt = job.updatedAt;
    if (status === 'done' || status === 'failed' || status === 'cancelled') {
      job.completedAt = job.updatedAt;
    }
    await this.redis.set(ConciergeKeys.investigationJob(jobId), JSON.stringify(job));
  }

  async claimTransition(
    jobId: string,
    expectedStatus: InvestigationJobStatus,
    newStatus: InvestigationJobStatus,
  ): Promise<boolean> {
    const key = ConciergeKeys.investigationJob(jobId);
    const result = await this.redis.eval(
      CLAIM_TRANSITION_LUA,
      1,
      key,
      expectedStatus,
      newStatus,
      Date.now().toString(),
    );
    return result === 1;
  }

  async setReport(jobId: string, report: InvestigationReport): Promise<void> {
    const raw = await this.redis.get(ConciergeKeys.investigationJob(jobId));
    if (!raw) return;
    const job = JSON.parse(raw) as InvestigationJob;
    job.report = report;
    job.updatedAt = Date.now();
    await this.redis.set(ConciergeKeys.investigationJob(jobId), JSON.stringify(job));
  }

  async claimDoneWithReport(jobId: string, report: InvestigationReport): Promise<boolean> {
    const key = ConciergeKeys.investigationJob(jobId);
    const result = await this.redis.eval(
      CLAIM_DONE_WITH_REPORT_LUA,
      1,
      key,
      JSON.stringify(report),
      Date.now().toString(),
    );
    return result === 1;
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation（仅用于单元测试 / stub）
// ---------------------------------------------------------------------------

export class MemoryConciergeInvestigationJobStore implements IConciergeInvestigationJobStore {
  private readonly store = new Map<string, InvestigationJob>();
  private readonly planIndex = new Map<string, string>(); // triagePlanId → jobId

  async create(job: InvestigationJob): Promise<void> {
    this.store.set(job.id, structuredClone(job));
    this.planIndex.set(job.triagePlanId, job.id);
  }

  async get(jobId: string): Promise<InvestigationJob | null> {
    const entry = this.store.get(jobId);
    return entry ? structuredClone(entry) : null;
  }

  async getByTriagePlan(triagePlanId: string): Promise<InvestigationJob | null> {
    const jobId = this.planIndex.get(triagePlanId);
    if (!jobId) return null;
    return this.get(jobId);
  }

  async updateStatus(jobId: string, status: InvestigationJobStatus): Promise<void> {
    const entry = this.store.get(jobId);
    if (!entry) return;
    entry.status = status;
    entry.updatedAt = Date.now();
    if (status === 'running') entry.startedAt = entry.updatedAt;
    if (status === 'done' || status === 'failed' || status === 'cancelled') {
      entry.completedAt = entry.updatedAt;
    }
    this.store.set(jobId, structuredClone(entry));
  }

  async claimTransition(
    jobId: string,
    expectedStatus: InvestigationJobStatus,
    newStatus: InvestigationJobStatus,
  ): Promise<boolean> {
    const entry = this.store.get(jobId);
    if (!entry || entry.status !== expectedStatus) return false;
    entry.status = newStatus;
    entry.updatedAt = Date.now();
    if (newStatus === 'running') entry.startedAt = entry.updatedAt;
    if (newStatus === 'done' || newStatus === 'failed' || newStatus === 'cancelled') {
      entry.completedAt = entry.updatedAt;
    }
    this.store.set(jobId, structuredClone(entry));
    return true;
  }

  async setReport(jobId: string, report: InvestigationReport): Promise<void> {
    const entry = this.store.get(jobId);
    if (!entry) return;
    entry.report = structuredClone(report);
    entry.updatedAt = Date.now();
    this.store.set(jobId, structuredClone(entry));
  }

  async claimDoneWithReport(jobId: string, report: InvestigationReport): Promise<boolean> {
    const entry = this.store.get(jobId);
    if (!entry || entry.status !== 'running') return false;
    entry.status = 'done';
    entry.report = structuredClone(report);
    entry.updatedAt = Date.now();
    entry.completedAt = entry.updatedAt;
    this.store.set(jobId, structuredClone(entry));
    return true;
  }
}
