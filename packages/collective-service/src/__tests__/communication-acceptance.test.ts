import { expect, it } from 'vitest';
import { CollectiveServiceStore } from '../store.js';
import { fixture } from './communication-acceptance.fixture.js';

it('projects pending or rejected Host admission as blocked, retains first admission and forbids same-execution revival', async () => {
  const f = await fixture();
  await f.store.registerCollectiveWorkPolicy(f.owner.sessionToken, f.policyInput);
  const work = await f.store.acceptCollectiveWorkAsAgent(f.connection.endpointCredential, f.acceptance);
  expect(work.status).toBe('blocked');
  const binding = {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    workId: work.workId,
    assignmentEventId: work.assignmentEventId,
    operationRef: f.acceptance.requestId,
    grantRef: 'grant-guides',
    grantRevision: 1,
  };
  const admitted = await f.store.recordCollectiveWorkHostAdmission(f.connection.endpointCredential, {
    ...binding,
    disposition: { state: 'admitted', receiptRef: 'host:original-task' },
  });
  expect(admitted.status).toBe('ready');
  const rejection = {
    ...binding,
    disposition: { state: 'rejected', receiptRef: 'host:withdrawn', reason: 'WORK_DELEGATION_UNAVAILABLE' },
  };
  const rejected = await f.store.recordCollectiveWorkHostAdmission(f.connection.endpointCredential, rejection);
  expect(rejected).toMatchObject({
    status: 'blocked',
    lifecycle: 'committed',
    acceptance: { hostAdmission: { state: 'admitted', receiptRef: 'host:original-task' } },
    executionAuthority: {
      hostAdmission: { state: 'rejected' },
      hostAdmissionHistory: [admitted.executionAuthority?.hostAdmission],
    },
  });
  expect(await f.store.recordCollectiveWorkHostAdmission(f.connection.endpointCredential, rejection)).toEqual(rejected);
  await expect(
    f.store.recordCollectiveWorkHostAdmission(f.connection.endpointCredential, {
      ...binding,
      disposition: { state: 'admitted', receiptRef: 'host:original-task' },
    }),
  ).rejects.toMatchObject({ code: 'WORK_ADMISSION_NOT_CURRENT' });
  const reopened = await CollectiveServiceStore.open({
    dataDirectory: f.directory,
    humanAuthProvider: f.humanAuthProvider,
  });
  expect(reopened.store.listCollectiveCollaboration(f.owner.sessionToken, f.coordinates.collectiveId).works[0]).toEqual(
    rejected,
  );
});

it('requires the actual Host admission fact and current grant again before publishing an accepted Work result', async () => {
  const current = await fixture();
  await current.store.registerCollectiveWorkPolicy(current.owner.sessionToken, current.policyInput);
  const work = await current.store.acceptCollectiveWorkAsAgent(
    current.connection.endpointCredential,
    current.acceptance,
  );
  const result = {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    clientEventId: 'result-not-authority',
    participationRevision: 1,
    agent: { agentId: 'codex-sol', catId: 'codex-sol', displayName: 'Sol', sessionRef: 'fixture-result-turn' },
    target: { kind: 'message', eventId: work.assignmentEventId },
    replyToEventId: work.assignmentEventId,
    workResultIntent: {
      assignmentEventId: work.assignmentEventId,
      assignmentCatId: 'codex-sol',
      participationRevision: 1,
      resultRevision: 1,
    },
    body: 'Completed guide',
  };
  await expect(current.store.postAgentMessage(current.connection.endpointCredential, result)).rejects.toMatchObject({
    code: 'WORK_ADMISSION_NOT_CURRENT',
  });
  await current.store.recordCollectiveWorkHostAdmission(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    workId: work.workId,
    assignmentEventId: work.assignmentEventId,
    operationRef: current.acceptance.requestId,
    grantRef: 'grant-guides',
    grantRevision: 1,
    disposition: { state: 'admitted', receiptRef: 'host:fixture-actual-task' },
  });
  await current.store.revokeCollectiveWorkPolicy(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    expectedRevision: 1,
    requestId: 'revoke-before-publication',
    grantRefs: ['grant-guides'],
  });
  await expect(current.store.postAgentMessage(current.connection.endpointCredential, result)).rejects.toMatchObject({
    code: 'WORK_DELEGATION_UNAVAILABLE',
  });
  expect(
    current.store.listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId).works[0]
      ?.lifecycle,
  ).toBe('committed');
});

