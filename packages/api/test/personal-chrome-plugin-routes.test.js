import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import Fastify from 'fastify';

import { registerPersonalChromePluginRoutes } from '../dist/routes/personal-chrome-plugin-routes.js';

const ownerUserId = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-user';
const writeHeaders = {
  host: 'localhost:3004',
  origin: 'http://localhost:5173',
  'x-test-session-user': ownerUserId,
};
const readHeaders = {
  host: writeHeaders.host,
  'x-test-session-user': ownerUserId,
};

const absentState = {
  pluginId: 'personal-chrome-host',
  channel: 'developer_preview',
  platform: 'darwin',
  platformSupport: 'supported',
  artifact: {
    helper: 'absent',
    extension: 'chrome_web_store',
  },
  distribution: {
    channel: 'chrome_web_store',
    integration: 'ready',
    publication: 'unavailable',
    blockerCode: 'CHROME_WEB_STORE_LISTING_NOT_CONFIGURED',
  },
  config: { status: 'absent' },
  authorization: { status: 'empty', count: 0, limit: 32, conversations: [] },
  intent: { status: 'developer_preview' },
  live: { status: 'dormant' },
};

const readyButUnboundState = {
  ...absentState,
  artifact: { ...absentState.artifact, helper: 'ready' },
  config: { status: 'ready' },
};

const ownerLocalState = {
  ...readyButUnboundState,
  authorization: {
    status: 'authorized',
    count: 2,
    limit: 32,
    conversations: [
      {
        conversationId: 'conversation-private-a',
        authorizedAt: '2026-08-21T07:00:00.000Z',
        updatedAt: '2026-08-21T07:00:00.000Z',
      },
      {
        conversationId: 'conversation-private-b',
        authorizedAt: '2026-08-21T07:01:00.000Z',
        updatedAt: '2026-08-21T07:01:00.000Z',
      },
    ],
  },
};

const apps = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function harness(overrides = {}) {
  const calls = [];
  const state = overrides.state ?? absentState;
  const port = {
    inspect: async () => state,
    install: async () => {
      calls.push('install');
      return readyButUnboundState;
    },
    repair: async () => {
      calls.push('repair');
      return readyButUnboundState;
    },
    uninstall: async () => {
      calls.push('uninstall');
      return absentState;
    },
    revoke: async (conversationId) => {
      calls.push(`revoke:${conversationId}`);
      return readyButUnboundState;
    },
    ...overrides.port,
  };
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    const raw = request.headers['x-test-session-user'];
    if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
  });
  registerPersonalChromePluginRoutes(app, { port });
  await app.ready();
  apps.push(app);
  return { app, calls };
}

