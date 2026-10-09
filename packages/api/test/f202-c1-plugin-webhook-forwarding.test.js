import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Fastify from 'fastify';

import { DeclaredRuntimeContributions } from '../dist/domains/plugin/declared/declared-runtime-contributions.js';
import { pluginWebhookForwardingRoutes } from '../dist/routes/plugin/plugin-webhook-forwarding-routes.js';

const apps = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function admission(contributions, pluginInstanceId = 'pi_webhook') {
  return {
    instance: { pluginInstanceId },
    packageRecord: {
      pluginId: 'dev.clowder.webhook-fixture',
      manifest: { contributions },
    },
    effectiveGrants: [],
  };
}

function contributions() {
  return new DeclaredRuntimeContributions({
    packages: {
      async resolveInstalledPackage() {
        throw new Error('webhooks do not read package files');
      },
    },
    configuration: { async readConfig() {}, async readSecret() {} },
  });
}

async function appFor(webhooks, timeoutMs = 50, logRecords) {
  const app = Fastify(
    logRecords
      ? {
          logger: {
            level: 'warn',
            stream: { write: (line) => logRecords.push(JSON.parse(line)) },
          },
        }
      : {},
  );
  apps.push(app);
  app.decorateRequest('sessionUserId', undefined);
  app.addHook('onRequest', async (request) => {
    const owner = request.headers['x-cat-cafe-user'];
    if (typeof owner === 'string') request.sessionUserId = owner;
  });
  await app.register(pluginWebhookForwardingRoutes, { webhooks, timeoutMs });
  return app;
}

test('forwards an anonymous declared webhook with raw bytes and strips Host credentials', async () => {
  const webhooks = contributions();
  const calls = [];
  await webhooks.activate(
    admission([
      {
        type: 'webhook',
        id: 'provider-events',
        path: 'events/provider',
        methods: ['POST'],
        action: { method: 'provider.receive', params: { fixed: 'manifest', request: 'cannot-win' } },
        verificationSecretRef: 'WEBHOOK_SECRET',
      },
    ]),
    async (pluginInstanceId, method, params) => {
      calls.push({ pluginInstanceId, method, params });
      return {
        status: 201,
        headers: { 'content-type': 'application/json', location: '/accepted/1' },
        body: { accepted: true },
      };
    },
  );
  const app = await appFor(webhooks);
  const rawBody = '{"event":"opened","n":1}';

  const response = await app.inject({
    method: 'POST',
    url: '/api/plugins/dev.clowder.webhook-fixture/events/provider?delivery=42',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer host-secret',
      cookie: 'session=host-secret',
      'x-callback-token': 'host-callback-secret',
      'x-api-key': 'host-api-key',
      'x-provider-signature': 'provider-signature',
    },
    body: rawBody,
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.headers.location, '/accepted/1');
  assert.deepEqual(response.json(), { accepted: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pluginInstanceId, 'pi_webhook');
  assert.equal(calls[0].method, 'provider.receive');
  assert.equal(calls[0].params.fixed, 'manifest');
  assert.equal(calls[0].params.request.method, 'POST');
  assert.equal(calls[0].params.request.path, 'events/provider');
  assert.deepEqual(calls[0].params.request.query, { delivery: '42' });
  assert.deepEqual(calls[0].params.request.body, { event: 'opened', n: 1 });
  assert.equal(Buffer.from(calls[0].params.request.rawBody).toString(), rawBody);
  assert.equal(calls[0].params.request.headers.authorization, undefined);
  assert.equal(calls[0].params.request.headers.cookie, undefined);
  assert.equal(calls[0].params.request.headers['x-callback-token'], undefined);
  assert.equal(calls[0].params.request.headers['x-api-key'], undefined);
  assert.equal(calls[0].params.request.headers['x-provider-signature'], 'provider-signature');
  assert.equal(calls[0].params.request.principal, undefined);

  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/plugins/dev.clowder.webhook-fixture/events/provider' })).statusCode,
    405,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/plugins/dev.clowder.webhook-fixture/events/missing' })).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/plugins/dev.clowder.webhook-fixture/events%2fprovider' }))
      .statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/plugins/dev.clowder.webhook-fixture/events/prov%2eider' }))
      .statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/plugins/dev.clowder.webhook-fixture/events/%70rovider' }))
      .statusCode,
    404,
  );

  webhooks.deactivate('pi_webhook');
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/plugins/dev.clowder.webhook-fixture/events/provider' })).statusCode,
    404,
  );
});

