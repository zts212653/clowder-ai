import type {
  CollectiveAgentMessageRequest,
  CollectiveEventEnvelope,
  CollectiveSourceIdentity,
} from '@cat-cafe/shared';
import { participationError } from './participation-custody.js';
import type { CollectiveServiceClient } from './service-client.js';
import type { ConnectorConnectionState, ConnectorOutboxItem } from './state.js';
import type { ConnectorWorkAcceptanceCustody } from './work-acceptance-custody.js';

export async function revalidateQueuedWork(
  service: CollectiveServiceClient,
  connection: ConnectorConnectionState,
  pending: ConnectorOutboxItem,
  source: CollectiveEventEnvelope,
  currentGrant?: (source: CollectiveSourceIdentity) => ReturnType<ConnectorWorkAcceptanceCustody['resolveGrant']>,
) {
  if (!pending.workPurpose || !pending.replySource) return;
  if (!['entrust', 'continue'].includes(String(source.workRequest)))
    throw participationError('RETURN_UNAVAILABLE', 'A Work result needs an exact Service execution source');
  const credential = connection.endpointCredential;
  if (!credential) throw participationError('PARTICIPATION_REVOKED', 'Current endpoint credential is unavailable');
  const assignmentEventId = pending.workPurpose.assignmentEventId ?? pending.replySource.eventId;
  const work = await service.readAssignedWorkByAssignment(connection.serviceUrl, credential, {
    serviceInstanceId: connection.serviceInstanceId,
    collectiveId: connection.collectiveId,
    connectionId: connection.connectionId,
    assignmentEventId,
  });
  const authority = work.executionAuthority;
  if (
    (authority?.revision ?? 1) !== (pending.workPurpose.executionRevision ?? 1) ||
    ((authority?.revision ?? 1) > 1 && authority?.eventId !== pending.replySource.eventId)
  )
    throw participationError('WORK_EXECUTION_NOT_CURRENT', 'Queued result belongs to an older execution authority');
  if (work.acceptance || authority) {
    if ((authority ?? work.acceptance)?.hostAdmission?.state !== 'admitted')
      throw participationError('WORK_ADMISSION_NOT_CURRENT', 'Current Work has no actual Host admission');
    await currentGrant?.(pending.replySource);
  }
}

export function workOutboundIntent(
  pending: ConnectorOutboxItem,
): Pick<CollectiveAgentMessageRequest, 'workResultIntent' | 'workProgressIntent'> {
  const purpose = pending.workPurpose;
  const source = pending.replySource;
  if (!purpose || !source) return {};
  const intent = {
    assignmentEventId: purpose.assignmentEventId ?? source.eventId,
    assignmentCatId: source.catId,
    participationRevision: source.participationRevision,
    resultRevision: purpose.resultRevision,
  };
  return purpose.progressKey
    ? { workProgressIntent: { ...intent, executionRevision: purpose.executionRevision ?? 1 } }
    : {
        workResultIntent: {
          ...intent,
          ...(purpose.executionRevision ? { executionRevision: purpose.executionRevision } : {}),
        },
      };
}

export function workOutboundReceipt(event: CollectiveEventEnvelope, pending: ConnectorOutboxItem) {
  const receipt = pending.workPurpose?.progressKey ? event.workProgressReceipt : event.workResultReceipt;
  if (
    pending.workPurpose &&
    (!receipt ||
      receipt.assignmentEventId !== (pending.workPurpose.assignmentEventId ?? pending.replySource?.eventId) ||
      (receipt.executionRevision ?? 1) !== (pending.workPurpose.executionRevision ?? 1) ||
      receipt.resultRevision !== pending.workPurpose.resultRevision)
  )
    throw new Error('Collective Service did not bind the Work output to its exact current assignment');
  return receipt;
}
