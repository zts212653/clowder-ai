export class WorkspaceSecurityError extends Error {
  constructor(
    message: string,
    public readonly code: 'TRAVERSAL' | 'DENIED' | 'NOT_FOUND',
  ) {
    super(message);
    this.name = 'WorkspaceSecurityError';
  }
}
