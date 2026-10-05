import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { participationFixture } from './participation-fixture.js';

it('retains an exact source across unrelated participation edits but rejects it after removal and re-entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f290-participation-lineage-'));
  try {
    const f = await participationFixture(root);
    const coordinates = { ...f.coordinates, connectionId: f.connection.connectionId };
    const sol = { catId: 'codex-sol', displayName: 'Sol', channelIds: ['general'] };
    await f.store.publishParticipation(f.connection.endpointCredential, { ...coordinates, revision: 1, agents: [sol] });
    const source = await f.store.postHumanMessage(f.owner.sessionToken, {
      ...f.coordinates,
      clientEventId: 'old-source',
      location: { channelId: 'general' },
      recipient: {
        kind: 'agent',
        humanId: f.owner.human.humanId,
        connectionId: f.connection.connectionId,
        agentId: sol.catId,
        participationRevision: 1,
      },
      body: 'Complete this work.',
    });
    const read = { ...coordinates, catId: sol.catId, participationRevision: 1, eventId: source.eventId };
    const edited = await f.store.publishParticipation(f.connection.endpointCredential, {
      ...coordinates,
      revision: 2,
      agents: [
        { ...sol, description: 'A revised introduction' },
        { catId: 'codex-astra', displayName: 'Astra', channelIds: ['general'] },
      ],
    });
    expect(edited).not.toHaveProperty('scopeStarts');
    expect(f.store.readParticipationContext(f.connection.endpointCredential, read).source.eventId).toBe(source.eventId);
    await f.store.publishParticipation(f.connection.endpointCredential, { ...coordinates, revision: 3, agents: [] });
    expect(() => f.store.readParticipationContext(f.connection.endpointCredential, read)).toThrow();
    await f.store.publishParticipation(f.connection.endpointCredential, { ...coordinates, revision: 4, agents: [sol] });
    expect(() => f.store.readParticipationContext(f.connection.endpointCredential, read)).toThrow();
    const fresh = await f.store.postHumanMessage(f.owner.sessionToken, {
      ...f.coordinates,
      clientEventId: 'fresh-source',
      location: { channelId: 'general' },
      recipient: {
        kind: 'agent',
        humanId: f.owner.human.humanId,
        connectionId: f.connection.connectionId,
        agentId: sol.catId,
        participationRevision: 4,
      },
      body: 'A new valid request.',
    });
    expect(
      f.store.readParticipationContext(f.connection.endpointCredential, {
        ...read,
        participationRevision: 4,
        eventId: fresh.eventId,
      }).source.eventId,
    ).toBe(fresh.eventId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
