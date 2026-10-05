import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startCollectiveServer } from '../http-server.js';
import { participationFixture } from './participation-fixture.js';

it('owner policy read uses the bound Human session; an endpoint credential cannot impersonate that owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'f290-owner-policy-'));
  const f = await participationFixture(directory);
  await f.store.publishParticipation(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    revision: 1,
    agents: [{ catId: 'sol', displayName: 'Sol', channelIds: ['general'] }],
  });
  const input = { ...f.coordinates, connectionId: f.connection.connectionId };
  const server = await startCollectiveServer({ store: f.store, host: '127.0.0.1', port: 0 });
  const read = (credential: string) =>
    fetch(`${server.url}/api/participation/work-policy/read-owner`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  try {
    const empty = await read(f.owner.sessionToken);
    expect(empty.status, await empty.clone().text()).toBe(200);
    expect(await empty.json()).toEqual({ policy: null });
    const policy = await f.store.registerCollectiveWorkPolicy(f.owner.sessionToken, {
      ...input,
      expectedRevision: 0,
      requestId: 'register',
      decisionMode: 'automatic',
      grants: [
        {
          grantRef: 'guides',
          catIds: ['sol'],
          channelIds: ['general'],
          requestingHumanIds: 'channel_members',
          requestKinds: ['guide'],
          expiresAt: null,
        },
      ],
    });
    expect(await (await read(f.owner.sessionToken)).json()).toEqual({ policy });
    const rejected = await read(f.connection.endpointCredential);
    expect(rejected.status).toBe(401);
    const invite = await f.store.createInvite({
      sessionToken: f.owner.sessionToken,
      collectiveId: f.coordinates.collectiveId,
    });
    const attempt = await f.store.beginHumanAuth({
      provider: 'github',
      intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
    });
    const done = await f.store.completeHumanAuth({ provider: 'github', state: attempt.state, code: 'other-owner' });
    const other = await f.store.exchangeHumanAuthCompletion(done.completionToken);
    expect((await read(other.sessionToken)).status).toBe(403);
  } finally {
    await server.close();
    await rm(directory, { recursive: true });
  }
});
