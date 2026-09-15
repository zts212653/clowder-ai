export type ArtifactReviewErrorCode =
  | 'not_found'
  | 'access_denied'
  | 'invalid_media'
  | 'media_unavailable'
  | 'publication_changed'
  | 'task_changed'
  | 'task_closed'
  | 'asset_changed'
  | 'revision_conflict'
  | 'operation_reused'
  | 'invalid_action'
  | 'invalid_anchor'
  | 'owner_required'
  | 'human_required'
  | 'limit_reached'
  | 'version_pending';

export class ArtifactReviewError extends Error {
  constructor(
    readonly code: ArtifactReviewErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'ArtifactReviewError';
  }
}
