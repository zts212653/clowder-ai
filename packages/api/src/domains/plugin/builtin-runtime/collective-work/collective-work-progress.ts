import type { CollectiveConnector } from '@cat-cafe/collective-connector';
import type { InvocationRecord } from '../../../cats/services/agents/invocation/InvocationRegistry.js';
import type { CollectiveCurrentContext } from '../collective-current-context.js';

export async function publishCollectiveProgress(
  connector: CollectiveConnector,
  auth: InvocationRecord,
  binding: NonNullable<Awaited<ReturnType<CollectiveCurrentContext['resolvePrivate']>>> & { resultKey: string },
  body: string,
) {
  const purpose = {
    source: binding.source,
    sourceRef: binding.sourceRef,
    resultKey: binding.resultKey,
    taskRevision: binding.work.revision,
    resultRevision: binding.work.resultRevision,
    executionRevision: binding.work.executionRevision,
    assignmentEventId: binding.work.assignmentEventId,
    authorCatId: auth.catId,
    body,
  };
  const operation = await connector.prepareProgress(purpose);
  await connector.submitProgress(purpose, operation.outboxId, {
    catId: auth.catId,
    agentId: auth.catId,
    displayName: binding.displayName,
    sessionRef: auth.invocationId,
  });
  await connector.sync(binding.source.connectionId);
  const current = await connector.prepareProgress(purpose);
  const event = (await connector.listInbox(binding.source.connectionId)).find(
    (item) => item.event.eventId === current.acceptedEventId,
  )?.event;
  return {
    status: current.status,
    eventId: current.acceptedEventId,
    code: current.failureCode,
    receipt: event?.workProgressReceipt,
  };
}
