/**
 * F278 Paw-Feel Disposition Inbox shared contracts.
 *
 * Marker text is intentionally absent. The canonical body stays in MessageStore;
 * these DTOs carry only source identity, irreversible digest and disposition facts.
 */

export const PAW_FEEL_DISPOSITION_STATES = [
  'new',
  'seen',
  'route_pending',
  'routed',
  'closed',
  'duplicate',
  'no_action',
  'fix',
  'signature_waiting',
  'blocked',
] as const;

export type PawFeelDispositionState = (typeof PAW_FEEL_DISPOSITION_STATES)[number];

export const PAW_FEEL_INBOX_SORTS = ['newest', 'oldest'] as const;

export type PawFeelInboxSort = (typeof PAW_FEEL_INBOX_SORTS)[number];

export const PAW_FEEL_NO_ACTION_REASONS = [
  'working_as_intended',
  'insufficient_evidence',
  'out_of_scope',
  'superseded',
  'not_actionable',
  'parser_false_positive',
] as const;

export type PawFeelNoActionReason = (typeof PAW_FEEL_NO_ACTION_REASONS)[number];

export type PawFeelSignalId = string;
export type PawFeelCaptureMethod = 'typed' | 'legacy_parser';
export type PawFeelCaptureAssessment = 'confirmed' | 'ambiguous' | 'contaminated';

export interface PawFeelSourceRef {
  sourceMessageId: string;
  sourceThreadId: string;
  sourceCatId: string;
  markerDigest: string;
  sameDigestOrdinal: number;
  /** Navigation hint only. Stable identity never depends on this index. */
  markerIndex: number;
}

export type PawFeelDispositionActor =
  | { kind: 'cat'; id: string }
  | { kind: 'cvo'; id: string }
  | { kind: 'automation'; id: string }
  | { kind: 'migration'; id: string };

export type PawFeelSignatureAction =
  | { type: 'duplicate'; duplicateOf: PawFeelSignalId }
  | { type: 'no_action'; reasonCode: PawFeelNoActionReason }
  | {
      type: 'fix';
      ownerCatId: string;
      taskId: string;
      leaseId: string;
      leaseGeneration: number;
      custodyEvidenceRef: string;
    };

export interface PawFeelSignatureRequest {
  requestId: string;
  requestedByCatId: string;
  excludedSignerCatId: string;
  preferredSignerCatId?: string;
  action: PawFeelSignatureAction;
}

export interface PawFeelResponsibilityBlocker {
  code: string;
  ref: string;
}

export const PAW_FEEL_RESPONSIBILITY_STATES = [
  'unreviewed',
  'bound_in_repair',
  'signature_waiting',
  'blocked',
  'terminal',
] as const;

export type PawFeelResponsibilityState = (typeof PAW_FEEL_RESPONSIBILITY_STATES)[number];

export type PawFeelResponsibilityExitKind =
  | 'none'
  | 'repair_binding'
  | 'signature_request'
  | 'pending_proposal'
  | 'explicit_blocker'
  | 'terminal_disposition';

export interface PawFeelResponsibilityProjection {
  state: PawFeelResponsibilityState;
  /** True only when the bundle has durable business evidence for an allowed shift exit. */
  validExit: boolean;
  exitKind: PawFeelResponsibilityExitKind;
  evidenceRefs: string[];
  ownerCatId?: string;
  taskId?: string;
  leaseId?: string;
  proposalId?: string;
  signerExclusionCatId?: string;
  preferredSignerCatId?: string;
  blocker?: PawFeelResponsibilityBlocker;
}

export type PawFeelResponsibilityCounts = Record<PawFeelResponsibilityState, number>;

export interface PawFeelEventBase {
  eventId: string;
  signalId: PawFeelSignalId;
  actor: PawFeelDispositionActor;
  occurredAt: string;
}

export type PawFeelDispositionEvent =
  | (PawFeelEventBase & {
      type: 'discovered';
      source: PawFeelSourceRef;
      backfilled: boolean;
      captureMethod: PawFeelCaptureMethod;
      captureAssessment: PawFeelCaptureAssessment;
    })
  | (PawFeelEventBase & { type: 'seen' })
  | (PawFeelEventBase & {
      type: 'route_pending';
      targetThreadId?: string;
      ownerEvidenceRef?: string;
      proposalId?: string;
    })
  | (PawFeelEventBase & {
      type: 'routed';
      targetThreadId?: string;
      proposalId?: string;
      receiptRef: string;
    })
  | (PawFeelEventBase & {
      type: 'route_reopened';
      rejectionRef: string;
      reasonCode: string;
    })
  | (PawFeelEventBase & {
      type: 'closed';
      reasonCode: string;
      outcomeRef: string;
    })
  | (PawFeelEventBase & {
      type: 'duplicate';
      duplicateOf: PawFeelSignalId;
      /** Required for new writes; optional only for replaying pre-Phase-E history. */
      ownerCatId?: string;
    })
  | (PawFeelEventBase & {
      type: 'no_action';
      reasonCode: PawFeelNoActionReason;
      /** Required for new writes; optional only for replaying pre-Phase-E history. */
      ownerCatId?: string;
    })
  | (PawFeelEventBase & {
      type: 'fix';
      ownerCatId: string;
      taskId: string;
      leaseId: string;
      leaseGeneration: number;
      custodyEvidenceRef: string;
    })
  | (PawFeelEventBase & {
      type: 'signature_requested';
      action: PawFeelSignatureAction;
      preferredSignerCatId?: string;
    })
  | (PawFeelEventBase & {
      type: 'blocked';
      blockerCode: string;
      blockerRef: string;
    });

