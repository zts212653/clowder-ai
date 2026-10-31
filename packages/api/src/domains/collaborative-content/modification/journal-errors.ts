export class ContentModificationJournalError extends Error {
  constructor(
    readonly code:
      | 'operation_reused'
      | 'not_found'
      | 'lease_changed'
      | 'invalid_progress'
      | 'request_cancelled'
      | 'candidate_rejected'
      | 'acceptance_exists'
      | 'task_cancellation_pending',
  ) {
    super(code);
  }
}
