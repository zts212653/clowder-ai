import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { type RunningCollectiveServer, startCollectiveServer } from '../http-server.js';
import { participationFixture } from './participation-fixture.js';

const directories: string[] = [];
const servers: RunningCollectiveServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

it('sets and reads a persistent reaction through the canonical HTTP collaboration surface', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-reaction-http-'));
  directories.push(directory);
  const current = await participationFixture(directory);
  const source = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'reaction-http-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '把回应留在共同现场。',
  });
  const server = await startCollectiveServer({ store: current.store, host: '127.0.0.1', port: 0 });
  servers.push(server);

  const set = await fetch(`${server.url}/api/collaboration/reactions/set`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${current.owner.sessionToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ...current.coordinates,
      requestId: 'reaction-http-set',
      eventId: source.eventId,
      emoji: '👀',
      active: true,
    }),
  });
  expect(set.status).toBe(200);
  await expect(set.json()).resolves.toMatchObject({
    eventId: source.eventId,
    emoji: '👀',
    humanIds: [current.owner.human.humanId],
  });

  const read = await fetch(
    `${server.url}/api/collaboration?collectiveId=${encodeURIComponent(current.coordinates.collectiveId)}`,
    { headers: { authorization: `Bearer ${current.owner.sessionToken}` } },
  );
  expect(read.status).toBe(200);
  await expect(read.json()).resolves.toMatchObject({
    reactions: [{ eventId: source.eventId, emoji: '👀', humanIds: [current.owner.human.humanId] }],
  });
});

it('requests an exact next result revision through the canonical HTTP collaboration surface', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-revision-http-'));
  directories.push(directory);
  const current = await participationFixture(directory);
  await current.store.publishParticipation(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    revision: 1,
    agents: [{ catId: 'codex-sol', displayName: 'Sol', channelIds: ['general'] }],
  });
  const source = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'revision-http-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: 'Return a reviewable result here.',
  });
  const proposed = await current.store.proposeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    sourceEventId: source.eventId,
    requestId: 'revision-http-proposal',
  });
  const committed = await current.store.commitCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    workId: proposed.workId,
    expectedRevision: proposed.revision,
    requestId: 'revision-http-commit',
    assignment: {
      connectionId: current.connection.connectionId,
      catId: 'codex-sol',
      participationRevision: 1,
    },
  });
  const firstResult = await current.store.postAgentMessage(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    clientEventId: 'revision-http-result-v1',
    agent: {
      agentId: 'codex-sol',
      catId: 'codex-sol',
      displayName: 'Sol',
      sessionRef: 'invocation:revision-http-v1',
    },
    target: { kind: 'message', eventId: source.eventId },
    location: { channelId: 'general', rootEventId: source.eventId },
    recipient: { kind: 'channel' },
    participationRevision: 1,
    replyToEventId: committed.assignmentEventId,
    workResultIntent: {
      assignmentEventId: committed.assignmentEventId,
      participationRevision: 1,
      resultRevision: 1,
    },
    body: 'First result.',
  });
  const ready = current.store
    .listCollectiveCollaboration(current.owner.sessionToken, current.coordinates.collectiveId)
    .works.find((work) => work.workId === committed.workId);
  if (!ready) throw new Error('Expected the first result to be current');

  const server = await startCollectiveServer({ store: current.store, host: '127.0.0.1', port: 0 });
  servers.push(server);
  const request = {
    ...current.coordinates,
    workId: committed.workId,
    expectedRevision: ready.revision,
    resultEventId: firstResult.eventId,
    resultRevision: 1,
    feedback: 'Please add restart evidence.',
    requestId: 'revision-http-request-v2',
  };
  const response = await fetch(`${server.url}/api/collaboration/work/result/revision`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${current.owner.sessionToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    workId: committed.workId,
    lifecycle: 'in_progress',
    resultEventId: firstResult.eventId,
    resultRevision: 1,
  });

  const feedback = (
    await current.store.listEventsForHuman(current.owner.sessionToken, current.coordinates.collectiveId)
  ).find((event) => event.workRequest === 'revise');
  expect(feedback).toMatchObject({
    body: request.feedback,
    replyToEventId: firstResult.eventId,
    workRevisionNotice: {
      workId: committed.workId,
      assignmentEventId: committed.assignmentEventId,
      resultEventId: firstResult.eventId,
      resultRevision: 1,
    },
  });
});
