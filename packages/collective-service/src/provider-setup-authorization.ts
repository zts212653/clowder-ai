import { CollectiveServiceError } from './errors.js';
import { secretMatches } from './persistence.js';
import type { ServiceState } from './state.js';

export interface ProviderSetupAuthority {
  readonly bootstrapSecret?: string;
  readonly sessionToken?: string;
}

export function assertProviderSetupAuthorization(
  state: ServiceState,
  now: number,
  input: ProviderSetupAuthority,
  resolveHumanId: (state: ServiceState, sessionToken: string) => string,
): void {
  if (!state.bootstrap.consumedAt) {
    if (Date.parse(state.bootstrap.expiresAt) < now) {
      throw new CollectiveServiceError('BOOTSTRAP_EXPIRED', 'Owner bootstrap expired', 410);
    }
    if (!input.bootstrapSecret || !secretMatches(input.bootstrapSecret, state.bootstrap.tokenDigest)) {
      throw new CollectiveServiceError('INVALID_BOOTSTRAP', 'Owner bootstrap is invalid', 401);
    }
    return;
  }
  if (!input.sessionToken) {
    throw new CollectiveServiceError('AUTHENTICATION_REQUIRED', 'The Service owner session is required', 401);
  }
  const humanId = resolveHumanId(state, input.sessionToken);
  if (!state.bootstrap.ownerHumanId || state.bootstrap.ownerHumanId !== humanId) {
    throw new CollectiveServiceError('FORBIDDEN', 'Only the Service owner can configure Human login', 403);
  }
}
