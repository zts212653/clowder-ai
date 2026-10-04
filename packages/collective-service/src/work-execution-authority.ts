import type { CollectiveWorkRecord } from '@cat-cafe/shared';
import { requireWorkSource } from './collaboration-command-helpers.js';
import { CollectiveServiceError } from './errors.js';
import type { ServiceState } from './state.js';
import { requireRegisteredWorkGrant } from './work-policy-store.js';

/** Prior commitment and admission are facts. Current owner permission remains a separate check. */
export function requireAcceptedWorkExecution(state: ServiceState, work: CollectiveWorkRecord, now: number) {
  if (!work.acceptance && !work.executionAuthority) return; // Unchanged Human-committed assignments retain their original producer.
  const authority = work.executionAuthority ?? work.acceptance;
  if (!work.assignment || !authority || authority.hostAdmission?.state !== 'admitted')
    throw new CollectiveServiceError('WORK_ADMISSION_NOT_CURRENT', 'The exact Work has no actual Host admission', 409);
  requireRegisteredWorkGrant(
    state,
    { ...authority, connectionId: work.assignment.connectionId, catId: work.assignment.catId },
    requireWorkSource(state, work.collectiveId, authority.sourceEventId),
    now,
    false,
  );
}
