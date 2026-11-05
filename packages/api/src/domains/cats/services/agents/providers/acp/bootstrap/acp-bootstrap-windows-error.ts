export class WindowsAcpBootstrapError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly path?: string,
  ) {
    super(`Windows ACP bootstrap privacy check failed: ${message}`);
    this.name = 'WindowsAcpBootstrapError';
  }
}

export function windowsAcpBootstrapError(detail: string): WindowsAcpBootstrapError {
  try {
    const value: unknown = JSON.parse(detail);
    if (
      value &&
      typeof value === 'object' &&
      'code' in value &&
      'message' in value &&
      typeof value.code === 'string' &&
      typeof value.message === 'string'
    ) {
      return new WindowsAcpBootstrapError(
        value.code,
        value.message,
        'path' in value && typeof value.path === 'string' ? value.path : undefined,
      );
    }
  } catch {
    /* An unavailable or incompatible verifier cannot authorize relocation. */
  }
  return new WindowsAcpBootstrapError('VERIFICATION_UNAVAILABLE', detail || 'verification unavailable');
}

export function isWindowsAcpAncestorFailure(error: unknown): boolean {
  return (
    error instanceof WindowsAcpBootstrapError &&
    ['PARENT_OWNER', 'PARENT_REPLACEMENT', 'PARENT_VOLUME'].includes(error.code)
  );
}
