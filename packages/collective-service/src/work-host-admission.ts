import { isDeepStrictEqual } from 'node:util';
import type { CollectiveWorkHostAdmissionRequest } from '@cat-cafe/shared';
import { mutableWork, requireWorkSource } from './collaboration-command-helpers.js';
import { projectCollectiveWork } from './collaboration-work.js';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import type { MutableServiceState } from './state.js';
import { requireRegisteredWorkGrant } from './work-policy-store.js';

/** This is a scoped Host fact, not ongoing execution or publication authority. */
export function recordWorkHostAdmission(
  state: MutableServiceState,
  credential: string,
  input: CollectiveWorkHostAdmissionRequest,
  now: number,
) {
  const connection = requireConnection(state, credential, input.connectionId);
  assertConnectionCoordinates(state, connection, input);
  const human = requireAuthorizedHuman(state, connection);
  const work = mutableWork(state, input.collectiveId, input.workId);
  const acceptance = work.executionAuthority ?? work.acceptance;
  if (
    !acceptance ||
    work.assignment?.connectionId !== connection.connectionId ||
    work.assignment.humanId !== human.humanId ||
    work.assignmentEventId !== input.assignmentEventId ||
    acceptance.operationRef !== input.operationRef ||
    acceptance.grantRef !== input.grantRef ||
    acceptance.grantRevision !== input.grantRevision ||
    (work.executionAuthority?.revision ?? 1) !== (input.executionRevision ?? 1)
  )
    throw new CollectiveServiceError(
      'WORK_ADMISSION_NOT_CURRENT',
      'Host admission must cover the current exact assignment',
      409,
    );
  if (acceptance.hostAdmission) {
    const { at: _at, issuer: _issuer, ...previous } = acceptance.hostAdmission;
    if (isDeepStrictEqual(previous, input.disposition)) return projectCollectiveWork(state, work, now);
    // A Host may withdraw executability, never revive it within the same authority revision.
    if (previous.state !== 'admitted' || input.disposition.state !== 'rejected')
      throw new CollectiveServiceError(
        previous.state === 'rejected' && input.disposition.state === 'admitted'
          ? 'WORK_ADMISSION_NOT_CURRENT'
          : 'WORK_ADMISSION_CONFLICT',
        'This assignment already has a different Host admission fact',
        409,
      );
    acceptance.hostAdmissionHistory ??= [];
    acceptance.hostAdmissionHistory.push({ ...acceptance.hostAdmission });
  }
  if (input.disposition.state === 'admitted') {
    requireRegisteredWorkGrant(
      state,
      { ...input, catId: work.assignment.catId, requestKind: acceptance.requestKind },
      requireWorkSource(state, input.collectiveId, acceptance.sourceEventId),
      now,
      false,
    );
  }
  acceptance.hostAdmission = { ...input.disposition, issuer: 'host', at: new Date(now).toISOString() };
  if (work.executionAuthority?.revision === 1 && work.acceptance && !work.acceptance.hostAdmission)
    work.acceptance.hostAdmission = { ...acceptance.hostAdmission };
  return projectCollectiveWork(state, work, now);
}
