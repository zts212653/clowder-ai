import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { participationFixture } from './participation-fixture.js';

it('a declared participant can read ordinary Channel text without changing its attention or accepting work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'f290-listening-'));
  const f = await participationFixture(directory);
  try {
    await f.store.publishParticipation(f.connection.endpointCredential, {
      ...f.coordinates,
      connectionId: f.connection.connectionId,
      revision: 1,
      agents: [{ catId: 'sol', displayName: 'Sol', channelIds: ['general'] }],
    });
    const source = await f.store.postHumanMessage(f.owner.sessionToken, {
      ...f.coordinates,
      clientEventId: 'chat',
      target: { kind: 'channel', channelId: 'general' },
      body: 'How is everyone today?',
    });
    const read = {
      ...f.coordinates,
      connectionId: f.connection.connectionId,
      catId: 'sol',
      participationRevision: 1,
      eventId: source.eventId,
    };
    expect(f.store.readParticipationContext(f.connection.endpointCredential, read).source).toEqual(source);
    expect(f.store.listCollectiveCollaboration(f.owner.sessionToken, f.coordinates.collectiveId).works).toEqual([]);
    const forbidden = await f.store.postHumanMessage(f.owner.sessionToken, {
      ...f.coordinates,
      clientEventId: 'elsewhere',
      target: { kind: 'channel', channelId: 'other' },
      body: 'Another Channel.',
    });
    expect(() =>
      f.store.readParticipationContext(f.connection.endpointCredential, { ...read, eventId: forbidden.eventId }),
    ).toThrow(/unavailable/);
  } finally {
    await rm(directory, { recursive: true });
  }
});
