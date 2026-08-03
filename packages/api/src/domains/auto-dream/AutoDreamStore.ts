import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { type AutoDreamAuditEventRecord, listAuditEvents as listAuditEventsOperation } from './audit-operations.js';
import {
  createCatLifePreview as createCatLifePreviewOperation,
  decideCatLifePreview as decideCatLifePreviewOperation,
  getCatLifeConfig as getCatLifeConfigOperation,
  getCatLifePreview as getCatLifePreviewOperation,
  listCatLifeConfigs as listCatLifeConfigsOperation,
  markCatLifeProjection as markCatLifeProjectionOperation,
} from './cat-life-operations.js';
import {
  archiveDiary as archiveDiaryOperation,
  getDiary as getDiaryOperation,
  getMetrics as getMetricsOperation,
  listDiaries as listDiariesOperation,
  listDiaryCitations as listDiaryCitationsOperation,
} from './diary-operations.js';
import {
  getDiaryEngagementMetrics as getDiaryEngagementMetricsOperation,
  getDiaryEngagement as getDiaryEngagementOperation,
  recordDiaryEngagement as recordDiaryEngagementOperation,
} from './engagement-operations.js';
import { expireAwakenedRuns as expireAwakenedRunsOperation } from './lease-operations.js';
import { ProactiveRelationshipStore } from './ProactiveRelationshipStore.js';
import {
  getSleepPosture as getSleepPostureOperation,
  listPendingPostures as listPendingPosturesOperation,
} from './posture-operations.js';
import type {
  F255PendingCueInput,
  F255PendingCueReceipt,
  F255PendingCueSink,
  OwnedSeedListOptions,
  OwnedSeedRecord,
  PrivateCueListOptions,
  PrivateCueRecord,
  PrivateSeedDecisionInput,
  PrivateSeedDecisionResult,
} from './private-seed-contract.js';
import {
  decidePrivateSeed as decidePrivateSeedOperation,
  ingestPendingCue as ingestPendingCueOperation,
  listOwnedSeeds as listOwnedSeedsOperation,
  listPrivateCues as listPrivateCuesOperation,
} from './private-seed-operations.js';
import { loadProactiveSettlementState } from './proactive-relationship-operations.js';
import {
  listProjectionCandidates as listProjectionCandidatesOperation,
  markDiaryProjected as markDiaryProjectedOperation,
  markDiaryProjectionFailed as markDiaryProjectionFailedOperation,
} from './projection-operations.js';
import {
  failRun as failRunOperation,
  getLatestRun as getLatestRunOperation,
  getRun as getRunOperation,
  isOffDuty as isOffDutyOperation,
  requireRun,
} from './run-lifecycle-operations.js';
import { beginRun as beginRunOperation } from './run-operations.js';
import { applyAutoDreamMigrations } from './schema.js';
import { settleRun as settleRunOperation } from './settlement-operations.js';
import { type AutoDreamStoreOptions, resolveAwakenedLeaseMs, resolveForegroundVisitBudget } from './store-config.js';
import type { AutoDreamStoreContext } from './store-context.js';
import type {
  BeginPresentLoopRunInput,
  BeginPresentLoopRunResult,
  CatLifeConfigRecord,
  CatLifePreviewDecisionResult,
  CatLifePreviewRecord,
  CreateCatLifePreviewInput,
  DiaryCitationRecord,
  DiaryEngagementMetrics,
  DiaryEngagementResult,
  DiaryEngagementState,
  DiaryEngagementValue,
  DiaryProjectionCandidate,
  DreamDiaryEntryRecord,
  InvocationPrincipal,
  PresentLoopMetrics,
  PresentLoopRunRecord,
  PresentLoopSettlementResult,
  SettlePresentLoopValue,
  SleepPostureRecord,
} from './store-types.js';

export class AutoDreamStore implements F255PendingCueSink {
  readonly proactive: ProactiveRelationshipStore;
  private db: Database.Database | null = null;
  private readonly dbPath: string;
  private readonly now: () => number;
  private readonly idFactory: (prefix: string) => string;
  private readonly awakenedLeaseMs: number;
  private readonly foregroundVisitBudget: number;

  constructor(dbPath: string, options: AutoDreamStoreOptions = {}) {
    this.dbPath = dbPath;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? ((prefix) => `${prefix}${randomUUID().replaceAll('-', '')}`);
    this.awakenedLeaseMs = resolveAwakenedLeaseMs(options.awakenedLeaseMs);
    this.foregroundVisitBudget = resolveForegroundVisitBudget(options.foregroundVisitBudget);
    this.proactive = new ProactiveRelationshipStore(() => this.context());
  }

