import { CollectiveServiceError } from './errors.js';
import type { MembershipRecord, ServiceState } from './service-records.js';
import { membershipKey } from './state.js';

export function requireMembership(state: ServiceState, collectiveId: string, humanId: string): MembershipRecord {
  if (!state.collectives[collectiveId]) {
    throw new CollectiveServiceError('COLLECTIVE_NOT_FOUND', 'Collective was not found', 404);
  }
  const membership = state.memberships[membershipKey(collectiveId, humanId)];
  if (!membership || membership.status !== 'active') {
    throw new CollectiveServiceError('FORBIDDEN', 'Collective membership is required', 403);
  }
  return membership;
}

export function requireSteward(state: ServiceState, collectiveId: string, humanId: string): MembershipRecord {
  const membership = requireMembership(state, collectiveId, humanId);
  if (membership.role !== 'steward') {
    throw new CollectiveServiceError('FORBIDDEN', 'Collective steward authority is required', 403);
  }
  return membership;
}
