import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CollectiveServiceStore } from '../store.js';
import { participationFixture } from './participation-fixture.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'collective-reaction-'));
  directories.push(directory);
  const current = await participationFixture(directory);
  await current.store.publishParticipation(current.connection.endpointCredential, {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    revision: 1,
    agents: [{ catId: 'codex-sol', displayName: '小太阳 · 砚砚', channelIds: ['general'] }],
  });
  const source = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'reaction-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '这个方向值得继续。',
  });
  return { ...current, directory, source };
}

async function inviteMember(current: Awaited<ReturnType<typeof fixture>>) {
  const invite = await current.store.createInvite({
    sessionToken: current.owner.sessionToken,
    collectiveId: current.coordinates.collectiveId,
  });
  const attempt = await current.store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const completion = await current.store.completeHumanAuth({
    provider: 'github',
    state: attempt.state,
    code: 'reaction-member',
  });
  return current.store.exchangeHumanAuthCompletion(completion.completionToken);
}

it('persists named Human reactions, makes set/remove idempotent, and projects them to every member', async () => {
  const current = await fixture();
  const member = await inviteMember(current);

  const ownerSet = await current.store.setCollectiveReaction(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'owner-adds-paw',
    eventId: current.source.eventId,
    emoji: '🐾',
    active: true,
  });
  expect(ownerSet).toMatchObject({
    eventId: current.source.eventId,
    emoji: '🐾',
    humanIds: [current.owner.human.humanId],
  });
  expect(
    await current.store.setCollectiveReaction(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'owner-adds-paw',
      eventId: current.source.eventId,
      emoji: '🐾',
      active: true,
    }),
  ).toEqual(ownerSet);

  const memberSet = await current.store.setCollectiveReaction(member.sessionToken, {
    ...current.coordinates,
    requestId: 'member-adds-paw',
    eventId: current.source.eventId,
    emoji: '🐾',
    active: true,
  });
  expect(memberSet.humanIds).toEqual([current.owner.human.humanId, member.human.humanId]);

  const ownerRemoved = await current.store.setCollectiveReaction(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'owner-removes-paw',
    eventId: current.source.eventId,
    emoji: '🐾',
    active: false,
  });
  expect(ownerRemoved.humanIds).toEqual([member.human.humanId]);

  const reopened = await CollectiveServiceStore.open({ dataDirectory: current.directory });
  expect(
    reopened.store.listCollectiveCollaboration(member.sessionToken, current.coordinates.collectiveId).reactions,
  ).toEqual([ownerRemoved]);
});

it('accepts public Channel messages with named Human, Cat, and Topic addressing', async () => {
  const current = await fixture();
  const member = await inviteMember(current);
  const addressedHuman = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'addressed-human-reaction-source',
    location: { channelId: 'general' },
    recipient: { kind: 'human', humanId: member.human.humanId },
    body: '@成员 这条仍在公开 Channel。',
  });
  const addressedCat = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'addressed-cat-reaction-source',
    location: { channelId: 'general' },
    recipient: {
      kind: 'agent',
      humanId: current.owner.human.humanId,
      agentId: 'codex-sol',
      connectionId: current.connection.connectionId,
      participationRevision: 1,
    },
    body: '@小太阳 这条也仍在公开 Channel。',
  });
  const topicReply = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'topic-reaction-source',
    location: { channelId: 'general', rootEventId: current.source.eventId },
    recipient: { kind: 'channel' },
    replyToEventId: current.source.eventId,
    body: '公开 Topic 里的回应。',
  });

  for (const [index, event] of [addressedHuman, addressedCat, topicReply].entries()) {
    expect(
      await current.store.listEventsForHuman(member.sessionToken, current.coordinates.collectiveId),
    ).toContainEqual(event);
    await expect(
      current.store.setCollectiveReaction(member.sessionToken, {
        ...current.coordinates,
        requestId: `public-address-reaction-${index}`,
        eventId: event.eventId,
        emoji: '🐾',
        active: true,
      }),
    ).resolves.toMatchObject({ eventId: event.eventId, humanIds: [member.human.humanId] });
  }
});

it('rejects reactions without a known public event coordinate or a supported glyph', async () => {
  const current = await fixture();
  await expect(
    current.store.setCollectiveReaction(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'missing-reaction',
      eventId: 'evt_aaaaaaaa',
      emoji: '🐾',
      active: true,
    }),
  ).rejects.toMatchObject({ code: 'REACTION_SOURCE_UNAVAILABLE' });
  await expect(
    current.store.setCollectiveReaction(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'unsupported-reaction',
      eventId: current.source.eventId,
      emoji: '🚈',
      active: true,
    }),
  ).rejects.toThrow();

  const filePath = join(current.directory, 'collective-service.json');
  const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
    events: Record<
      string,
      Array<{
        eventId: string;
        location?: { channelId: string };
        target: { kind: string; channelId?: string; humanId?: string };
        recipient?: { kind: string; humanId?: string };
      }>
    >;
  };
  const legacySource = persisted.events[current.coordinates.collectiveId]?.find(
    (event) => event.eventId === current.source.eventId,
  );
  if (!legacySource) throw new Error('Expected persisted public source fixture');
  delete legacySource.location;
  legacySource.target = { kind: 'human', humanId: current.owner.human.humanId };
  legacySource.recipient = { kind: 'human', humanId: current.owner.human.humanId };
  await writeFile(filePath, `${JSON.stringify(persisted, null, 2)}\n`);
  const reopened = await CollectiveServiceStore.open({ dataDirectory: current.directory });
  await expect(
    reopened.store.setCollectiveReaction(current.owner.sessionToken, {
      ...current.coordinates,
      requestId: 'legacy-locationless-reaction',
      eventId: current.source.eventId,
      emoji: '🐾',
      active: true,
    }),
  ).rejects.toMatchObject({ code: 'REACTION_SOURCE_UNAVAILABLE' });
});

it('fails closed when persisted reaction history disagrees with its current state', async () => {
  const current = await fixture();
  await current.store.setCollectiveReaction(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'owner-adds-corruption-sentinel',
    eventId: current.source.eventId,
    emoji: '🎉',
    active: true,
  });
  const filePath = join(current.directory, 'collective-service.json');
  const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
    reactions: Record<string, { active: boolean }>;
  };
  const reaction = Object.values(persisted.reactions)[0];
  if (!reaction) throw new Error('Expected persisted reaction fixture');
  reaction.active = false;
  await writeFile(filePath, `${JSON.stringify(persisted, null, 2)}\n`);

  await expect(CollectiveServiceStore.open({ dataDirectory: current.directory })).rejects.toMatchObject({
    code: 'STATE_CORRUPT',
  });
});
