import { isDeepStrictEqual } from 'node:util';
import type { CollectiveWorkHostAdmissionRequest } from '@cat-cafe/shared';
import { participationError } from './participation-custody.js';
import type { ConnectorWorkCustody } from './work-custody-state.js';

export function hostAdmissionRequestMatches(
  left: CollectiveWorkHostAdmissionRequest,
  right: CollectiveWorkHostAdmissionRequest,
) {
  return isDeepStrictEqual(
    { ...left, executionRevision: left.executionRevision ?? 1 },
    { ...right, executionRevision: right.executionRevision ?? 1 },
  );
}

/** Preserve local admission facts while a scoped rejection contracts the same current execution. */
export function prepareHostAdmission(custody: ConnectorWorkCustody, request: CollectiveWorkHostAdmissionRequest) {
  const previous = custody.hostAdmissions.filter(
    (operation) =>
      operation.request.assignmentEventId === request.assignmentEventId &&
      (operation.request.executionRevision ?? 1) === (request.executionRevision ?? 1),
  );
  if (previous.some((operation) => hostAdmissionRequestMatches(operation.request, request))) return;
  const { disposition: _disposition, ...binding } = request;
  if (
    previous.some((operation) => {
      const { disposition: _previousDisposition, ...previousBinding } = operation.request;
      return !isDeepStrictEqual(
        { ...binding, executionRevision: binding.executionRevision ?? 1 },
        { ...previousBinding, executionRevision: previousBinding.executionRevision ?? 1 },
      );
    }) ||
    (previous.length > 0 &&
      (request.disposition.state !== 'rejected' ||
        previous.some((operation) => operation.request.disposition.state !== 'admitted')))
  )
    throw participationError(
      'WORK_ADMISSION_CONFLICT',
      'An exact execution already has a different Host admission fact',
    );
  for (const operation of previous) {
    if (operation.status === 'pending') {
      operation.status = 'blocked';
      operation.failureCode = 'WORK_ADMISSION_SUPERSEDED';
    }
  }
  custody.hostAdmissions.push({ request, status: 'pending' });
}
