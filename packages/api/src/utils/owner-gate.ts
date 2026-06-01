/**
 * Unified owner gate for all routes (issue #794).
 *
 * Replaces scattered owner-check implementations across the codebase with
 * a single function. Behavior:
 *
 * - When `DEFAULT_OWNER_USER_ID` IS configured: userId must match → 403 otherwise
 * - When `DEFAULT_OWNER_USER_ID` is NOT configured: local single-user mode,
 *   any authenticated session is allowed through
 *
 * Security context (defense-in-depth):
 *   Layer 1 — API_SERVER_HOST defaults to 127.0.0.1 (not network-reachable)
 *   Layer 2 — Sensitive endpoints have independent isDirectLoopbackRequest() guards
 *   Layer 3 — This owner gate (adds multi-user isolation when configured)
 *
 * In single-user mode (no owner configured), Layer 1+2 provide sufficient
 * protection. The owner gate only adds value in multi-user/shared deployments.
 */

export interface OwnerGateError {
  status: number;
  error: string;
}

export interface OwnerGateOptions {
  /**
   * Custom error message when the owner gate rejects.
   * Default: 'This operation can only be performed by the configured owner'
   */
  errorMessage?: string;

  /**
   * When true, require DEFAULT_OWNER_USER_ID to be explicitly configured.
   * Used for data-filtering checks where "unconfigured" means "hide sensitive data"
   * rather than "block the request".
   * Default: false (fall through in single-user mode)
   */
  requireConfiguredOwner?: boolean;
}

/**
 * Check if the given userId passes the owner gate.
 *
 * Returns null on success (allowed), or an error object on rejection.
 */
export function resolveOwnerGate(userId: string, options: OwnerGateOptions = {}): OwnerGateError | null {
  const ownerId = process.env.DEFAULT_OWNER_USER_ID?.trim();
  if (!ownerId) {
    // Single-user mode: no owner configured.
    // When requireConfiguredOwner is set, callers explicitly need the env var
    // (e.g. to decide whether to show sensitive data). Otherwise, fall through.
    if (options.requireConfiguredOwner) {
      return {
        status: 403,
        error: options.errorMessage ?? 'This operation requires DEFAULT_OWNER_USER_ID to be configured',
      };
    }
    return null;
  }
  if (userId !== ownerId) {
    return {
      status: 403,
      error: options.errorMessage ?? 'This operation can only be performed by the configured owner',
    };
  }
  return null;
}
