import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AntigravitySideEffectJournalSummary } from './AntigravitySideEffectJournal.js';
import { redactAntigravitySideEffectTarget } from './AntigravitySideEffectJournal.js';

export const ANTIGRAVITY_SUPERVISOR_KEY_PREFIX = 'antigravity:supervisor:v1:';

export type AntigravitySupervisorStatus = 'running' | 'probing' | 'resumable' | 'auto_resuming' | 'done' | 'failed';

export type AntigravityLivenessEvidenceKind =
  | 'trajectory_progress'
  | 'trajectory_timestamp_progress'
  | 'step_mutation'
  | 'pending_tool'
  | 'pending_approval'
  | 'native_executor_active'
  | 'rpc_reconnected';

export interface AntigravityLivenessEvidence {
  kind: AntigravityLivenessEvidenceKind;
  observedAt: number;
  summary: string;
}

export type AntigravityNativeExecutorEvidenceStatus =
  | 'started'
  | 'completed'
  | 'approval_pending'
  | 'no_executor'
  | 'not_handled'
  | 'error';

export interface AntigravityNativeExecutorEvidence {
  toolName: string;
  stepType: string;
  stepIndex: number;
  status: AntigravityNativeExecutorEvidenceStatus;
  observedAt: number;
  summary: string;
}

export type AntigravitySupervisorReceiptState = 'clean' | 'native_success_trajectory_error' | 'unknown';

export type AntigravitySupervisorRecoveryStrategy = 'wait' | 'probe' | 'manual_card' | 'auto_resume' | 'stop';

const SUPERVISOR_STATUSES = new Set<AntigravitySupervisorStatus>([
  'running',
  'probing',
  'resumable',
  'auto_resuming',
  'done',
  'failed',
]);

const SUPERVISOR_RECEIPT_STATES = new Set<AntigravitySupervisorReceiptState>([
  'clean',
  'native_success_trajectory_error',
  'unknown',
]);

const SUPERVISOR_RECOVERY_STRATEGIES = new Set<AntigravitySupervisorRecoveryStrategy>([
  'wait',
  'probe',
  'manual_card',
  'auto_resume',
  'stop',
]);

const NATIVE_EXECUTOR_EVIDENCE_STATUSES = new Set<AntigravityNativeExecutorEvidenceStatus>([
  'started',
  'completed',
  'approval_pending',
  'no_executor',
  'not_handled',
  'error',
]);

const SUPERVISOR_REQUIRED_STRING_FIELDS = ['originalInvocationId', 'threadId', 'catId', 'cascadeId'] as const;

const SUPERVISOR_REQUIRED_NUMBER_FIELDS = [
  'lastObservedStepCount',
  'lastDeliveredStepIndex',
  'resumeAttemptCount',
  'createdAt',
  'updatedAt',
] as const;

