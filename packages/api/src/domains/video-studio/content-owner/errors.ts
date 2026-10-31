export class ContentOwnerConflictError extends Error {
  readonly code = 'OWNER_REVISION_CONFLICT';

  constructor(
    readonly contentRef: string,
    readonly expectedOwnerRevision: number,
    readonly actualOwnerRevision: number,
  ) {
    super(
      `Content owner revision conflict for ${contentRef}: expected ${expectedOwnerRevision}, actual ${actualOwnerRevision}`,
    );
    this.name = 'ContentOwnerConflictError';
  }
}

export class ContentOwnerIdempotencyError extends Error {
  readonly code = 'OPERATION_ID_REUSED';

  constructor(
    readonly contentRef: string,
    readonly operationId: string,
  ) {
    super(`Operation ${operationId} was reused with different content-owner inputs for ${contentRef}`);
    this.name = 'ContentOwnerIdempotencyError';
  }
}

export class ContentOwnerNotFoundError extends Error {
  readonly code = 'CONTENT_NOT_FOUND';

  constructor(readonly contentRef: string) {
    super(`Content not found: ${contentRef}`);
    this.name = 'ContentOwnerNotFoundError';
  }
}