test('connector XML reaches the package under request only and GET challenge stays plain text', async () => {
  const webhooks = contributions();
  const calls = [];
  await webhooks.activate(
    admission([
      {
        type: 'webhook',
        id: 'wecom-agent',
        path: 'connectors/wecom-agent',
        methods: ['GET', 'POST'],
        action: { method: 'wecom-agent.webhook' },
        verificationSecretRef: 'CALLBACK_TOKEN',
      },
    ]),
    async (_pluginInstanceId, _method, params) => {
      calls.push(params);
      return params.request.method === 'GET'
        ? { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'challenge-value' }
        : { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'success' };
    },
  );
  const app = await appFor(webhooks);
  const challenge = await app.inject({
    method: 'GET',
    url: '/api/plugins/dev.clowder.webhook-fixture/connectors/wecom-agent?echostr=encrypted',
  });
  assert.equal(challenge.statusCode, 200);
  assert.equal(challenge.body, 'challenge-value');
  assert.match(challenge.headers['content-type'], /^text\/plain/);

  const xml = '<xml><MsgId>42</MsgId></xml>';
  const delivery = await app.inject({
    method: 'POST',
    url: '/api/plugins/dev.clowder.webhook-fixture/connectors/wecom-agent?nonce=n1',
    headers: { 'content-type': 'text/xml' },
    body: xml,
  });
  assert.equal(delivery.statusCode, 200);
  assert.equal(delivery.body, 'success');
  assert.deepEqual(Object.keys(calls[0]), ['request']);
  assert.deepEqual(Object.keys(calls[1]), ['request']);
  assert.equal(calls[1].request.body, xml);
  assert.equal(Buffer.from(calls[1].request.rawBody).toString(), xml);
  assert.deepEqual(calls[1].request.query, { nonce: 'n1' });
});

test('legacy connector response shape fails visibly with 502 and a sanitized warning', async () => {
  const webhooks = contributions();
  await webhooks.activate(
    admission([
      {
        type: 'webhook',
        id: 'legacy-shape',
        path: 'connectors/legacy',
        methods: ['POST'],
        action: { method: 'legacy.webhook' },
        verificationSecretRef: 'CALLBACK_TOKEN',
      },
    ]),
    async () => ({ kind: 'processed', body: 'private-provider-body' }),
  );
  const logs = [];
  const app = await appFor(webhooks, 50, logs);
  const response = await app.inject({
    method: 'POST',
    url: '/api/plugins/dev.clowder.webhook-fixture/connectors/legacy',
    headers: { 'content-type': 'text/xml' },
    body: '<xml>private-request</xml>',
  });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error, 'Plugin webhook returned an invalid response');
  const warning = logs.find((entry) => entry.msg === 'Plugin webhook returned an invalid response');
  assert.equal(warning?.contributionId, 'legacy-shape');
  assert.equal(warning?.validationError, 'response contains unknown fields');
  assert.equal(JSON.stringify(warning).includes('private-provider-body'), false);
  assert.equal(JSON.stringify(warning).includes('private-request'), false);
});