export interface PawFeelDispositionProjection extends PawFeelSourceRef {
  signalId: PawFeelSignalId;
  state: PawFeelDispositionState;
  sequence: number;
  discoveredAt: string;
  lastTransitionAt: string;
  lastActorCatId?: string;
  targetThreadId?: string;
  proposalId?: string;
  duplicateOf?: PawFeelSignalId;
  reasonCode?: string;
  outcomeRef?: string;
  ownerCatId?: string;
  taskId?: string;
  actionLeaseRef?: { leaseId: string; generation: number };
  custodyEvidenceRef?: string;
  signatureRequest?: PawFeelSignatureRequest;
  blocker?: PawFeelResponsibilityBlocker;
  backfilled: boolean;
  captureMethod: PawFeelCaptureMethod;
  captureAssessment: PawFeelCaptureAssessment;
}

export type PawFeelSourceResolution =
  | {
      availability: 'available';
      preview: string;
      sourceHref: string;
      digestVerified: true;
    }
  | {
      availability: 'unavailable';
      reason: string;
      sourceHref: string;
    };

export interface PawFeelInboxItem {
  disposition: PawFeelDispositionProjection;
  responsibility: PawFeelResponsibilityProjection;
  source: PawFeelSourceResolution;
  /** Original message timeline time, resolved live from MessageStore. */
  sourceOccurredAt?: string;
  /** SLA age from durable inbox discovery, not from original message time. */
  ageMs: number;
  overdue: boolean;
  deterministicGroupKey?: string;
  /** Ephemeral MessageStore context used only to derive review bundles. */
  reviewContext?: {
    turnInvocationId?: string;
    legacyInvocationId?: string;
    sourceMarkerCount?: number;
  };
}

export interface PawFeelInboxCounts {
  total: number;
  unseen: number;
  inProgress: number;
  routePending: number;
  disposed: number;
  overdue: number;
}

export interface PawFeelDenominator {
  reportOccurrences: number;
  uniqueSourceMessages: number;
  historicalBackfill: number;
  postActivationIntake: number;
  typedConfirmed: number;
  ambiguousOrContaminated: number;
  reviewBundles: number;
  problemFamilies: {
    status: 'unavailable';
    reason: string;
  };
}

export const PAW_FEEL_REVIEW_BUNDLE_BASES = [
  'message',
  'turn_invocation',
  'legacy_invocation',
  'single_signal',
] as const;

export type PawFeelReviewBundleBasis = (typeof PAW_FEEL_REVIEW_BUNDLE_BASES)[number];

export interface PawFeelReviewBundle {
  bundleKey: string;
  /** Server-authenticated exact list snapshot used by confirm without re-deriving membership. */
  membershipToken?: string;
  basis: PawFeelReviewBundleBasis;
  sourceThreadId: string;
  representativeSourceMessageId: string;
  members: PawFeelInboxItem[];
  rawSignalCount: number;
  stateCounts: Partial<Record<PawFeelDispositionState, number>>;
  responsibility: PawFeelResponsibilityProjection;
}

export interface PawFeelReviewBundleCounts {
  total: number;
  byBasis: Record<PawFeelReviewBundleBasis, number>;
}

export interface PawFeelInboxPage {
  generatedAt: string;
  projectionStatus: 'available' | 'unavailable';
  items: PawFeelInboxItem[];
  bundles: PawFeelReviewBundle[];
  bundleCounts: PawFeelReviewBundleCounts;
  denominator: PawFeelDenominator;
  counts: PawFeelInboxCounts;
  /** Bundle-level responsibility truth; raw-signal counts remain available in counts. */
  responsibilityCounts: PawFeelResponsibilityCounts;
  nextCursor?: string;
  degraded: boolean;
  coverage?: PawFeelReconciliationCoverage;
  unavailableReason?: string;
}

export interface PawFeelDutyConfig {
  systemThreadId: 'thread_eval_friction';
  primaryCatId?: string;
  backupCatId?: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export function isCompletePawFeelDutyConfig(
  config: PawFeelDutyConfig | null | undefined,
): config is PawFeelDutyConfig & { primaryCatId: string; backupCatId: string } {
  return Boolean(config?.primaryCatId && config.backupCatId && config.primaryCatId !== config.backupCatId);
}

export interface PawFeelReconciliationCoverage {
  coverageStartAt: string;
  /** Cutover boundary after which only typed capture may mint new rows. */
  typedCaptureActivatedAt?: string;
  lastFullScanStartedAt?: string;
  lastFullScanCompletedAt?: string;
  lastOverlapCompletedAt?: string;
  lastSeenTimelineAt?: string;
  status: 'uninitialized' | 'healthy' | 'lagging' | 'unavailable';
  lagMs?: number;
  unavailableReason?: string;
}
