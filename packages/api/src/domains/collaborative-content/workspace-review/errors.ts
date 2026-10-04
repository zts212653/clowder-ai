export class WorkspaceContentReviewError extends Error {
  constructor(
    readonly code:
      | 'access_denied'
      | 'not_found'
      | 'invalid_action'
      | 'operation_reused'
      | 'revision_conflict'
      | 'source_changed'
      | 'source_unavailable'
      | 'version_pending'
      | 'existing_contexts'
      | 'unsupported_content',
    readonly contexts?: readonly { reviewId: string; round: number; taskId: string; threadId: string; title: string }[],
  ) {
    super(code);
    this.name = 'WorkspaceContentReviewError';
  }
}
