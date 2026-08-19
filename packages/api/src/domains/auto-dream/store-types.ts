import type {
  CatLifeCostBand,
  CatLifeSettingsInput,
  DiaryDraft,
  DiaryEngagementInput,
  DreamEvidenceRef,
  PresentLoopRunState,
  SettlePresentLoopInput,
  DiaryEntryKind as SharedDiaryEntryKind,
  DiaryTraceKind as SharedDiaryTraceKind,
  PresentLoopOutcome as SharedPresentLoopOutcome,
  SleepPostureDraft,
} from '@cat-cafe/shared';
import type { ProactiveSettlementState } from './proactive-relationship-contract.js';

export type { PresentLoopRunState } from '@cat-cafe/shared';
export type PresentLoopOutcome = SharedPresentLoopOutcome;
export type DiaryEntryKind = SharedDiaryEntryKind;
export type DiaryTraceKind = SharedDiaryTraceKind;
export type DreamEvidenceRefValue = DreamEvidenceRef;
export type DiaryDraftValue = DiaryDraft;
export type SleepPosturePayload = SleepPostureDraft;
export type SettlePresentLoopValue = SettlePresentLoopInput;
export type CatLifeSettingsValue = CatLifeSettingsInput;
export type DiaryEngagementValue = DiaryEngagementInput;

export interface CatLifeDerivedValue {
  cronExpression: string;
  nextWakeAt: number | null;
  weeklyWakeCount: number;
  costBand: CatLifeCostBand;
  costNotice: string;
}