export interface AntigravitySupervisorRecord {
  schemaVersion: 1;
  originalInvocationId: string;
  threadId: string;
  catId: string;
  cascadeId: string;
  status: AntigravitySupervisorStatus;
  lastObservedStepCount: number;
  lastDeliveredStepIndex: number;
  lastTrajectoryAt?: number;
  lastLivenessEvidence?: AntigravityLivenessEvidence;
  nativeExecutorEvidence?: AntigravityNativeExecutorEvidence;
  /**
   * F201 Phase F Task 1: single side-effect truth source.
   * This is a copied snapshot from AntigravitySideEffectJournal.summary(), not a
   * second journal or a reclassification layer.
   */
  journalSummarySnapshot: AntigravitySideEffectJournalSummary;
  receiptState: AntigravitySupervisorReceiptState;
  recoveryStrategy: AntigravitySupervisorRecoveryStrategy;
  resumeAttemptCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface AntigravitySupervisorLivenessProjection {
  provider: 'antigravity';
  originalInvocationId: string;
  threadId: string;
  catId: string;
  status: AntigravitySupervisorStatus;
  recoveryStrategy: AntigravitySupervisorRecoveryStrategy;
  lastLivenessEvidence?: AntigravityLivenessEvidence;
  updatedAt: number;
}

export interface AntigravitySupervisorAuditEvent {
  type: string;
  at?: number;
  record?: AntigravitySupervisorRecord;
  [key: string]: unknown;
}

export interface AntigravitySupervisorStore {
  upsert(record: AntigravitySupervisorRecord): Promise<AntigravitySupervisorRecord>;
  get(originalInvocationId: string, cascadeId: string): Promise<AntigravitySupervisorRecord | null>;
  appendAudit(event: AntigravitySupervisorAuditEvent): Promise<void>;
  projectToInvocationLiveness(record: AntigravitySupervisorRecord): AntigravitySupervisorLivenessProjection;
}

interface AntigravitySupervisorAuditOptions {
  auditDir?: string;
  now?: () => number;
}

export interface AntigravitySupervisorRedisLike {
  set(key: string, value: string): Promise<unknown> | unknown;
  get(key: string): Promise<string | null | undefined> | string | null | undefined;
}

function dateKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function supervisorKey(originalInvocationId: string, cascadeId: string): string {
  return `${ANTIGRAVITY_SUPERVISOR_KEY_PREFIX}${originalInvocationId}:${cascadeId}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneRecord(record: AntigravitySupervisorRecord): AntigravitySupervisorRecord {
  return cloneJson(record);
}

function sanitizeAuditValue(value: unknown, keyHint?: string): unknown {
  if (typeof value === 'string') {
    return keyHint === 'target' ? redactAntigravitySideEffectTarget(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAuditValue(item, keyHint));
  }
  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      sanitized[key] = sanitizeAuditValue(child, key);
    }
    return sanitized;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === 'string' && record[key].length > 0;
}

function hasNumber(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === 'number' && Number.isFinite(record[key]);
}

function isValidLivenessEvidence(value: unknown): value is AntigravityLivenessEvidence {
  if (!isPlainObject(value)) return false;
  return hasString(value, 'kind') && hasNumber(value, 'observedAt') && hasString(value, 'summary');
}

function isValidNativeExecutorEvidence(value: unknown): value is AntigravityNativeExecutorEvidence {
  if (!isPlainObject(value)) return false;
  return (
    hasString(value, 'toolName') &&
    hasString(value, 'stepType') &&
    hasNumber(value, 'stepIndex') &&
    hasString(value, 'status') &&
    NATIVE_EXECUTOR_EVIDENCE_STATUSES.has(value.status as AntigravityNativeExecutorEvidenceStatus) &&
    hasNumber(value, 'observedAt') &&
    hasString(value, 'summary')
  );
}

function isValidJournalSummarySnapshot(value: unknown): value is AntigravitySideEffectJournalSummary {
  return isPlainObject(value) && Array.isArray(value.entries);
}

function hasOptionalNumber(record: Record<string, unknown>, key: string): boolean {
  if (record[key] === undefined) return true;
  return hasNumber(record, key);
}

function hasOptionalLivenessEvidence(record: Record<string, unknown>): boolean {
  const evidence = record.lastLivenessEvidence;
  if (evidence === undefined) return true;
  return isValidLivenessEvidence(evidence);
}

function hasOptionalNativeExecutorEvidence(record: Record<string, unknown>): boolean {
  const evidence = record.nativeExecutorEvidence;
  if (evidence === undefined) return true;
  return isValidNativeExecutorEvidence(evidence);
}

function isValidSupervisorRecord(value: unknown): value is AntigravitySupervisorRecord {
  if (!isPlainObject(value)) return false;
  if (value.schemaVersion !== 1) return false;
  return (
    SUPERVISOR_REQUIRED_STRING_FIELDS.every((field) => hasString(value, field)) &&
    SUPERVISOR_REQUIRED_NUMBER_FIELDS.every((field) => hasNumber(value, field)) &&
    SUPERVISOR_STATUSES.has(value.status as AntigravitySupervisorStatus) &&
    SUPERVISOR_RECEIPT_STATES.has(value.receiptState as AntigravitySupervisorReceiptState) &&
    SUPERVISOR_RECOVERY_STRATEGIES.has(value.recoveryStrategy as AntigravitySupervisorRecoveryStrategy) &&
    hasOptionalNumber(value, 'lastTrajectoryAt') &&
    hasOptionalLivenessEvidence(value) &&
    hasOptionalNativeExecutorEvidence(value) &&
    isValidJournalSummarySnapshot(value.journalSummarySnapshot)
  );
}

function parseRecord(raw: string | null | undefined): AntigravitySupervisorRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isValidSupervisorRecord(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function projectAntigravitySupervisorToInvocationLiveness(
  record: AntigravitySupervisorRecord,
): AntigravitySupervisorLivenessProjection {
  return {
    provider: 'antigravity',
    originalInvocationId: record.originalInvocationId,
    threadId: record.threadId,
    catId: record.catId,
    status: record.status,
    recoveryStrategy: record.recoveryStrategy,
    ...(record.lastLivenessEvidence ? { lastLivenessEvidence: cloneJson(record.lastLivenessEvidence) } : {}),
    updatedAt: record.updatedAt,
  };
}

abstract class AntigravitySupervisorStoreBase
  implements Pick<AntigravitySupervisorStore, 'appendAudit' | 'projectToInvocationLiveness'>
{
  private readonly auditDir: string | undefined;
  private readonly now: () => number;

  constructor(options?: AntigravitySupervisorAuditOptions) {
    this.auditDir = options?.auditDir;
    this.now = options?.now ? options.now : Date.now;
  }

  async appendAudit(event: AntigravitySupervisorAuditEvent): Promise<void> {
    if (!this.auditDir) return;
    await mkdir(this.auditDir, { recursive: true });
    const at = typeof event.at === 'number' ? event.at : this.now();
    const file = join(this.auditDir, `supervisor-${dateKey(at)}.jsonl`);
    const sanitized = sanitizeAuditValue({ ...event, at });
    await appendFile(file, `${JSON.stringify(sanitized)}\n`, 'utf-8');
  }

  projectToInvocationLiveness(record: AntigravitySupervisorRecord): AntigravitySupervisorLivenessProjection {
    return projectAntigravitySupervisorToInvocationLiveness(record);
  }
}

export class InMemoryAntigravitySupervisorStore
  extends AntigravitySupervisorStoreBase
  implements AntigravitySupervisorStore
{
  private readonly records = new Map<string, AntigravitySupervisorRecord>();

  async upsert(record: AntigravitySupervisorRecord): Promise<AntigravitySupervisorRecord> {
    const stored = cloneRecord(record);
    this.records.set(supervisorKey(record.originalInvocationId, record.cascadeId), stored);
    return cloneRecord(stored);
  }

  async get(originalInvocationId: string, cascadeId: string): Promise<AntigravitySupervisorRecord | null> {
    const record = this.records.get(supervisorKey(originalInvocationId, cascadeId));
    return record ? cloneRecord(record) : null;
  }
}

export class RedisAntigravitySupervisorStore
  extends AntigravitySupervisorStoreBase
  implements AntigravitySupervisorStore
{
  private readonly redis: AntigravitySupervisorRedisLike;

  constructor(redis: AntigravitySupervisorRedisLike, options?: AntigravitySupervisorAuditOptions) {
    super(options);
    this.redis = redis;
  }

  async upsert(record: AntigravitySupervisorRecord): Promise<AntigravitySupervisorRecord> {
    const stored = cloneRecord(record);
    await this.redis.set(supervisorKey(record.originalInvocationId, record.cascadeId), JSON.stringify(stored));
    return cloneRecord(stored);
  }

  async get(originalInvocationId: string, cascadeId: string): Promise<AntigravitySupervisorRecord | null> {
    const raw = await this.redis.get(supervisorKey(originalInvocationId, cascadeId));
    const record = parseRecord(raw);
    return record ? cloneRecord(record) : null;
  }
}
