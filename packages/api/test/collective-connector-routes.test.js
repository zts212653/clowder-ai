import assert from 'node:assert/strict';
import { test } from 'node:test';

import Fastify from 'fastify';

import { registerCollectiveConnectorRoutes } from '../dist/routes/collective-connector-routes.js';
import { readHeaders, writeHeaders } from './plugin-official-routes.fixture.js';

const connection = {
  serviceUrl: 'http://localhost:5201',
  serviceInstanceId: 'svc_12345678',
  collectiveId: 'col_12345678',
  connectionId: 'con_12345678',
  endpointId: 'ep_12345678',
  authorizedHumanId: 'human_12345678',
  endpointLabel: 'Clowder AI',
  authorityStatus: 'connected',
  liveStatus: 'online',
  lastAckedSequence: 4,
  outbox: { queued: 0, accepted: 1 },
  inbox: { persisted: 4 },
};

async function harness(active = true, callbackRecordOverrides = {}) {
  const calls = [];
  let hostRoute;
  const callbackUserId = process.env.DEFAULT_OWNER_USER_ID?.trim() || 'owner_1';
  const connector = {
    listConnections: async () => [connection],
    getProjection: async () => connection,
    getHostRoute: async () => hostRoute,
    setHostRoute: async (connectionId, input) => {
      calls.push(['set-route', connectionId, input]);
      hostRoute = { connectionId, ...input, revision: 1, updatedAt: '2026-08-29T00:00:00.000Z' };
      return hostRoute;
    },
    pair: async (input) => {
      calls.push(['pair', input]);
      return connection;
    },
    sync: async (connectionId) => {
      calls.push(['sync', connectionId]);
      return connection;
    },
    revoke: async (connectionId) => {
      calls.push(['revoke', connectionId]);
      return { ...connection, authorityStatus: 'revoked', liveStatus: 'offline' };
    },
    queueAgentMessage: async (connectionId, input) => {
      calls.push(['send', connectionId, input]);
      if (input.agent.sessionRef === 'unverified') throw new Error('Host could not verify the Agent/session binding');
      return { ...connection, outbox: { queued: 1, accepted: 1 } };
    },
    listInbox: async (connectionId) => {
      calls.push(['inbox', connectionId]);
      return [{ event: { eventId: 'evt_12345678', sequence: 4 }, disposition: 'persisted' }];
    },
  };
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    const raw = request.headers['x-test-session-user'];
    if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
  });
  registerCollectiveConnectorRoutes(app, {
    runtime: { connector: () => (active ? connector : undefined) },
    callbackRegistry: {
      verify: async (invocationId, callbackToken) => {
        if (invocationId !== 'inv_1' || callbackToken !== 'callback-secret') {
          return { ok: false, reason: 'invalid_token' };
        }
        return {
          ok: true,
          record: {
            invocationId,
            callbackToken,
            userId: callbackUserId,
            ownerAuthProvenance: { kind: 'user_session', userId: callbackUserId },
            catId: 'codex-sol',
            threadId: 'thread_1',
            clientMessageIds: new Set(),
            createdAt: Date.now(),
            expiresAt: null,
            state: 'active',
            ...callbackRecordOverrides,
          },
        };
      },
    },
    resolveAgentIdentity: (catId) =>
      catId === 'codex-sol' ? { agentId: catId, catId, displayName: 'Sol' } : undefined,
    threadStore: {
      get: async (threadId) => ({
        id: threadId,
        createdBy: callbackUserId,
        participants: threadId === 'thread_agent' ? ['codex-sol'] : [],
      }),
    },
    isCatAvailable: (catId) => catId === 'codex-sol',
  });
  await app.ready();
  return { app, calls };
}

test('projects Connector status without credentials and requires authenticated local owner access', async () => {
  const { app } = await harness();
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/plugins/collective-connector' })).statusCode, 401);
    const response = await app.inject({
      method: 'GET',
      url: '/api/plugins/collective-connector',
      headers: readHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(response.statusCode, 200, response.payload);
    assert.deepEqual(response.json(), { runtimeStatus: 'active', connections: [connection] });
    assert.equal(response.payload.includes('credential'), false);
  } finally {
    await app.close();
  }
});

test('returns honest inactive state before the official plugin runtime is enabled', async () => {
  const { app } = await harness(false);
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/plugins/collective-connector',
      headers: readHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(response.statusCode, 200, response.payload);
    assert.deepEqual(response.json(), { runtimeStatus: 'inactive', connections: [] });
  } finally {
    await app.close();
  }
});