  async initialize(): Promise<void> {
    if (this.dbPath !== ':memory:') mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    applyAutoDreamMigrations(this.db, this.now());
    expireAwakenedRunsOperation(this.context());
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  async beginRun(input: BeginPresentLoopRunInput): Promise<BeginPresentLoopRunResult> {
    return beginRunOperation(this.context(), input);
  }

  async settleRun(principal: InvocationPrincipal, input: SettlePresentLoopValue): Promise<PresentLoopSettlementResult> {
    const context = this.context();
    const ids = settleRunOperation(context, principal, input);
    return {
      run: requireRun(context, principal.userId, ids.runId),
      diary: ids.diaryId ? getDiaryOperation(context, principal.userId, ids.diaryId) : null,
      sleepPosture: ids.postureId ? getSleepPostureOperation(context, principal.userId, ids.postureId) : null,
      proactive: loadProactiveSettlementState(context, principal.userId, ids.runId),
      metrics: getMetricsOperation(context, principal.userId, principal.catId),
    };
  }

  async failRun(ownerUserId: string, runId: string, reason: string): Promise<PresentLoopRunRecord> {
    return failRunOperation(this.context(), ownerUserId, runId, reason);
  }

  async getRun(ownerUserId: string, runId: string): Promise<PresentLoopRunRecord | null> {
    return getRunOperation(this.context(), ownerUserId, runId);
  }

  async getLatestRun(ownerUserId: string, catId: string): Promise<PresentLoopRunRecord | null> {
    return getLatestRunOperation(this.context(), ownerUserId, catId);
  }

  async isOffDuty(ownerUserId: string, catId: string): Promise<boolean> {
    return isOffDutyOperation(this.context(), ownerUserId, catId);
  }

  async getCatLifeConfig(ownerUserId: string, catId: string): Promise<CatLifeConfigRecord | null> {
    return getCatLifeConfigOperation(this.context(), ownerUserId, catId);
  }

  async listCatLifeConfigs(ownerUserId: string): Promise<CatLifeConfigRecord[]> {
    return listCatLifeConfigsOperation(this.context(), ownerUserId);
  }

  async getCatLifePreview(ownerUserId: string, previewId: string): Promise<CatLifePreviewRecord> {
    return getCatLifePreviewOperation(this.context(), ownerUserId, previewId);
  }

  async createCatLifePreview(input: CreateCatLifePreviewInput): Promise<CatLifePreviewRecord> {
    return createCatLifePreviewOperation(this.context(), input);
  }

  async decideCatLifePreview(
    ownerUserId: string,
    previewId: string,
    decision: 'confirm' | 'cancel',
  ): Promise<CatLifePreviewDecisionResult> {
    return decideCatLifePreviewOperation(this.context(), ownerUserId, previewId, decision);
  }

  async markCatLifeProjectionReady(ownerUserId: string, catId: string): Promise<CatLifeConfigRecord | null> {
    return markCatLifeProjectionOperation(this.context(), ownerUserId, catId, { status: 'ready' });
  }

  async markCatLifeProjectionError(
    ownerUserId: string,
    catId: string,
    error: string,
  ): Promise<CatLifeConfigRecord | null> {
    return markCatLifeProjectionOperation(this.context(), ownerUserId, catId, { status: 'error', error });
  }

  async getDiary(ownerUserId: string, diaryId: string): Promise<DreamDiaryEntryRecord | null> {
    return getDiaryOperation(this.context(), ownerUserId, diaryId);
  }

  async listDiaries(
    ownerUserId: string,
    options: { includeArchived?: boolean; limit?: number; catId?: string } = {},
  ): Promise<DreamDiaryEntryRecord[]> {
    return listDiariesOperation(this.context(), ownerUserId, options);
  }

  async archiveDiary(ownerUserId: string, diaryId: string): Promise<DreamDiaryEntryRecord | null> {
    return archiveDiaryOperation(this.context(), ownerUserId, diaryId);
  }

  async recordDiaryEngagement(
    ownerUserId: string,
    diaryId: string,
    input: DiaryEngagementValue,
  ): Promise<DiaryEngagementResult> {
    return recordDiaryEngagementOperation(this.context(), ownerUserId, diaryId, input);
  }

  async getDiaryEngagement(ownerUserId: string, diaryId: string): Promise<DiaryEngagementState> {
    return getDiaryEngagementOperation(this.context(), ownerUserId, diaryId);
  }

  async getDiaryEngagementMetrics(ownerUserId: string, catId: string): Promise<DiaryEngagementMetrics> {
    return getDiaryEngagementMetricsOperation(this.context(), ownerUserId, catId);
  }

  async listDiaryCitations(ownerUserId: string, diaryId: string): Promise<DiaryCitationRecord[]> {
    return listDiaryCitationsOperation(this.context(), ownerUserId, diaryId);
  }

  async getSleepPosture(ownerUserId: string, postureId: string): Promise<SleepPostureRecord | null> {
    return getSleepPostureOperation(this.context(), ownerUserId, postureId);
  }

  async listPendingPostures(ownerUserId: string, catId: string): Promise<SleepPostureRecord[]> {
    return listPendingPosturesOperation(this.context(), ownerUserId, catId);
  }

  async ingestPendingCue(input: F255PendingCueInput): Promise<F255PendingCueReceipt> {
    return ingestPendingCueOperation(this.context(), input);
  }

  async listPrivateCues(
    ownerUserId: string,
    catId: string,
    options: PrivateCueListOptions = {},
  ): Promise<PrivateCueRecord[]> {
    return listPrivateCuesOperation(this.context(), ownerUserId, catId, options);
  }

  async listOwnedSeeds(
    ownerUserId: string,
    catId: string,
    options: OwnedSeedListOptions = {},
  ): Promise<OwnedSeedRecord[]> {
    return listOwnedSeedsOperation(this.context(), ownerUserId, catId, options);
  }

  async decidePrivateSeed(
    principal: InvocationPrincipal,
    input: PrivateSeedDecisionInput,
  ): Promise<PrivateSeedDecisionResult> {
    return decidePrivateSeedOperation(this.context(), principal, input);
  }

  async getMetrics(ownerUserId: string, catId: string, window = 20): Promise<PresentLoopMetrics> {
    return getMetricsOperation(this.context(), ownerUserId, catId, window);
  }

  async listAuditEvents(
    ownerUserId: string,
    filter: { runId?: string; catId?: string; eventKind?: string; limit?: number } = {},
  ): Promise<AutoDreamAuditEventRecord[]> {
    return listAuditEventsOperation(this.context(), ownerUserId, filter);
  }

  async listProjectionCandidates(ownerUserId: string, limit = 100): Promise<DiaryProjectionCandidate[]> {
    return listProjectionCandidatesOperation(this.context(), ownerUserId, limit);
  }

  async markDiaryProjected(ownerUserId: string, diaryId: string, revision: number): Promise<boolean> {
    return markDiaryProjectedOperation(this.context(), ownerUserId, diaryId, revision);
  }

  async markDiaryProjectionFailed(ownerUserId: string, diaryId: string, error: string): Promise<void> {
    markDiaryProjectionFailedOperation(this.context(), ownerUserId, diaryId, error);
  }

  private context(): AutoDreamStoreContext {
    if (!this.db) throw new Error('AutoDreamStore not initialized');
    return {
      db: this.db,
      now: this.now,
      idFactory: this.idFactory,
      awakenedLeaseMs: this.awakenedLeaseMs,
      foregroundVisitBudget: this.foregroundVisitBudget,
    };
  }
}
export type { AutoDreamAuditEventRecord } from './audit-operations.js';
export { ProactiveRelationshipStore } from './ProactiveRelationshipStore.js';
export type {
  F255PendingCueInput,
  F255PendingCueReceipt,
  F255PendingCueSink,
  OwnedSeedListOptions,
  OwnedSeedRecord,
  OwnedSeedStatus,
  PrivateCueListOptions,
  PrivateCueRecord,
  PrivateCueSourceRef,
  PrivateCueStatus,
  PrivateSeedDecisionInput,
  PrivateSeedDecisionResult,
} from './private-seed-contract.js';
export type { AutoDreamStoreOptions } from './store-config.js';
export { DEFAULT_AWAKENED_LEASE_MS, DEFAULT_FOREGROUND_VISIT_BUDGET } from './store-config.js';
export type {
  AutoDreamStoreErrorCode,
  BeginPresentLoopRunInput,
  BeginPresentLoopRunResult,
  CatLifeConfigRecord,
  CatLifeDerivedValue,
  CatLifePreviewDecisionResult,
  CatLifePreviewRecord,
  CatLifeSettingsValue,
  CreateCatLifePreviewInput,
  DiaryCitationRecord,
  DiaryDraftValue,
  DiaryEngagementMetrics,
  DiaryEngagementRecord,
  DiaryEngagementResult,
  DiaryEngagementState,
  DiaryEngagementValue,
  DiaryEntryKind,
  DiaryProjectionCandidate,
  DiaryTraceKind,
  DreamDiaryEntryRecord,
  DreamEvidenceRefValue,
  InvocationPrincipal,
  PresentLoopMetrics,
  PresentLoopOutcome,
  PresentLoopRunRecord,
  PresentLoopRunState,
  PresentLoopSettlementResult,
  SettlePresentLoopValue,
  SleepPosturePayload,
  SleepPostureRecord,
} from './store-types.js';
export { AutoDreamStoreError } from './store-types.js';
