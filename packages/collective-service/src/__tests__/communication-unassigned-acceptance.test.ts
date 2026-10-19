import { expect, it } from 'vitest';
import { fixture } from './communication-acceptance.fixture.js';

it('lets an authorized Cat discover and take an accepted unassigned task without creating a second Work', async () => {
  const current = await fixture();
  const proposed = await current.store.proposeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    sourceEventId: current.source.eventId,
    requestId: 'human-project-proposal',
  });
  const unassigned = await current.store.commitCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    workId: proposed.workId,
    expectedRevision: proposed.revision,
    requestId: 'human-project-acceptance',
    accountability: 'unassigned',
  });
  const sourceContext = current.store.readCollectiveWorkSourceContext(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    sourceEventId: current.source.eventId,
    catId: 'codex-sol',
    participationRevision: 1,
  });
  expect(sourceContext.relatedWorkIds).toEqual([unassigned.workId]);
  expect(sourceContext.matters[0]).toMatchObject({
    workId: unassigned.workId,
    lifecycle: 'committed',
    status: 'unassigned',
    proposedOutcome: current.source.body,
  });
  await current.store.registerCollectiveWorkPolicy(current.owner.sessionToken, current.policyInput);

  const accepted = await current.store.acceptCollectiveWorkAsAgent(
    current.connection.endpointCredential,
    current.acceptance,
  );

  expect(accepted).toMatchObject({
    workId: unassigned.workId,
    revision: 3,
    lifecycle: 'committed',
    accountableHumanId: current.owner.human.humanId,
    assignment: { catId: 'codex-sol', humanId: current.owner.human.humanId },
  });
  expect(accepted.history.at(-1)).toMatchObject({
    action: 'accountability_assigned',
    actor: { kind: 'agent', catId: 'codex-sol' },
  });
  expect(
    current.store.readParticipationContext(current.connection.endpointCredential, {
      ...current.coordinates,
      connectionId: current.connection.connectionId,
      catId: 'codex-sol',
      participationRevision: 1,
      eventId: accepted.assignmentEventId,
    }).source,
  ).toMatchObject({
    eventId: accepted.assignmentEventId,
    workRequest: 'entrust',
    workAcceptanceNotice: { workId: accepted.workId },
  });
  expect(
    current.store.listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId).works,
  ).toHaveLength(1);
});