it('requires an actual owner registration, then records Cat acceptance and one current assignment without a Human click', async () => {
  const current = await fixture();
  await expect(
    current.store.acceptCollectiveWorkAsAgent(current.connection.endpointCredential, current.acceptance),
  ).rejects.toMatchObject({ code: 'WORK_DELEGATION_UNAVAILABLE' });
  await expect(
    current.store.registerCollectiveWorkPolicy(current.connection.endpointCredential, current.policyInput),
  ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  const policy = await current.store.registerCollectiveWorkPolicy(current.owner.sessionToken, current.policyInput);
  expect(policy).toMatchObject({ ownerHumanId: current.owner.human.humanId, revision: 1, decisionMode: 'automatic' });
  const accepted = await current.store.acceptCollectiveWorkAsAgent(
    current.connection.endpointCredential,
    current.acceptance,
  );
  expect(accepted).toMatchObject({
    lifecycle: 'committed',
    accountableHumanId: current.owner.human.humanId,
    proposedBy: { kind: 'agent', catId: 'codex-sol' },
    assignment: { catId: 'codex-sol', humanId: current.owner.human.humanId },
    acceptance: { grantRef: 'grant-guides', grantRevision: 1, sourceEventId: current.source.eventId },
  });
  expect(accepted.history.at(-1)?.actor).toMatchObject({ kind: 'agent', catId: 'codex-sol' });
  const context = current.store.readParticipationContext(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    catId: 'codex-sol',
    participationRevision: 1,
    eventId: accepted.assignmentEventId,
  });
  expect(context.source).toMatchObject({
    actor: { kind: 'agent', agent: { agentId: 'codex-sol' } },
    workRequest: 'entrust',
    workAcceptanceNotice: { workId: accepted.workId, grantRef: 'grant-guides' },
  });
  expect(
    await current.store.acceptCollectiveWorkAsAgent(current.connection.endpointCredential, current.acceptance),
  ).toMatchObject({ workId: accepted.workId, assignmentEventId: accepted.assignmentEventId });
  const reopened = await CollectiveServiceStore.open({
    dataDirectory: current.directory,
    humanAuthProvider: current.humanAuthProvider,
  });
  expect(
    await reopened.store.acceptCollectiveWorkAsAgent(current.connection.endpointCredential, current.acceptance),
  ).toMatchObject({ workId: accepted.workId, assignmentEventId: accepted.assignmentEventId });
  const works = reopened.store.listCollectiveCollaboration(
    current.owner.sessionToken,
    current.coordinates.collectiveId,
  ).works;
  expect(works).toHaveLength(1);
});

it('keeps manual decision separate from scope, and rejects stale, revoked and widened permissions', async () => {
  const current = await fixture();
  await current.store.registerCollectiveWorkPolicy(current.owner.sessionToken, {
    ...current.policyInput,
    decisionMode: 'manual',
  });
  await expect(
    current.store.acceptCollectiveWorkAsAgent(current.connection.endpointCredential, current.acceptance),
  ).rejects.toMatchObject({ code: 'WORK_OWNER_DECISION_REQUIRED' });
  const policy = await current.store.registerCollectiveWorkPolicy(current.owner.sessionToken, {
    ...current.policyInput,
    expectedRevision: 1,
    requestId: 'owner-allows-once',
    decisionMode: 'manual',
    grants: [{ ...current.policyInput.grants[0], sourceEventIds: [current.source.eventId] }],
  });
  expect(policy.grants[0]?.grantRevision).toBe(2);
  await expect(
    current.store.acceptCollectiveWorkAsAgent(current.connection.endpointCredential, current.acceptance),
  ).rejects.toMatchObject({ code: 'WORK_DELEGATION_UNAVAILABLE' });
  await expect(
    current.store.acceptCollectiveWorkAsAgent(current.connection.endpointCredential, {
      ...current.acceptance,
      grantRevision: 2,
      requestKind: 'code',
    }),
  ).rejects.toMatchObject({ code: 'WORK_DELEGATION_UNAVAILABLE' });
  const accepted = await current.store.acceptCollectiveWorkAsAgent(current.connection.endpointCredential, {
    ...current.acceptance,
    grantRevision: 2,
  });
  await current.store.revokeCollectiveWorkPolicy(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    expectedRevision: 2,
    requestId: 'host-revocation',
    grantRefs: ['grant-guides'],
  });
  await expect(
    current.store.acceptCollectiveWorkAsAgent(current.connection.endpointCredential, {
      ...current.acceptance,
      grantRevision: 2,
    }),
  ).rejects.toMatchObject({ code: 'WORK_DELEGATION_UNAVAILABLE' });
  expect(
    current.store.listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId).works,
  ).toMatchObject([{ workId: accepted.workId }]);
});

