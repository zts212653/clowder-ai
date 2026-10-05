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
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'collective-member-directory-'));
  directories.push(directory);
  const data = await participationFixture(directory);
  const server = await startCollectiveServer({ store: data.store, host: '127.0.0.1', port: 0, allowedHostOrigins: [] });
  servers.push(server);
  return { ...data, server };
}

it('lists actual membership and paired Cafés even before anyone posts a message, without private credentials', async () => {
  const { store, owner, coordinates, connection, server } = await fixture();
  const result = await fetch(`${server.url}/api/members?collectiveId=${coordinates.collectiveId}`, {
    headers: { authorization: `Bearer ${owner.sessionToken}` },
  });
  expect(result.status).toBe(200);
  const body = await result.json();
  const profile = await store.getHumanProjection(owner.sessionToken);
  expect(body.humans).toEqual([
    { humanId: owner.human.humanId, displayName: profile.human.displayName, role: 'steward' },
  ]);
  expect(body.cafes).toEqual([
    {
      connectionId: connection.connectionId,
      endpointId: connection.endpointId,
      endpointLabel: 'Editable label',
      humanId: owner.human.humanId,
    },
  ]);
  expect(JSON.stringify(body)).not.toContain(owner.sessionToken);
  expect(JSON.stringify(body)).not.toMatch(/credential|tokenDigest|providerSubject|sessionRef|threadId/);
  expect(await store.listEventsForHuman(owner.sessionToken, coordinates.collectiveId)).toEqual([]);
});

it('requires a Human session and membership in the exact Collective', async () => {
  const { store, owner, coordinates, server } = await fixture();
  expect((await fetch(`${server.url}/api/members?collectiveId=col_aaaaaaaa`)).status).toBe(401);
  const other = await store.createCollective({ sessionToken: owner.sessionToken, name: 'Another Collective' });
  const invite = await store.createInvite({ sessionToken: owner.sessionToken, collectiveId: other.collectiveId });
  const attempt = await store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const completion = await store.completeHumanAuth({ provider: 'github', state: attempt.state, code: 'other-human' });
  const stranger = await store.exchangeHumanAuthCompletion(completion.completionToken);
  expect(
    (
      await fetch(`${server.url}/api/members?collectiveId=${coordinates.collectiveId}`, {
        headers: { authorization: `Bearer ${stranger.sessionToken}` },
      })
    ).status,
  ).toBe(403);
});

it('removes a revoked Café from the current directory while retaining its Human membership', async () => {
  const { store, owner, coordinates, connection } = await fixture();
  await store.revokeOwnConnection(connection.endpointCredential, {
    ...coordinates,
    connectionId: connection.connectionId,
  });
  expect(store.listMembers(owner.sessionToken, coordinates.collectiveId)).toMatchObject({
    cafes: [],
    humans: [{ humanId: owner.human.humanId }],
  });
});

it('allows public HTTPS profile images while keeping script and style sources restricted', async () => {
  const { server } = await fixture();
  const page = await fetch(server.url);
  expect(page.headers.get('content-security-policy')).toContain("img-src 'self' https:");
  expect(page.headers.get('content-security-policy')).toContain("script-src 'self'; style-src 'self';");
});
