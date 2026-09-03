import type { CapabilityProfileRevisionRefV1, RoutingCandidateBindingV1 } from '@cat-cafe/shared';

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
