// One typed failure vocabulary is shared by admission, binding replay, and outcome verification.
export type PawFeelDirectRepairErrorCode =
  | 'source_unavailable'
  | 'source_mismatch'
  | 'source_tool_unclassified'
  | 'provider_not_found'
  | 'provider_ambiguous'
  | 'provider_unavailable'
  | 'registration_invalid'
  | 'action_not_found'
  | 'action_source_mismatch'
  | 'owner_mismatch'
  | 'target_mismatch'
  | 'binding_mismatch'
  | 'terminal_evidence_invalid'
  | 'outcome_invalid';

export class PawFeelDirectRepairError extends Error {
  constructor(
    readonly code: PawFeelDirectRepairErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PawFeelDirectRepairError';
  }
}
