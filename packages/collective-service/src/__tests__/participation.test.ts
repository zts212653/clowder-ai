import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CollectiveServiceStore } from '../store.js';
import { participationFixture } from './participation-fixture.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'collective-participation-'));
  directories.push(directory);
  return { directory, ...(await participationFixture(directory)) };
}

it('persists public location independently from the recipient, preserving exact reply roots', async () => {
  const f = await fixture();
  const root = await f.store.postHumanMessage(f.owner.sessionToken, {
    ...f.coordinates,
    clientEventId: 'root-a',
    target: { kind: 'channel', channelId: 'a' },
    body: 'A root',
  });
  expect(root).toMatchObject({ location: { channelId: 'a' }, recipient: { kind: 'channel' } });
  const reply = await f.store.postHumanMessage(f.owner.sessionToken, {
    ...f.coordinates,
    clientEventId: 'reply-a',
    target: { kind: 'message', eventId: root.eventId },
    body: 'A reply',
  });
  expect(reply).toMatchObject({
    location: { channelId: 'a', rootEventId: root.eventId },
    recipient: { kind: 'channel' },
  });
  const reopened = await CollectiveServiceStore.open({ dataDirectory: f.directory });
  expect(await reopened.store.listEventsForHuman(f.owner.sessionToken, f.coordinates.collectiveId)).toEqual([
    root,
    reply,
  ]);
});

it('rejects cross-channel replies and directed requests with no provable public location', async () => {
  const f = await fixture();
  const root = await f.store.postHumanMessage(f.owner.sessionToken, {
    ...f.coordinates,
    clientEventId: 'a',
    target: { kind: 'channel', channelId: 'a' },
    body: 'A',
  });
  await expect(
    f.store.postHumanMessage(f.owner.sessionToken, {
      ...f.coordinates,
      clientEventId: 'forged',
      target: { kind: 'channel', channelId: 'b' },
      replyToEventId: root.eventId,
      body: 'Cross-channel',
    }),
  ).rejects.toMatchObject({ code: 'COORDINATE_MISMATCH' });
  await expect(
    f.store.postHumanMessage(f.owner.sessionToken, {
      ...f.coordinates,
      clientEventId: 'no-location',
      target: { kind: 'human', humanId: f.connection.authorizedHumanId },
      body: 'Unknown location',
    }),
  ).rejects.toMatchObject({ code: 'LOCATION_REQUIRED' });
});

it('keeps same-name cats on two endpoints distinct and refuses stale declaration resurrection', async () => {
  const f = await fixture();
  const second = await f.pair();
  for (const connection of [f.connection, second]) {
    await f.store.publishParticipation(connection.endpointCredential, {
      ...f.coordinates,
      connectionId: connection.connectionId,
      revision: 1,
      agents: [{ catId: 'opus', displayName: 'Same name', channelIds: ['a'] }],
    });
  }
  const members = await f.store.listParticipants(f.owner.sessionToken, f.coordinates.collectiveId);
  expect(members).toHaveLength(2);
  expect(new Set(members.map((member) => member.connectionId)).size).toBe(2);
  const recipient = {
    kind: 'agent',
    humanId: f.connection.authorizedHumanId,
    agentId: 'opus',
    connectionId: f.connection.connectionId,
    participationRevision: 1,
  };
  const request = await f.store.postHumanMessage(f.owner.sessionToken, {
    ...f.coordinates,
    clientEventId: 'request',
    location: { channelId: 'a' },
    recipient,
    body: 'Please answer',
  });
  expect(request.recipient).toEqual(recipient);
  await f.store.publishParticipation(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    revision: 2,
    agents: [],
  });
  await expect(
    f.store.publishParticipation(f.connection.endpointCredential, {
      ...f.coordinates,
      connectionId: f.connection.connectionId,
      revision: 1,
      agents: [{ catId: 'opus', displayName: 'Same name', channelIds: ['a'] }],
    }),
  ).rejects.toMatchObject({ code: 'PARTICIPATION_REVISION_CONFLICT' });
  await expect(
    f.store.postHumanMessage(f.owner.sessionToken, {
      ...f.coordinates,
      clientEventId: 'after-revoke',
      location: { channelId: 'a' },
      recipient,
      body: 'No new wake',
    }),
  ).rejects.toMatchObject({ code: 'PARTICIPATION_REVOKED' });
  expect(await readFile(join(f.directory, 'collective-service.json'), 'utf8')).toContain(request.eventId);
});

