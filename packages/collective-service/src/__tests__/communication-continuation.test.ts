import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectiveWorkProjectionSchema } from '@cat-cafe/shared';
import { expect, it } from 'vitest';
import { startCollectiveServer } from '../http-server.js';
import { participationFixture } from './participation-fixture.js';

it('a fresh authorized continuation preserves the Work and assignment, fences older authority, and replays only that operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'f290-continuation-'));
  const fixture = await participationFixture(directory);
  const { store, owner, coordinates, connection } = fixture;
  const invite = await store.createInvite({ sessionToken: owner.sessionToken, collectiveId: coordinates.collectiveId });
  const attempt = await store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const completion = await store.completeHumanAuth({ provider: 'github', state: attempt.state, code: 'requester' });
  const requester = await store.exchangeHumanAuthCompletion(completion.completionToken);
  const scope = {
    grantRef: 'guides',
    catIds: ['codex-sol'],
    channelIds: ['general'],
    requestingHumanIds: 'channel_members',
    requestKinds: ['guide'],
    expiresAt: null,
  };
  const policy = {
    ...coordinates,
    connectionId: connection.connectionId,
    expectedRevision: 0,
    requestId: 'policy-1',
    decisionMode: 'automatic',
    grants: [scope],
  };
  await store.publishParticipation(connection.endpointCredential, {
    ...coordinates,
    connectionId: connection.connectionId,
    revision: 1,
    agents: [{ catId: 'codex-sol', displayName: 'Sol', channelIds: ['general'] }],
  });
  const recipient = {
    kind: 'agent' as const,
    humanId: owner.human.humanId,
    connectionId: connection.connectionId,
    agentId: 'codex-sol',
    participationRevision: 1,
  };
  const source = await store.postHumanMessage(requester.sessionToken, {
    ...coordinates,
    clientEventId: 'initial',
    location: { channelId: 'general' },
    recipient,
    body: 'Prepare a guide.',
  });
  await store.registerCollectiveWorkPolicy(owner.sessionToken, policy);
  let work = await store.acceptCollectiveWorkAsAgent(connection.endpointCredential, {
    ...coordinates,
    connectionId: connection.connectionId,
    sourceEventId: source.eventId,
    requestId: 'accept-1',
    catId: 'codex-sol',
    participationRevision: 1,
    sessionRef: 'turn-1',
    grantRef: 'guides',
    grantRevision: 1,
    requestKind: 'guide',
    title: 'Guide',
    intendedOutcome: source.body,
  });
  work = await store.recordCollectiveWorkHostAdmission(connection.endpointCredential, {
    ...coordinates,
    connectionId: connection.connectionId,
    workId: work.workId,
    assignmentEventId: work.assignmentEventId,
    operationRef: 'accept-1',
    grantRef: 'guides',
    grantRevision: 1,
    disposition: { state: 'admitted', receiptRef: 'host:fixture-first-task' },
  });
  await store.revokeCollectiveWorkPolicy(connection.endpointCredential, {
    ...coordinates,
    connectionId: connection.connectionId,
    expectedRevision: 1,
    requestId: 'withdraw',
    grantRefs: ['guides'],
  });
  const registered = await store.registerCollectiveWorkPolicy(owner.sessionToken, {
    ...policy,
    expectedRevision: 2,
    requestId: 'policy-3',
  });
  expect(registered.grants[0]?.grantRevision).toBe(3);
  await store.publishParticipation(connection.endpointCredential, {
    ...coordinates,
    connectionId: connection.connectionId,
    revision: 2,
    agents: [],
  });
  await store.publishParticipation(connection.endpointCredential, {
    ...coordinates,
    connectionId: connection.connectionId,
    revision: 3,
    agents: [{ catId: 'codex-sol', displayName: 'Sol', channelIds: ['general'] }],
  });
  const feedback = await store.postHumanMessage(requester.sessionToken, {
    ...coordinates,
    clientEventId: 'feedback',
    location: { channelId: 'general' },
    recipient: { ...recipient, participationRevision: 3 },
    replyToEventId: work.assignmentEventId,
    body: 'Continue with a short example.',
  });
  const server = await startCollectiveServer({ store, host: '127.0.0.1', port: 0 });
  const input = {
    ...coordinates,
    connectionId: connection.connectionId,
    workId: work.workId,
    expectedRevision: work.revision,
    sourceEventId: feedback.eventId,
    requestId: 'continue-1',
    catId: 'codex-sol',
    participationRevision: 3,
    sessionRef: 'turn-2',
    grantRef: 'guides',
    grantRevision: 3,
    requestKind: 'guide',
    kind: 'resume',
  };
  const post = (body: object) =>
    fetch(`${server.url}/api/collaboration/work/continue-agent`, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.endpointCredential}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    const routing = await fetch(`${server.url}/api/collaboration/work/routing-context`, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.endpointCredential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...coordinates, connectionId: connection.connectionId, sourceEventId: feedback.eventId }),
    });
    expect(routing.status, await routing.clone().text()).toBe(200);
    expect(await routing.json()).toMatchObject({
      relatedWorkIds: [work.workId],
      matters: [{ workId: work.workId, assignment: { catId: 'codex-sol' } }],
    });
    const sourceContext = await fetch(`${server.url}/api/collaboration/work/source-context`, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.endpointCredential}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...coordinates,
        connectionId: connection.connectionId,
        sourceEventId: feedback.eventId,
        catId: 'codex-sol',
        participationRevision: 3,
      }),
    });
    expect(sourceContext.status, await sourceContext.clone().text()).toBe(200);
    expect(await sourceContext.json()).toMatchObject({
      sourceEventId: feedback.eventId,
      relatedWorkIds: [work.workId],
      matters: [{ workId: work.workId }],
    });
    const response = await post(input);
    expect(response.status, await response.clone().text()).toBe(201);
    const continued = collectiveWorkProjectionSchema.parse(await response.json());
    expect(continued).toMatchObject({
      workId: work.workId,
      assignmentEventId: work.assignmentEventId,
      assignment: work.assignment,
      acceptance: work.acceptance,
      executionAuthority: {
        revision: 2,
        grantRevision: 3,
        sourceEventId: feedback.eventId,
        operationRef: input.requestId,
      },
    });
    expect(await (await post(input)).json()).toEqual(continued);
    const duplicate = await post({ ...input, requestId: 'rerolled-operation', expectedRevision: continued.revision });
    expect(duplicate.status, await duplicate.clone().text()).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: 'COLLABORATION_OPERATION_CONFLICT' } });
    const stale = await post({ ...input, requestId: 'continue-stale', grantRevision: 1 });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ error: { code: 'WORK_DELEGATION_UNAVAILABLE' } });
    const works = store.listCollectiveCollaboration(owner.sessionToken, coordinates.collectiveId).works;
    expect(works).toHaveLength(1);
    expect(works[0]?.history.filter((entry) => entry.action === 'committed')).toHaveLength(1);
    expect(continued.accountableHumanId).toBe(owner.human.humanId);
    expect(continued.accountableHumanId).not.toBe(requester.human.humanId);
    expect(continued.executionAuthority).toBeDefined();
    const notice = store.readParticipationContext(connection.endpointCredential, {
      ...coordinates,
      connectionId: connection.connectionId,
      catId: 'codex-sol',
      participationRevision: 3,
      eventId: continued.executionAuthority?.eventId,
    }).source;
    expect(notice).toMatchObject({
      actor: { kind: 'agent' },
      workRequest: 'continue',
      workExecutionNotice: { workId: work.workId, revision: 2 },
    });
    const result = {
      ...coordinates,
      connectionId: connection.connectionId,
      clientEventId: 'result-current',
      participationRevision: 3,
      agent: { catId: 'codex-sol', agentId: 'codex-sol', displayName: 'Sol', sessionRef: 'fixture-private-turn' },
      target: { kind: 'message', eventId: work.assignmentEventId },
      replyToEventId: work.assignmentEventId,
      workResultIntent: {
        assignmentEventId: work.assignmentEventId,
        assignmentCatId: 'codex-sol',
        participationRevision: 3,
        resultRevision: 1,
        executionRevision: 2,
      },
      body: 'Guide with a short example.',
    };
    await expect(
      store.postAgentMessage(connection.endpointCredential, {
        ...result,
        workResultIntent: { ...result.workResultIntent, executionRevision: 1 },
      }),
    ).rejects.toMatchObject({ code: 'WORK_EXECUTION_NOT_CURRENT' });
    await expect(store.postAgentMessage(connection.endpointCredential, result)).rejects.toMatchObject({
      code: 'WORK_ADMISSION_NOT_CURRENT',
    });
    await store.recordCollectiveWorkHostAdmission(connection.endpointCredential, {
      ...coordinates,
      connectionId: connection.connectionId,
      workId: work.workId,
      assignmentEventId: work.assignmentEventId,
      executionRevision: 2,
      operationRef: input.requestId,
      grantRef: 'guides',
      grantRevision: 3,
      disposition: { state: 'admitted', receiptRef: 'host:fixture-current-task-execution' },
    });
    const { workResultIntent, ...progressBase } = result;
    const progressInput = {
      ...progressBase,
      clientEventId: 'progress-current',
      body: 'The short example is being checked.',
      workProgressIntent: workResultIntent,
    };
    const progress = await store.postAgentMessage(connection.endpointCredential, progressInput);
    expect(progress.workResultReceipt).toBeUndefined();
    expect(progress.workProgressReceipt).toMatchObject({ workId: work.workId, executionRevision: 2 });
    expect(await store.postAgentMessage(connection.endpointCredential, progressInput)).toEqual(progress);
    expect(store.listCollectiveCollaboration(owner.sessionToken, coordinates.collectiveId).works[0]).toMatchObject({
      lifecycle: 'in_progress',
      history: expect.arrayContaining([{ ...continued.history.at(-1), action: 'execution_authorized' }]),
    });
    expect(
      store.listCollectiveCollaboration(owner.sessionToken, coordinates.collectiveId).works[0]?.resultEventId,
    ).toBeUndefined();
    await expect(
      store.postAgentMessage(connection.endpointCredential, {
        ...progressInput,
        clientEventId: 'old-progress',
        workProgressIntent: { ...workResultIntent, executionRevision: 1 },
      }),
    ).rejects.toMatchObject({ code: 'WORK_EXECUTION_NOT_CURRENT' });
    const published = await store.postAgentMessage(connection.endpointCredential, result);
    expect(published.workResultReceipt).toMatchObject({
      workId: work.workId,
      assignmentEventId: work.assignmentEventId,
      executionRevision: 2,
    });
    const { workResultIntent: _intent, ...ordinaryReply } = result;
    await expect(
      store.postAgentMessage(connection.endpointCredential, { ...ordinaryReply, clientEventId: 'old-public-reply' }),
    ).rejects.toMatchObject({ code: 'PARTICIPATION_REVOKED' });
    expect(store.listCollectiveCollaboration(owner.sessionToken, coordinates.collectiveId).works[0]).toMatchObject({
      lifecycle: 'result_ready',
      resultRevision: 1,
      acceptance: work.acceptance,
    });
    const resultReady = store.listCollectiveCollaboration(owner.sessionToken, coordinates.collectiveId).works[0];
    if (!resultReady) throw new Error('Expected the same current Work');
    const revised = await store.requestCollectiveWorkRevision(owner.sessionToken, {
      ...coordinates,
      workId: work.workId,
      expectedRevision: resultReady.revision,
      requestId: 'human-revision-after-regrant',
      resultEventId: published.eventId,
      resultRevision: 1,
      feedback: 'Add one more verified detail.',
    });
    expect(revised.executionAuthority).toMatchObject({ revision: 2, participationRevision: 3, resultRevision: 2 });
    const feedbackEvents = await store.listEventsForHuman(owner.sessionToken, coordinates.collectiveId);
    expect(feedbackEvents.at(-1)?.recipient).toMatchObject({ kind: 'agent', participationRevision: 3 });
    await expect(
      store.postAgentMessage(connection.endpointCredential, { ...result, clientEventId: 'old-round-return' }),
    ).rejects.toMatchObject({ code: 'WORK_RESULT_REVISION_CONFLICT' });
    const v2 = await store.postAgentMessage(connection.endpointCredential, {
      ...result,
      clientEventId: 'result-v2',
      workResultIntent: { ...result.workResultIntent, resultRevision: 2 },
      body: 'Guide v2 with the verified detail.',
    });
    expect(v2.workResultReceipt).toMatchObject({ executionRevision: 2, resultRevision: 2 });
  } finally {
    await server.close();
    await rm(directory, { recursive: true });
  }
});
