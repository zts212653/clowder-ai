export class ModificationTextError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'task_changed'
      | 'source_changed'
      | 'operation_reused'
      | 'proposal_changed'
      | 'invalid_patch',
  ) {
    super(code);
  }
}
