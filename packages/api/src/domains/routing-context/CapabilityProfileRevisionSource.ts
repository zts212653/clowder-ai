import type { CapabilityProfileRevisionRefV1, RoutingCandidateBindingV1, RoutingReasonV1 } from '@cat-cafe/shared';

export const CAPABILITY_PROFILE_INVALID_REASON = 'capability_profile_invalid';

export interface CapabilityProfileDiagnostic {
  catId: string;
  reason: RoutingReasonV1;
}

export type CapabilityProfileDegradationReason =
  | 'dossier_unavailable'
  | 'dossier_unreadable_or_empty'
  | 'built_in_profile_missing'
  | 'model_missing';

export interface CapabilityProfileRevisionLoadInput {
  ownerId: string;
  candidates: readonly RoutingCandidateBindingV1[];
  intent?: 'review' | 'architecture';
}

export type CapabilityProfileRevisionLoadResult =
  | {
      status: 'fresh';
      profiles: CapabilityProfileRevisionRefV1[];
      absentCatIds: string[];
      diagnostics?: CapabilityProfileDiagnostic[];
    }
  | {
      status: 'degraded';
      reason: CapabilityProfileDegradationReason;
      affectedCatIds: string[];
    };

export interface CapabilityPendingProposalReader {
  countPending(input: { ownerId: string; catId: string }): Promise<number>;
}

export interface CapabilityProfileRevisionSource {
  load(input: CapabilityProfileRevisionLoadInput): Promise<CapabilityProfileRevisionLoadResult>;
}
