import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { participationFixture } from './participation-fixture.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'f290-communication-'));
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
    clientEventId: 'natural-request',
    location: { channelId: 'general' },
    recipient: {
      kind: 'agent',
      humanId: current.owner.human.humanId,
      connectionId: current.connection.connectionId,
      agentId: 'codex-sol',
      participationRevision: 1,
    },
    body: '帮我写一份新人入场指南，成果回到这里。',
  });
  const policyInput = {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    expectedRevision: 0,
    requestId: 'owner-policy-1',
    decisionMode: 'automatic',
    grants: [
      {
        grantRef: 'grant-guides',
        catIds: ['codex-sol'],
        channelIds: ['general'],
        requestingHumanIds: 'channel_members',
        requestKinds: ['guide'],
        expiresAt: null,
      },
    ],
  };
  const acceptance = {
    ...current.coordinates,
    connectionId: current.connection.connectionId,
    participationRevision: 1,
    sourceEventId: source.eventId,
    requestId: `accept:${source.eventId}:codex-sol`,
    catId: 'codex-sol',
    sessionRef: 'real-authenticated-host-turn',
    grantRef: 'grant-guides',
    grantRevision: 1,
    requestKind: 'guide',
    title: '新人指南',
    intendedOutcome: source.body,
  };
  return { ...current, directory, source, policyInput, acceptance };
}
