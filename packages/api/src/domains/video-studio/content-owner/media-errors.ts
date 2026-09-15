export class MediaOwnerError extends Error {
  constructor(
    readonly code:
      | 'access_denied'
      | 'not_found'
      | 'task_changed'
      | 'task_closed'
      | 'invalid_media'
      | 'media_unavailable'
      | 'publication_changed',
  ) {
    super(code);
    this.name = 'MediaOwnerError';
  }
}