test('pairs, synchronizes and revokes through localhost owner mutations', async () => {
  const { app, calls } = await harness();
  try {
    const pair = await app.inject({
      method: 'POST',
      url: '/api/plugins/collective-connector/pair',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: {
        serviceUrl: connection.serviceUrl,
        endpointLabel: 'Clowder AI',
        intent: {
          serviceInstanceId: connection.serviceInstanceId,
          collectiveId: connection.collectiveId,
          pairingIntentId: 'pair_12345678',
          nonce: 'n'.repeat(32),
          hostOrigin: 'http://localhost:5173',
          expiresAt: '2026-08-29T00:00:00.000Z',
        },
      },
    });
    assert.equal(pair.statusCode, 200, pair.payload);
    const reconnect = await app.inject({
      method: 'POST',
      url: '/api/plugins/collective-connector/con_12345678/reconnect',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(reconnect.statusCode, 200, reconnect.payload);
    const revoke = await app.inject({
      method: 'POST',
      url: '/api/plugins/collective-connector/con_12345678/revoke',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(revoke.statusCode, 200, revoke.payload);
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['pair', 'sync', 'revoke'],
    );
  } finally {
    await app.close();
  }
});

test('persists an owner-only Host route and maps an exact Collective Agent target to a local Cat', async () => {
  const { app, calls } = await harness();
  try {
    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/plugins/collective-connector/con_12345678/route',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: {
        defaultIngressThreadId: 'thread_channel',
        humanNotificationThreadId: 'thread_human',
        agentRoutes: {
          'human_other:codex-sol': { catId: 'codex-sol', threadId: 'thread_agent' },
        },
      },
    });
    assert.equal(invalid.statusCode, 422, invalid.payload);
    assert.equal(invalid.json().code, 'TARGET_NOT_LOCAL');

    const configured = await app.inject({
      method: 'PUT',
      url: '/api/plugins/collective-connector/con_12345678/route',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: {
        defaultIngressThreadId: 'thread_channel',
        humanNotificationThreadId: 'thread_human',
        agentRoutes: {
          'human_12345678:collective-agent-sol': { catId: 'codex-sol', threadId: 'thread_agent' },
        },
      },
    });
    assert.equal(configured.statusCode, 200, configured.payload);
    assert.equal(configured.json().localOwnerUserId, writeHeaders['x-test-session-user']);
    assert.deepEqual(calls.at(-1), [
      'set-route',
      'con_12345678',
      {
        localOwnerUserId: writeHeaders['x-test-session-user'],
        defaultIngressThreadId: 'thread_channel',
        humanNotificationThreadId: 'thread_human',
        agentRoutes: {
          'human_12345678:collective-agent-sol': { catId: 'codex-sol', threadId: 'thread_agent' },
        },
      },
    ]);

    const read = await app.inject({
      method: 'GET',
      url: '/api/plugins/collective-connector/con_12345678/route',
      headers: readHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(read.statusCode, 200, read.payload);
    assert.equal(read.json().revision, 1);
  } finally {
    await app.close();
  }
});

test('queues Agent signals only from callback authority and derives provenance from the authenticated invocation', async () => {
  const { app, calls } = await harness();
  try {
    const ownerShapedSpoof = await app.inject({
      method: 'POST',
      url: '/api/plugins/collective-connector/con_12345678/send',
      headers: writeHeaders,
      remoteAddress: '127.0.0.1',
      payload: {
        clientEventId: 'client_owner_spoof',
        agent: { agentId: 'opus', displayName: 'Opus', catId: 'opus', sessionRef: 'other_live_invocation' },
        target: { kind: 'channel', channelId: 'general' },
        body: 'owner payload must not name an Agent',
      },
    });
    assert.equal(ownerShapedSpoof.statusCode, 404, ownerShapedSpoof.payload);

    const missingCallbackAuthority = await app.inject({
      method: 'POST',
      url: '/api/callbacks/collective-connector/con_12345678/send',
      remoteAddress: '127.0.0.1',
      payload: {
        clientEventId: 'client_1',
        target: { kind: 'human', humanId: 'human_12345678' },
        body: 'hello',
      },
    });
    assert.equal(missingCallbackAuthority.statusCode, 401, missingCallbackAuthority.payload);

    const borrowedCallbackAuthority = await app.inject({
      method: 'POST',
      url: '/api/callbacks/collective-connector/con_12345678/send',
      headers: { 'x-invocation-id': 'other_live_invocation', 'x-callback-token': 'callback-secret' },
      remoteAddress: '127.0.0.1',
      payload: {
        clientEventId: 'client_borrowed',
        target: { kind: 'channel', channelId: 'general' },
        body: 'cannot borrow another live Agent session',
      },
    });
    assert.equal(borrowedCallbackAuthority.statusCode, 401, borrowedCallbackAuthority.payload);

    const callerShapedAgent = await app.inject({
      method: 'POST',
      url: '/api/callbacks/collective-connector/con_12345678/send',
      headers: { 'x-invocation-id': 'inv_1', 'x-callback-token': 'callback-secret' },
      remoteAddress: '127.0.0.1',
      payload: {
        clientEventId: 'client_shaped_agent',
        agent: { agentId: 'opus', displayName: 'Opus', catId: 'opus', sessionRef: 'other_live_invocation' },
        target: { kind: 'channel', channelId: 'general' },
        body: 'callback payload cannot override Host-derived provenance',
      },
    });
    assert.equal(callerShapedAgent.statusCode, 400, callerShapedAgent.payload);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/callbacks/collective-connector/con_12345678/send',
      headers: { 'x-invocation-id': 'inv_1', 'x-callback-token': 'callback-secret' },
      remoteAddress: '127.0.0.1',
      payload: {
        clientEventId: 'client_2',
        target: { kind: 'human', humanId: 'human_12345678' },
        replyToEventId: 'evt_12345678',
        body: 'verified reply',
      },
    });
    assert.equal(accepted.statusCode, 202, accepted.payload);
    assert.equal(accepted.json().disposition, 'queued');
    assert.deepEqual(calls.at(-1), [
      'send',
      'con_12345678',
      {
        clientEventId: 'client_2',
        target: { kind: 'human', humanId: 'human_12345678' },
        replyToEventId: 'evt_12345678',
        body: 'verified reply',
        agent: { agentId: 'codex-sol', displayName: 'Sol', catId: 'codex-sol', sessionRef: 'inv_1' },
      },
    ]);

    const inbox = await app.inject({
      method: 'GET',
      url: '/api/plugins/collective-connector/con_12345678/inbox',
      headers: readHeaders,
      remoteAddress: '127.0.0.1',
    });
    assert.equal(inbox.statusCode, 200, inbox.payload);
    assert.equal(inbox.json().events[0].disposition, 'persisted');
    assert.deepEqual(
      calls.map((call) => call[0]),
      ['send', 'inbox'],
    );
  } finally {
    await app.close();
  }
});

