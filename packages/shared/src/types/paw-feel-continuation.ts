import type { ExactAssetVersionRefV1, OwnerTruthRefV1 } from './capability-evolution-refs.js';

export const PAW_FEEL_ISSUE_RESOLUTIONS = ['open', 'resolved'] as const;
export type PawFeelIssueResolution = (typeof PAW_FEEL_ISSUE_RESOLUTIONS)[number];

export type PawFeelResumeSelectorV1 =
  | { kind: 'task'; ref: OwnerTruthRefV1 }
  | { kind: 'owner_event'; ref: OwnerTruthRefV1 }
  | { kind: 'bounded_time'; recheckAt: string };

export interface PawFeelResumeConditionV1 {
  schemaVersion: 1;
  blockedEpisode: OwnerTruthRefV1;
  selector: PawFeelResumeSelectorV1;
  conditionId: string;
  blockedVersion: string;
}

export interface SourceToolRouteRefV1 {
  ownerFeatureId: string;
  ownerStateRef: string;
  match: 'exact' | 'prefix';
}

export interface PawFeelDirectRepairOwnerRouteV1 {
  schemaVersion: 1;
  providerId: string;
  providerVersion: string;
  sourceToolRoutes: readonly SourceToolRouteRefV1[];
}

export interface VerifiedPawFeelDirectRepairSourceV1 {
  sourceSignalRef: OwnerTruthRefV1;
  sourceToolRef: OwnerTruthRefV1;
  markerDigest: string;
  sameDigestOrdinal: number;
}

export interface PawFeelDirectRepairOwnerAuthorityV1 {
  schemaVersion: 1;
  resolvedActionRef: OwnerTruthRefV1;
  actionScopeRef: OwnerTruthRefV1;
  ownerAuthorizationRef: OwnerTruthRefV1;
  targetVersionRef: ExactAssetVersionRefV1;
  ownerCatId: string;
  outcomeVerifierRef: OwnerTruthRefV1;
}

export interface PawFeelDirectRepairBindingV1 extends PawFeelDirectRepairOwnerAuthorityV1 {
  bindingRef: OwnerTruthRefV1;
  sourceSignalRef: OwnerTruthRefV1;
  sourceToolRef: OwnerTruthRefV1;
  providerId: string;
  providerVersion: string;
  providerRouteRef: OwnerTruthRefV1;
}

export type PawFeelDirectRepairAuthorityDecisionV1 =
  | { status: 'authorized'; authority: PawFeelDirectRepairOwnerAuthorityV1 }
  | {
      status: 'authority_required';
      resolvedActionRef: OwnerTruthRefV1;
      targetVersionRef: ExactAssetVersionRefV1;
      blockerRef: OwnerTruthRefV1;
    }
  | {
      status: 'blocked';
      reason: 'action_not_found' | 'action_source_mismatch' | 'owner_mismatch' | 'target_mismatch';
      blockerRef: OwnerTruthRefV1;
    };

export interface PawFeelDirectRepairOutcomeV1 {
  schemaVersion: 1;
  bindingRef: OwnerTruthRefV1;
  taskTerminalRef: OwnerTruthRefV1;
  leaseTerminalRef: OwnerTruthRefV1;
  ownerOutcomeRef: OwnerTruthRefV1;
  verificationRefs: readonly [OwnerTruthRefV1, ...OwnerTruthRefV1[]];
  disposition: 'verified_changed' | 'verified_no_change';
}

export type PawFeelApprovalContinuationV1 =
  | { kind: 'approval_required'; caseActionRef: string; findingArtifactRef: string }
  | {
      kind: 'analysis_required';
      sourceSignalRef: OwnerTruthRefV1;
      resume: { kind: 'task_or_event'; ref: OwnerTruthRefV1 } | { kind: 'bounded_time'; recheckAt: string };
    }
  | { kind: 'analysis_ambiguous'; evidenceRefs: readonly string[] }
  | { kind: 'analysis_stale'; evidenceRefs: readonly string[] };

export const PAW_FEEL_CONTINUATION_KINDS = [
  'review_required',
  'route_pending',
  'signature_required',
  'repair_active',
  'done_unverified',
  'repair_interrupted',
  'direct_route_blocked',
  'approval_required',
  'dispatch_pending',
  'analysis_required',
  'analysis_ambiguous',
  'analysis_stale',
  'observe',
  'blocked',
  'legacy_blocker_unbound',
  'duplicate_following',
  'verified_outcome',
  'no_action',
] as const;

export type PawFeelContinuationKind = (typeof PAW_FEEL_CONTINUATION_KINDS)[number];

export interface PawFeelContinuationProjection {
  kind: PawFeelContinuationKind;
  evidenceRefs: string[];
  ownerCatId?: string;
  taskId?: string;
  leaseId?: string;
  caseActionRef?: string;
  proposalId?: string;
  canonicalSignalId?: string;
  reasonCode?: string;
}

export interface PawFeelIssueProjection {
  resolution: PawFeelIssueResolution;
  continuation: PawFeelContinuationProjection;
  ageMs: number;
  resumeAt?: string;
  resolvedAt?: string;
}

export interface PawFeelIssueCounts {
  open: number;
  resolved: number;
  overdue: number;
}