test('owner-only webhooks require a local session and fixed Host routes keep priority', async () => {
  const ownerId = process.env.DEFAULT_OWNER_USER_ID ?? 'owner-1';
  const webhooks = contributions();
  const calls = [];
  await webhooks.activate(
    admission([
      {
        type: 'webhook',
        id: 'owner-status',
        path: 'admin/status',
        methods: ['GET'],
        action: { method: 'owner.status' },
      },
    ]),
    async (_pluginInstanceId, _method, params) => {
      calls.push(params);
      return { status: 200, body: { ok: true } };
    },
  );
  const app = await appFor(webhooks);
  app.get('/api/plugins/:pluginId/config', async () => ({ route: 'fixed' }));

  const fixed = await app.inject({ method: 'GET', url: '/api/plugins/dev.clowder.webhook-fixture/config' });
  assert.deepEqual(fixed.json(), { route: 'fixed' });
  const unauthorized = await app.inject({
    method: 'GET',
    url: '/api/plugins/dev.clowder.webhook-fixture/admin/status',
  });
  assert.equal(unauthorized.statusCode, 401);

  const authorized = await app.inject({
    method: 'GET',
    url: '/api/plugins/dev.clowder.webhook-fixture/admin/status',
    headers: { 'x-cat-cafe-user': ownerId },
  });
  assert.equal(authorized.statusCode, 200);
  assert.deepEqual(calls[0].request.principal, { kind: 'owner', id: ownerId });
  assert.equal(calls[0].request.headers['x-cat-cafe-user'], undefined);
});

test('reserved declarations fail activation and invalid or slow plugin responses fail closed', async () => {
  const reserved = contributions();
  await assert.rejects(
    reserved.activate(
      admission([
        {
          type: 'webhook',
          id: 'reserved',
          path: 'actions/run',
          methods: ['POST'],
          action: { method: 'reserved.run' },
        },
      ]),
      async () => ({ status: 200 }),
    ),
    /reserved/i,
  );

  const webhooks = contributions();
  await webhooks.activate(
    admission([
      {
        type: 'webhook',
        id: 'invalid',
        path: 'failure/invalid',
        methods: ['POST'],
        action: { method: 'failure.invalid' },
        verificationSecretRef: 'WEBHOOK_SECRET',
      },
      {
        type: 'webhook',
        id: 'slow',
        path: 'failure/slow',
        methods: ['POST'],
        action: { method: 'failure.slow' },
        verificationSecretRef: 'WEBHOOK_SECRET',
      },
      {
        type: 'webhook',
        id: 'cross-origin-location',
        path: 'failure/location',
        methods: ['POST'],
        action: { method: 'failure.location' },
        verificationSecretRef: 'WEBHOOK_SECRET',
      },
    ]),
    async (_pluginInstanceId, method) => {
      if (method === 'failure.invalid') return { status: 200, headers: { 'set-cookie': 'bad=1' }, body: 'no' };
      if (method === 'failure.location') {
        return { status: 302, headers: { location: 'https://outside.example/redirect' } };
      }
      return new Promise(() => undefined);
    },
  );
  const logs = [];
  const app = await appFor(webhooks, 10, logs);

  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/plugins/dev.clowder.webhook-fixture/failure/invalid' })).statusCode,
    502,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/plugins/dev.clowder.webhook-fixture/failure/slow' })).statusCode,
    504,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/plugins/dev.clowder.webhook-fixture/failure/location' })).statusCode,
    502,
  );

  const warnings = logs.filter((entry) => entry.level === 40 && entry.pluginId === 'dev.clowder.webhook-fixture');
  assert.equal(warnings.length, 3);
  assert.deepEqual(
    warnings.map((entry) => entry.contributionId),
    ['invalid', 'slow', 'cross-origin-location'],
  );
  assert.equal(warnings[0].validationError, 'response header set-cookie is not allowed');
  assert.equal(warnings[1].msg, 'Plugin webhook timed out');
  assert.equal(warnings[2].validationError, 'response location must be same-origin and relative');
  for (const warning of warnings) {
    assert.equal(Object.hasOwn(warning, 'headers'), false);
    assert.equal(Object.hasOwn(warning, 'body'), false);
  }
});