it('migrates only provable legacy locations and never reconstructs an ambiguous cat recipient', async () => {
  const f = await fixture();
  const root = await f.store.postHumanMessage(f.owner.sessionToken, {
    ...f.coordinates,
    clientEventId: 'root',
    target: { kind: 'channel', channelId: 'a' },
    body: 'Root',
  });
  const reply = await f.store.postHumanMessage(f.owner.sessionToken, {
    ...f.coordinates,
    clientEventId: 'reply',
    target: { kind: 'message', eventId: root.eventId },
    body: 'Reply',
  });
  const path = join(f.directory, 'collective-service.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  state.events[f.coordinates.collectiveId] = [
    { ...root, location: undefined, recipient: undefined },
    { ...reply, location: undefined, recipient: undefined },
    {
      ...root,
      eventId: 'evt_legacyunknown',
      sequence: 3,
      clientEventId: 'unknown',
      location: undefined,
      recipient: undefined,
      target: { kind: 'agent', humanId: f.connection.authorizedHumanId, agentId: 'opus' },
    },
  ];
  await writeFile(path, JSON.stringify(state));
  const reopened = await CollectiveServiceStore.open({ dataDirectory: f.directory });
  const events = await reopened.store.listEventsForHuman(f.owner.sessionToken, f.coordinates.collectiveId);
  expect(events[0]).toMatchObject({ location: { channelId: 'a' }, recipient: { kind: 'channel' } });
  expect(events[1]).toMatchObject({ location: { channelId: 'a', rootEventId: root.eventId } });
  expect(events[2]?.location).toBeUndefined();
  expect(events[2]?.recipient).toBeUndefined();
  const persisted = JSON.parse(await readFile(path, 'utf8')).events[f.coordinates.collectiveId];
  expect(persisted).toEqual(events);
});

it('revalidates the requesting Human membership after restart before disclosing scoped context', async () => {
  const f = await fixture();
  const invite = await f.store.createInvite({
    sessionToken: f.owner.sessionToken,
    collectiveId: f.coordinates.collectiveId,
  });
  const attempt = await f.store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const completed = await f.store.completeHumanAuth({ provider: 'github', state: attempt.state, code: 'guest' });
  const guest = await f.store.exchangeHumanAuthCompletion(completed.completionToken);
  await f.store.publishParticipation(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    revision: 1,
    agents: [{ catId: 'opus', displayName: 'Opus', channelIds: ['a'] }],
  });
  const request = await f.store.postHumanMessage(guest.sessionToken, {
    ...f.coordinates,
    clientEventId: 'guest-request',
    location: { channelId: 'a' },
    body: 'Read authorized A',
    recipient: {
      kind: 'agent',
      humanId: f.connection.authorizedHumanId,
      agentId: 'opus',
      connectionId: f.connection.connectionId,
      participationRevision: 1,
    },
  });
  const input = {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    catId: 'opus',
    participationRevision: 1,
    eventId: request.eventId,
  };
  expect(f.store.readParticipationContext(f.connection.endpointCredential, input).source).toEqual(request);
  const path = join(f.directory, 'collective-service.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  const human = (await f.store.getHumanProjection(guest.sessionToken)).human;
  delete state.memberships[`${f.coordinates.collectiveId}:${human.humanId}`];
  await writeFile(path, JSON.stringify(state));
  const reopened = await CollectiveServiceStore.open({ dataDirectory: f.directory });
  expect(() => reopened.store.readParticipationContext(f.connection.endpointCredential, input)).toThrow();
  expect(await reopened.store.listEventsForHuman(f.owner.sessionToken, f.coordinates.collectiveId)).toEqual([request]);
});