test('rejects callback authority from a different configured owner without queueing', async () => {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'owner_1';
  const { app, calls } = await harness(true, {
    userId: 'attacker_2',
    ownerAuthProvenance: { kind: 'user_session', userId: 'attacker_2' },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/collective-connector/con_12345678/send',
      headers: { 'x-invocation-id': 'inv_1', 'x-callback-token': 'callback-secret' },
      remoteAddress: '127.0.0.1',
      payload: {
        clientEventId: 'client_cross_owner',
        target: { kind: 'channel', channelId: 'general' },
        body: 'must not cross the configured owner boundary',
      },
    });

    assert.equal(response.statusCode, 403, response.payload);
    assert.deepEqual(calls, []);
  } finally {
    await app.close();
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  }
});

test('allows callback authority in local single-user mode without a configured owner', async () => {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  delete process.env.DEFAULT_OWNER_USER_ID;
  const { app, calls } = await harness(true, {
    userId: 'local_user',
    ownerAuthProvenance: { kind: 'user_session', userId: 'local_user' },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/collective-connector/con_12345678/send',
      headers: { 'x-invocation-id': 'inv_1', 'x-callback-token': 'callback-secret' },
      remoteAddress: '127.0.0.1',
      payload: {
        clientEventId: 'client_local_single_user',
        target: { kind: 'channel', channelId: 'general' },
        body: 'local single-user callback remains available',
      },
    });

    assert.equal(response.statusCode, 202, response.payload);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'send');
  } finally {
    await app.close();
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  }
});

test('preserves callback tool policy when admitting an Agent signal', async () => {
  const { app, calls } = await harness(true, {
    toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/collective-connector/con_12345678/send',
      headers: { 'x-invocation-id': 'inv_1', 'x-callback-token': 'callback-secret' },
      remoteAddress: '127.0.0.1',
      payload: {
        clientEventId: 'client_read_only',
        target: { kind: 'channel', channelId: 'general' },
        body: 'must not escape read-only execution policy',
      },
    });
    assert.equal(response.statusCode, 403, response.payload);
    assert.equal(response.json().reason, 'read_only_tool_policy');
    assert.deepEqual(calls, []);
  } finally {
    await app.close();
  }
});
