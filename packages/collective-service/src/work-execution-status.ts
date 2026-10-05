import type { CollectiveWorkProjection, CollectiveWorkRecord } from '@cat-cafe/shared';
import { requireWorkSource } from './collaboration-command-helpers.js';
import { CollectiveServiceError } from './errors.js';
import { requireParticipant } from './participation-store.js';
import type { ServiceState } from './state.js';
import { requireRegisteredWorkGrant } from './work-policy-store.js';

type ExecutionStatus = NonNullable<CollectiveWorkProjection['executionStatus']>;

/** Re-read current registered authority for every projection. Historical admission is never rewritten. */
export function projectWorkExecutionStatus(
  state: ServiceState,
  work: CollectiveWorkRecord,
  now: number,
): ExecutionStatus | undefined {
  const authority = work.executionAuthority ?? work.acceptance;
  if (!authority) return undefined;
  const binding = { issuer: 'service' as const, revision: work.executionAuthority?.revision ?? 1 };
  const assignment = work.assignment;
  if (!assignment) return { ...binding, state: 'unavailable', reason: 'WORK_ADMISSION_NOT_CURRENT' };
  try {
    requireParticipant(state, {
      ...assignment,
      collectiveId: work.collectiveId,
      channelId: work.sourceLocation.channelId,
      participationRevision: work.executionAuthority?.participationRevision ?? assignment.participationRevision,
    });
    requireRegisteredWorkGrant(
      state,
      { ...authority, connectionId: assignment.connectionId, catId: assignment.catId },
      requireWorkSource(state, work.collectiveId, authority.sourceEventId),
      now,
      false,
    );
  } catch (error) {
    if (!(error instanceof CollectiveServiceError)) throw error;
    const reason = permissionReason(error.code);
    if (!reason) throw error;
    return { ...binding, state: 'unavailable', reason };
  }
  if (!authority.hostAdmission) return { ...binding, state: 'awaiting_admission' };
  if (authority.hostAdmission.state === 'rejected')
    return {
      ...binding,
      state: 'unavailable',
      reason: permissionReason(authority.hostAdmission.reason ?? '') ?? 'WORK_ADMISSION_NOT_CURRENT',
    };
  return { ...binding, state: 'permitted' };
}

function permissionReason(code: string): ExecutionStatus['reason'] {
  switch (code) {
    case 'WORK_DELEGATION_UNAVAILABLE':
    case 'PARTICIPATION_REVOKED':
    case 'WORK_ADMISSION_NOT_CURRENT':
    case 'CONNECTION_REVOKED':
    case 'WORK_SOURCE_UNAVAILABLE':
      return code;
    case 'FORBIDDEN':
      return 'MEMBERSHIP_REVOKED';
    default:
      return undefined;
  }
}