export interface CatLifeConfigRecord {
  ownerUserId: string;
  catId: string;
  enabled: boolean;
  settings: CatLifeSettingsValue;
  derived: CatLifeDerivedValue;
  bedroomThreadId: string;
  projectionTaskId: string;
  projectionStatus: 'pending' | 'ready' | 'error';
  projectionError?: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface CatLifePreviewRecord {
  previewId: string;
  ownerUserId: string;
  catId: string;
  settings: CatLifeSettingsValue;
  derived: CatLifeDerivedValue;
  bedroomThreadId: string;
  projectionTaskId: string;
  status: 'rendered' | 'confirmed' | 'cancelled' | 'expired';
  expiresAt: number;
  decisionAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateCatLifePreviewInput {
  ownerUserId: string;
  catId: string;
  settings: CatLifeSettingsValue;
  derived: CatLifeDerivedValue;
  bedroomThreadId: string;
  projectionTaskId: string;
  expiresAt: number;
}

export interface CatLifePreviewDecisionResult {
  preview: CatLifePreviewRecord;
  config: CatLifeConfigRecord | null;
  applied: boolean;
}

export interface DiaryEngagementRecord {
  engagementId: string;
  ownerUserId: string;
  diaryId: string;
  catId: string;
  kind: 'open' | 'reaction';
  clientEventId: string;
  active: boolean;
  createdAt: number;
}

export interface DiaryEngagementState {
  opened: boolean;
  reacted: boolean;
  openCount: number;
}

export interface DiaryEngagementMetrics {
  publishedDiaryCount: number;
  openedDiaryCount: number;
  reactedDiaryCount: number;
  diaryOpenRate: number;
  reactionRate: number;
}

export interface DiaryEngagementResult {
  event: DiaryEngagementRecord;
  state: DiaryEngagementState;
  created: boolean;
}

export interface InvocationPrincipal {
  kind: 'invocation';
  invocationId: string;
  threadId: string;
  userId: string;
  catId: string;
}

export interface BeginPresentLoopRunInput {
  ownerUserId: string;
  catId: string;
  threadId: string;
  taskId: string;
  scheduledAt?: number;
  firedAt: number;
  latenessMs?: number;
  missedSlots?: number;
}

export interface BeginPresentLoopRunResult {
  run: PresentLoopRunRecord;
  continuity: SleepPostureRecord | null;
  /** False when the scheduler retries an already-recorded task slot. */
  created: boolean;
}

export interface PresentLoopRunRecord {
  runId: string;
  ownerUserId: string;
  catId: string;
  threadId: string;
  taskId: string;
  state: PresentLoopRunState;
  outcome?: PresentLoopOutcome;
  scheduledAt?: number;
  firedAt: number;
  latenessMs: number;
  missedSlots: number;
  settlementInvocationId?: string;
  diaryId?: string;
  sleepPostureId?: string;
  failureReason?: string;
  awakenedAt: number;
  leaseExpiresAt: number;
  settledAt?: number;
  failedAt?: number;
  expiredAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface DreamDiaryEntryRecord {
  diaryId: string;
  ownerUserId: string;
  dreamRunId: string;
  catId: string;
  localDate: string;
  writtenAt: number;
  status: 'published' | 'archived';
  docKind: 'diary';
  entryKind: DiaryEntryKind;
  traceKind: DiaryTraceKind;
  tenseMarker: 'historical';
  volumeNo: number;
  headline: string;
  summary: string;
  bodyMarkdown: string;
  provenance: DreamEvidenceRefValue[];
  observations: unknown[];
  producedActions: {
    profileProposalIds: string[];
    eventIds: string[];
    provokeIds: string[];
  };
  createdByInvocationId: string;
  sourceThreadId: string;
  sourceMessageId?: string;
  archivedAt?: number;
  sealedAt?: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface SleepPostureRecord {
  postureId: string;
  ownerUserId: string;
  catId: string;
  sourceRunId: string;
  authorInvocationId: string;
  payload: SleepPosturePayload;
  status: 'pending' | 'archived';
  leasedByRunId?: string;
  consumedByRunId?: string;
  consumedAt?: number;
  archivedAt?: number;
  archiveReason?: 'consumed' | 'superseded';
  createdAt: number;
  updatedAt: number;
}

export interface DiaryCitationRecord {
  citationId: string;
  ownerUserId: string;
  fromDiaryId: string;
  toRef: DreamEvidenceRefValue;
  citedAt: number;
}

export interface PresentLoopMetrics {
  window: number;
  diaryCount: number;
  workCount: number;
  workShare: number;
  minimumDiarySamples: number;
  lowSample: boolean;
  reportificationWarning: boolean;
  outcomes: Record<PresentLoopOutcome, number>;
  silentOutcomeShare: number;
}

export interface PresentLoopSettlementResult {
  run: PresentLoopRunRecord;
  diary: DreamDiaryEntryRecord | null;
  sleepPosture: SleepPostureRecord | null;
  proactive: ProactiveSettlementState;
  metrics: PresentLoopMetrics;
}

export interface DiaryProjectionCandidate {
  diary: DreamDiaryEntryRecord;
  projectedRevision: number;
  lastError?: string;
}

export type AutoDreamStoreErrorCode =
  | 'OWNER_NOT_CONFIGURED'
  | 'RUN_NOT_FOUND'
  | 'RUN_ALREADY_SETTLED'
  | 'RUN_NOT_SETTLEABLE'
  | 'INVALID_SETTLEMENT'
  | 'PREVIEW_NOT_FOUND'
  | 'PREVIEW_EXPIRED'
  | 'PREVIEW_ALREADY_DECIDED'
  | 'INVALID_CAT_LIFE_SETTINGS'
  | 'CAT_NOT_FOUND'
  | 'CAT_DISABLED'
  | 'DIARY_NOT_FOUND'
  | 'INVALID_ENGAGEMENT'
  | 'INVALID_PRIVATE_CUE'
  | 'PRIVATE_CUE_CONFLICT'
  | 'PRIVATE_CUE_NOT_FOUND'
  | 'PRIVATE_CUE_ALREADY_DECIDED'
  | 'INVALID_SEED_DECISION'
  | 'OWNED_SEED_NOT_FOUND'
  | 'OWNED_SEED_NOT_AVAILABLE'
  | 'PROACTIVE_HOME_MISMATCH'
  | 'INVALID_PROACTIVE_INTENT'
  | 'INVALID_PROACTIVE_RELATIONSHIP'
  | 'PROACTIVE_INTENT_NOT_FOUND'
  | 'PROACTIVE_VISIT_NOT_FOUND'
  | 'PROACTIVE_VISIT_NOT_VISIBLE'
  | 'PROACTIVE_VISIT_ALREADY_VISIBLE'
  | 'PROACTIVE_VISIT_CANCELLED'
  | 'PROACTIVE_CANONICAL_MESSAGE_CONFLICT'
  | 'PROACTIVE_DELIVERY_NOT_PENDING'
  | 'PROACTIVE_ECHO_NOT_FOUND'
  | 'PROACTIVE_ECHO_CONFLICT';

export class AutoDreamStoreError extends Error {
  readonly code: AutoDreamStoreErrorCode;
  readonly statusCode: number;

  constructor(code: AutoDreamStoreErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = 'AutoDreamStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
