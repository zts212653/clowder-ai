import type { CatId, SessionRecord, SessionStatus } from '@cat-cafe/shared';
import type { TranscriptEvent } from '../../../domains/cats/services/session/TranscriptReader.js';
import type { SessionContinuationTargetScan } from '../../../domains/cats/services/stores/ports/SessionChainStore.js';

export type SessionRecoveryTranscriptEvidenceStatus = 'available' | 'missing_invocation' | 'not_found' | 'read_failed';

export interface SessionEvidenceRef {
  sessionId: string;
  evidenceRef: `session:${string}`;
  threadId: string;
  catId: CatId;
  userId: string;
  seq: number;
  status: SessionStatus;
  createdAt: number;
  sealedAt?: number;
}

export interface SessionRecoveryAssessment {
  trialId: string;
  stateReconstruction: 'recovered' | 'stale' | 'unknown';
  firstMeaningfulAction: 'aligned' | 'repeated' | 'misaligned' | 'unknown';
  /** Eval-cat-selected event from the target opening invocation; required when firstMeaningfulAction is known. */
  firstMeaningfulEventRef?: string;
  outcome: 'continued' | 'completed' | 'failed' | 'unknown';
  evidenceRefs: string[];
  rationale: string;
}

export interface SessionRecoverySourceSelector {
  kind: 'session-recovery-window';
  /** Half-open target Session creation window. */
  windowStartMs: number;
  windowEndMs: number;
  catId?: string;
  threadId?: string;
  limit?: number;
  assessments?: SessionRecoveryAssessment[];
}

export interface SessionRecoveryTrial {
  trialId: `session-recovery:${string}`;
  source: SessionEvidenceRef;
  target: SessionEvidenceRef;
  firstInvocationId?: string;
  terminalEventRef?: string;
  transcriptEvidenceStatus: SessionRecoveryTranscriptEvidenceStatus;
  transcriptEvidenceTruncated?: boolean;
  evidenceRefs: string[];
  assessment?: SessionRecoveryAssessment;
}

export interface SessionRecoveryResolveScope {
  ownerUserId?: string;
}

export interface SessionRecoverySessionStore {
  scanContinuationTargets(query: SessionContinuationTargetScan): SessionRecord[] | Promise<SessionRecord[]>;
  get(id: string): SessionRecord | null | Promise<SessionRecord | null>;
}

export interface SessionRecoveryTranscriptReader {
  readEvents(
    sessionId: string,
    threadId: string,
    catId: string,
    cursor?: { eventNo: number },
    limit?: number,
  ): Promise<{ events: TranscriptEvent[]; nextCursor?: { eventNo: number }; total: number }>;
}

export interface SessionRecoveryTrialProviderDeps {
  sessionStore: SessionRecoverySessionStore;
  transcriptReader: SessionRecoveryTranscriptReader;
}

export interface SessionRecoveryTrialGrade {
  semantic: 'pass' | 'fail' | 'unknown';
  stateReconstruction: SessionRecoveryAssessment['stateReconstruction'];
  firstMeaningfulAction: SessionRecoveryAssessment['firstMeaningfulAction'];
  outcome: SessionRecoveryAssessment['outcome'];
}
