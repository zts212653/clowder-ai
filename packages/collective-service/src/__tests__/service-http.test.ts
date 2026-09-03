import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { type RunningCollectiveServer, startCollectiveServer } from '../http-server.js';
import type { HumanAuthProvider } from '../human-auth-provider.js';
import { CollectiveServiceStore } from '../store.js';

const servers: RunningCollectiveServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('Collective Service HTTP process boundary', () => {
  it('serves one canonical client and walks owner/member/endpoint APIs', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'collective-http-test-'));
    directories.push(dataDirectory);
    const opened = await CollectiveServiceStore.open({
      dataDirectory,
      humanAuthProvider: fakeAuthProvider(),
      humanAuthRedirectUri: 'http://127.0.0.1/api/auth/github/callback',
    });
    const server = await startCollectiveServer({
      store: opened.store,
      host: '127.0.0.1',
      port: 0,
      allowedHostOrigins: ['http://localhost:5172'],
    });
    servers.push(server);

    const client = await fetch(server.url);
    expect(client.status).toBe(200);
    expect(client.headers.get('x-collective-client-build')).toBe('collective-client-v2');
    expect(client.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(client.headers.get('content-security-policy')).toContain("style-src 'self'");
    const clientHtml = await client.text();
    expect(clientHtml).toContain('data-client-root="collective"');
    expect(clientHtml).toContain('/collective-client/app.js');
    expect(clientHtml).not.toContain('Canonical order');
    expect(clientHtml).not.toContain('Service truth');
    expect(clientHtml).not.toContain('backed by the Service event log');
    expect((await fetch(`${server.url}/collective-client/app.js`)).status).toBe(200);
    expect((await fetch(`${server.url}/collective-client/app.css`)).status).toBe(200);

    const owner = await post(server.url, '/api/bootstrap', {
      secret: opened.bootstrapSecret,
      displayName: 'You',
    });
    const collective = await post(
      server.url,
      '/api/collectives',
      { name: 'Clowder AI Collective' },
      owner.sessionToken,
    );
    const unboundOwner = await get(server.url, '/api/me', owner.sessionToken);
    expect(unboundOwner).toMatchObject({
      auth: null,
      collectives: [{ collectiveId: collective.collectiveId, role: 'steward' }],
    });
    const preBindingInvite = await postResponse(
      server.url,
      '/api/invites',
      { collectiveId: collective.collectiveId },
      owner.sessionToken,
    );
    expect(preBindingInvite.status).toBe(401);
    await expect(preBindingInvite.json()).resolves.toMatchObject({ error: { code: 'HUMAN_AUTH_REQUIRED' } });

    const ownerAttempt = await post(server.url, '/api/auth/github/begin', { intent: 'bind' }, owner.sessionToken);
    const bodyBearer = await postResponse(server.url, '/api/auth/completions/exchange', {
      completionToken: 'body-bearers-are-not-accepted',
    });
    expect(bodyBearer.status).toBe(401);
    expect(bodyBearer.headers.get('set-cookie')).toContain('Max-Age=0');
    const denied = await fetch(
      `${server.url}/api/auth/github/callback?state=${encodeURIComponent(ownerAttempt.state)}&error=access_denied&error_description=${encodeURIComponent('raw provider detail')}`,
      { redirect: 'manual' },
    );
    expect(denied.status).toBe(303);
    expect(denied.headers.get('location')).toBe('/?authError=authorization_denied');
    expect(denied.headers.get('set-cookie')).toContain('Max-Age=0');
    const reboundOwner = await completeAuth(server.url, ownerAttempt.state, 'owner-code');
    const invite = await post(
      server.url,
      '/api/invites',
      { collectiveId: collective.collectiveId },
      owner.sessionToken,
    );
    const memberAttempt = await post(server.url, '/api/auth/github/begin', {
      intent: 'accept_invite',
      inviteToken: invite.inviteToken,
    });
    const unavailable = await fetch(
      `${server.url}/api/auth/github/callback?state=${encodeURIComponent(memberAttempt.state)}&code=outage-code`,
      { redirect: 'manual' },
    );
    expect(unavailable.status).toBe(303);
    expect(unavailable.headers.get('location')).toBe('/?authError=provider_unavailable');
    expect(unavailable.headers.get('set-cookie')).toContain('Max-Age=0');
    const member = await completeAuth(server.url, memberAttempt.state, 'member-code');
    expect(reboundOwner.human).toMatchObject({ displayName: 'You' });
    expect(member.human).toMatchObject({ displayName: 'Member' });

    const ownerEvent = await post(
      server.url,
      '/api/events/human',
      {
        serviceInstanceId: opened.store.serviceInstanceId,
        collectiveId: collective.collectiveId,
        clientEventId: 'owner-http-1',
        target: { kind: 'channel', channelId: 'general' },
        body: 'Hello over HTTP',
      },
      owner.sessionToken,
    );
    const events = await get(
      server.url,
      `/api/events/human?collectiveId=${collective.collectiveId}`,
      member.sessionToken,
    );
    expect(events.events).toMatchObject([{ eventId: ownerEvent.eventId, sequence: 1 }]);

    const pairing = await post(
      server.url,
      '/api/pairing-intents',
      {
        collectiveId: collective.collectiveId,
        hostOrigin: 'http://localhost:5172',
        nonce: 'browser-generated-nonce-1234',
      },
      owner.sessionToken,
    );
    const connection = await post(
      server.url,
      '/api/connections/exchange',
      {
        serviceInstanceId: pairing.serviceInstanceId,
        collectiveId: pairing.collectiveId,
        pairingIntentId: pairing.pairingIntentId,
        hostOrigin: pairing.hostOrigin,
        nonce: pairing.nonce,
        endpointLabel: 'Clowder AI HTTP endpoint',
      },
      undefined,
      { Origin: 'http://localhost:5172' },
    );
    const agentEvent = await post(
      server.url,
      '/api/events/agent',
      {
        serviceInstanceId: opened.store.serviceInstanceId,
        collectiveId: collective.collectiveId,
        connectionId: connection.connectionId,
        clientEventId: 'agent-http-1',
        agent: {
          agentId: 'codex-sol',
          displayName: 'Sol',
          catId: 'codex-sol',
          sessionRef: 'invocation:http-real',
        },
        target: { kind: 'message', eventId: ownerEvent.eventId },
        replyToEventId: ownerEvent.eventId,
        body: 'Agent endpoint connected.',
      },
      connection.endpointCredential,
    );
    expect(agentEvent).toMatchObject({
      sequence: 2,
      actor: {
        kind: 'agent',
        provenance: { endpointLabel: 'Clowder AI HTTP endpoint' },
      },
    });

    const meta = await get(server.url, '/api/meta');
    expect(meta).toMatchObject({
      serviceInstanceId: opened.store.serviceInstanceId,
      bootstrapNeeded: false,
      clientBuildId: 'collective-client-v2',
    });
  });

  it('rejects runtime ports and disallowed Host origins', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'collective-http-guard-'));
    directories.push(dataDirectory);
    const opened = await CollectiveServiceStore.open({ dataDirectory });
    await expect(startCollectiveServer({ store: opened.store, host: '127.0.0.1', port: 3001 })).rejects.toThrow(
      /reserved/i,
    );

    const server = await startCollectiveServer({
      store: opened.store,
      host: '127.0.0.1',
      port: 0,
      allowedHostOrigins: ['http://localhost:5172'],
    });
    servers.push(server);
    const response = await fetch(`${server.url}/api/connections/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
  });

  it('marks the browser-bound completion cookie Secure for a public HTTPS callback', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'collective-http-secure-auth-'));
    directories.push(dataDirectory);
    const opened = await CollectiveServiceStore.open({
      dataDirectory,
      humanAuthProvider: fakeAuthProvider(),
      humanAuthRedirectUri: 'https://collective.example/api/auth/github/callback',
    });
    const server = await startCollectiveServer({ store: opened.store, host: '127.0.0.1', port: 0 });
    servers.push(server);

    const owner = await post(server.url, '/api/bootstrap', {
      secret: opened.bootstrapSecret,
      displayName: 'You',
    });
    const attempt = await post(server.url, '/api/auth/github/begin', { intent: 'bind' }, owner.sessionToken);
    const callback = await fetch(
      `${server.url}/api/auth/github/callback?state=${encodeURIComponent(attempt.state)}&code=owner-code`,
      { redirect: 'manual' },
    );

    expect(callback.headers.get('location')).toBe('/?authCompleted=1');
    expect(callback.headers.get('set-cookie')).toContain('; Secure');
  });
});

async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  token?: string,
  extraHeaders: Record<string, string> = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
  return payload as Record<string, string> & { events: unknown[] };
}

function postResponse(
  baseUrl: string,
  path: string,
  body: unknown,
  token?: string,
  extraHeaders: Record<string, string> = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

async function get(baseUrl: string, path: string, token?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
  return payload as Record<string, string | boolean> & { events: unknown[] };
}

async function completeAuth(baseUrl: string, state: string, code: string) {
  const callback = await fetch(
    `${baseUrl}/api/auth/github/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    { redirect: 'manual' },
  );
  expect(callback.status).toBe(303);
  const location = callback.headers.get('location');
  if (!location) throw new Error('Expected Human auth completion redirect');
  expect(location).toBe('/?authCompleted=1');
  expect(location).not.toMatch(/token|completion=/i);
  const completionCookie = callback.headers.get('set-cookie');
  expect(completionCookie).toContain('HttpOnly');
  expect(completionCookie).toContain('SameSite=Strict');
  expect(completionCookie).toContain('Path=/api/auth/completions/exchange');
  if (!completionCookie) throw new Error('Expected browser-bound Human auth completion cookie');
  const cookie = completionCookie.split(';', 1)[0];
  const exchange = await postResponse(baseUrl, '/api/auth/completions/exchange', {}, undefined, { Cookie: cookie });
  expect(exchange.status).toBe(200);
  expect(exchange.headers.get('set-cookie')).toContain('Max-Age=0');
  const payload = (await exchange.json()) as Record<string, string> & { human: Record<string, string> };

  const replay = await postResponse(baseUrl, '/api/auth/completions/exchange', {}, undefined, { Cookie: cookie });
  expect(replay.status).toBe(409);
  expect(replay.headers.get('set-cookie')).toContain('Max-Age=0');
  return payload;
}

function fakeAuthProvider(): HumanAuthProvider {
  return {
    id: 'github',
    readiness: { ready: true },
    authorizationUrl: ({ state, redirectUri }) =>
      `https://github.test/login/oauth/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    authenticate: async ({ code }) =>
      code === 'outage-code'
        ? Promise.reject(new Error('raw provider outage detail'))
        : code === 'owner-code'
          ? { providerSubject: '1001', handle: 'operator', displayName: 'You' }
          : { providerSubject: '1002', handle: 'member', displayName: 'Member' },
  };
}
