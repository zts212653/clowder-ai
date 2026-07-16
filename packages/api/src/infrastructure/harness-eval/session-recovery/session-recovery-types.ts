import type { CatId, SessionRecord, SessionStatus } from '@cat-cafe/shared';
import type { TranscriptEvent } from '../../../domains/cats/services/session/TranscriptReader.js';
import type { SessionScanWindow } from '../../../domains/cats/services/stores/ports/SessionChainStore.js';

export type SessionRecoveryLineage = 'explicit' | 'missing' | 'duplicate' | 'legacy_unlinked';
export type SessionRecoveryTransitionIntegrity = 'pass' | 'fail' | 'unknown';
export type SessionRecoveryDelivery = 'provider_dispatched' | 'missing_receipt' | 'missing_target' | 'unknown';

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
  outcome: 'continued' | 'completed' | 'failed' | 'unknown';
  evidenceRefs: string[];
  rationale: string;
}

export interface SessionRecoverySourceSelector {
  kind: 'session-recovery-window';
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
  target?: SessionEvidenceRef;
  duplicateTargets?: SessionEvidenceRef[];
  inferredTarget?: SessionEvidenceRef;
  lineage: SessionRecoveryLineage;
  transitionIntegrity: SessionRecoveryTransitionIntegrity;
  delivery: SessionRecoveryDelivery;
  structuralIssues: string[];
  firstInvocationId?: string;
  firstMeaningfulEventRef?: string;
  terminalEventRef?: string;
  transcriptEvidenceTruncated?: boolean;
  evidenceRefs: string[];
  assessment?: SessionRecoveryAssessment;
}

export interface SessionRecoveryResolveScope {
  ownerUserId?: string;
}

export interface SessionRecoverySessionStore {
  scanAll(window: SessionScanWindow): SessionRecord[] | Promise<SessionRecord[]>;
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

export interface SessionRecoveryStructuralGrade {
  lineage: SessionRecoveryLineage;
  transitionIntegrity: SessionRecoveryTransitionIntegrity;
  delivery: SessionRecoveryDelivery;
  issues: string[];
}

export interface SessionRecoveryTrialGrade {
  structural: SessionRecoveryTransitionIntegrity;
  semantic: 'pass' | 'fail' | 'unknown';
  stateReconstruction: SessionRecoveryAssessment['stateReconstruction'];
  firstMeaningfulAction: SessionRecoveryAssessment['firstMeaningfulAction'];
  outcome: SessionRecoveryAssessment['outcome'];
  issues: string[];
}
