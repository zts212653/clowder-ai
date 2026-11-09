export type ScheduleMutationProposalStoreErrorCode =
  | 'SCHEDULE_PROPOSAL_NOT_FOUND'
  | 'SCHEDULE_PROPOSAL_STATE'
  | 'SCHEDULE_TASK_CONFLICT'
  | 'SCHEDULE_TASK_DRIFT';

export class ScheduleMutationProposalStoreError extends Error {
  constructor(
    readonly code: ScheduleMutationProposalStoreErrorCode,
    readonly statusCode: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'ScheduleMutationProposalStoreError';
  }
}