it('recovers a scoped Host admission receipt without exposing a private Task or duplicating acceptance', async () => {
  const current = await fixture();
  await current.store.registerCollectiveWorkPolicy(current.owner.sessionToken, current.policyInput);
  const accepted = await current.store.acceptCollectiveWorkAsAgent(
    current.connection.endpointCredential,
    current.acceptance,
  );
  const input = {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    workId: accepted.workId,
    assignmentEventId: accepted.assignmentEventId,
    operationRef: current.acceptance.requestId,
    grantRef: 'grant-guides',
    grantRevision: 1,
    disposition: { state: 'admitted', receiptRef: 'host-admission:opaque-proof' },
  };
  const recorded = await current.store.recordCollectiveWorkHostAdmission(current.connection.endpointCredential, input);
  expect(recorded).toMatchObject({
    acceptance: { hostAdmission: { issuer: 'host', state: 'admitted', receiptRef: input.disposition.receiptRef } },
  });
  const reopened = await CollectiveServiceStore.open({
    dataDirectory: current.directory,
    humanAuthProvider: current.humanAuthProvider,
  });
  expect(await reopened.store.recordCollectiveWorkHostAdmission(current.connection.endpointCredential, input)).toEqual(
    recorded,
  );
  await expect(
    reopened.store.recordCollectiveWorkHostAdmission(current.connection.endpointCredential, {
      ...input,
      assignmentEventId: current.source.eventId,
    }),
  ).rejects.toMatchObject({ code: 'WORK_ADMISSION_NOT_CURRENT' });
  await expect(
    reopened.store.recordCollectiveWorkHostAdmission(current.connection.endpointCredential, {
      ...input,
      disposition: { ...input.disposition, taskId: 'private-task' },
    }),
  ).rejects.toBeDefined();
});

it('preserves the committed Work but records refusal when scope is withdrawn before private admission', async () => {
  const current = await fixture();
  await current.store.registerCollectiveWorkPolicy(current.owner.sessionToken, current.policyInput);
  const accepted = await current.store.acceptCollectiveWorkAsAgent(
    current.connection.endpointCredential,
    current.acceptance,
  );
  await current.store.revokeCollectiveWorkPolicy(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    expectedRevision: 1,
    requestId: 'revoke-before-host',
    grantRefs: ['grant-guides'],
  });
  const input = {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    workId: accepted.workId,
    assignmentEventId: accepted.assignmentEventId,
    operationRef: current.acceptance.requestId,
    grantRef: 'grant-guides',
    grantRevision: 1,
    disposition: { state: 'admitted', receiptRef: 'host-admission:exact-proof' },
  };
  await expect(
    current.store.recordCollectiveWorkHostAdmission(current.connection.endpointCredential, input),
  ).rejects.toMatchObject({ code: 'WORK_DELEGATION_UNAVAILABLE' });
  const refused = await current.store.recordCollectiveWorkHostAdmission(current.connection.endpointCredential, {
    ...input,
    disposition: {
      state: 'rejected',
      receiptRef: 'host-admission:refusal',
      reason: 'Owner withdrew scope before admission',
    },
  });
  expect(refused).toMatchObject({
    workId: accepted.workId,
    lifecycle: 'committed',
    acceptance: { hostAdmission: { state: 'rejected' } },
  });
  expect(
    current.store.listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId).works,
  ).toHaveLength(1);
});

it('accepts the same proposed matter after an owner exception instead of creating another Work', async () => {
  const current = await fixture();
  const proposed = await current.store.proposeCollectiveWorkAsAgent(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    sourceEventId: current.source.eventId,
    participationRevision: 1,
    catId: 'codex-sol',
    requestId: 'pending-owner-decision',
    title: current.acceptance.title,
    intendedOutcome: current.acceptance.intendedOutcome,
  });
  await current.store.registerCollectiveWorkPolicy(current.owner.sessionToken, current.policyInput);
  const accepted = await current.store.acceptCollectiveWorkAsAgent(
    current.connection.endpointCredential,
    current.acceptance,
  );
  expect(accepted).toMatchObject({ workId: proposed.workId, lifecycle: 'committed' });
  expect(
    current.store.listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId).works,
  ).toHaveLength(1);
});