test('Personal Chrome state is owner-readable and does not conflate helper install with configured or live', async () => {
  let inspections = 0;
  const { app } = await harness({
    port: {
      inspect: async () => {
        inspections += 1;
        return readyButUnboundState;
      },
    },
  });

  const unauthorized = await app.inject({
    method: 'GET',
    url: '/api/plugins/personal-chrome',
    headers: { host: readHeaders.host },
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(inspections, 0);

  const response = await app.inject({
    method: 'GET',
    url: '/api/plugins/personal-chrome',
    headers: readHeaders,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(inspections, 1);
  const body = response.json();
  assert.equal(body.artifact.helper, 'ready');
  assert.equal(body.config.status, 'ready');
  assert.equal(body.authorization.status, 'empty');
  assert.equal(body.intent.status, 'developer_preview');
  assert.equal(body.live.status, 'dormant');
  assert.equal(JSON.stringify(body).includes('pairingSecret'), false);
});

test('Personal Chrome state rejects an explicitly untrusted Origin before inspecting owner-local state', async () => {
  let inspections = 0;
  const { app } = await harness({
    port: {
      inspect: async () => {
        inspections += 1;
        return ownerLocalState;
      },
    },
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/plugins/personal-chrome',
    headers: { ...readHeaders, origin: 'https://attacker.example' },
    remoteAddress: '127.0.0.1',
  });

  assert.equal(response.statusCode, 403);
  assert.equal(inspections, 0);
});

test('Personal Chrome state rejects foreign sessions without inspecting owner-local state', async () => {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = ownerUserId;
  let inspections = 0;
  const { app } = await harness({
    port: {
      inspect: async () => {
        inspections += 1;
        return ownerLocalState;
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/plugins/personal-chrome',
      headers: { ...readHeaders, 'x-test-session-user': 'non-owner-user' },
      remoteAddress: '127.0.0.1',
    });

    assert.equal(response.statusCode, 403);
    assert.equal(inspections, 0);
    assert.equal(response.payload.includes('conversation-private-a'), false);
    assert.equal(response.payload.includes('conversation-private-b'), false);
  } finally {
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  }
});

test('Personal Chrome state rejects non-loopback callers without inspecting owner-local state', async () => {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = ownerUserId;
  let inspections = 0;
  const { app } = await harness({
    port: {
      inspect: async () => {
        inspections += 1;
        return ownerLocalState;
      },
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/plugins/personal-chrome',
      headers: readHeaders,
      remoteAddress: '203.0.113.10',
    });

    assert.equal(response.statusCode, 403);
    assert.equal(inspections, 0);
    assert.equal(response.payload.includes('conversation-private-a'), false);
    assert.equal(response.payload.includes('conversation-private-b'), false);
  } finally {
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  }
});

test('Personal Chrome state rejects forwarded callers without inspecting owner-local state', async () => {
  let inspections = 0;
  const { app } = await harness({
    port: {
      inspect: async () => {
        inspections += 1;
        return ownerLocalState;
      },
    },
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/plugins/personal-chrome',
    headers: { ...readHeaders, 'x-forwarded-for': '127.0.0.1' },
    remoteAddress: '127.0.0.1',
  });

  assert.equal(response.statusCode, 403);
  assert.equal(inspections, 0);
});

test('Personal Chrome mutations require local owner access and return refreshed state', async () => {
  const { app, calls } = await harness();

  const remote = await app.inject({
    method: 'POST',
    url: '/api/plugins/personal-chrome/install',
    headers: { ...writeHeaders, host: 'cat-cafe.example' },
  });
  assert.equal(remote.statusCode, 403);
  assert.deepEqual(calls, []);

  for (const action of ['install', 'repair', 'uninstall']) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/plugins/personal-chrome/${action}`,
      headers: writeHeaders,
    });
    assert.equal(response.statusCode, 200);
  }
  const revoked = await app.inject({
    method: 'DELETE',
    url: '/api/plugins/personal-chrome/authorizations/conversation-private-a',
    headers: writeHeaders,
  });
  assert.equal(revoked.statusCode, 200);
  assert.deepEqual(calls, ['install', 'repair', 'uninstall', 'revoke:conversation-private-a']);
});

test('Personal Chrome revoke validates the exact ID and never calls the port for untrusted callers', async () => {
  const { app, calls } = await harness();

  const invalid = await app.inject({
    method: 'DELETE',
    url: '/api/plugins/personal-chrome/authorizations/not%20exact',
    headers: writeHeaders,
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, 'INVALID_CONVERSATION_ID');

  const untrusted = await app.inject({
    method: 'DELETE',
    url: '/api/plugins/personal-chrome/authorizations/conversation-private-a',
    headers: { ...writeHeaders, origin: 'https://attacker.example' },
  });
  assert.equal(untrusted.statusCode, 403);
  assert.deepEqual(calls, []);
});

test('Personal Chrome publication and revoke errors are typed and redact internal detail', async () => {
  const { app } = await harness({
    port: {
      install: async () => {
        const error = new Error('private staging listing URL');
        error.code = 'CHROME_WEB_STORE_LISTING_NOT_CONFIGURED';
        throw error;
      },
      revoke: async () => {
        const error = new Error('private collection path');
        error.code = 'AUTHORIZATION_NOT_FOUND';
        throw error;
      },
    },
  });

  const install = await app.inject({
    method: 'POST',
    url: '/api/plugins/personal-chrome/install',
    headers: writeHeaders,
  });
  assert.equal(install.statusCode, 409);
  assert.deepEqual(install.json(), {
    error: 'Chrome Web Store listing is not configured or published',
    code: 'CHROME_WEB_STORE_LISTING_NOT_CONFIGURED',
  });

  const revoke = await app.inject({
    method: 'DELETE',
    url: '/api/plugins/personal-chrome/authorizations/conversation-private-a',
    headers: writeHeaders,
  });
  assert.equal(revoke.statusCode, 404);
  assert.deepEqual(revoke.json(), {
    error: 'ChatGPT conversation authorization was not found',
    code: 'AUTHORIZATION_NOT_FOUND',
  });
  assert.equal(`${install.payload}${revoke.payload}`.includes('private'), false);
});

test('Personal Chrome operation errors are typed and redact internal details', async () => {
  const { app } = await harness({
    port: {
      uninstall: async () => {
        const error = new Error('socket /tmp/private.sock pairingSecret=secret');
        error.code = 'HELPER_ACTIVE';
        throw error;
      },
    },
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/plugins/personal-chrome/uninstall',
    headers: writeHeaders,
  });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    error: 'Close Chrome before uninstalling Personal ChatGPT Pro',
    code: 'HELPER_ACTIVE',
  });
});
