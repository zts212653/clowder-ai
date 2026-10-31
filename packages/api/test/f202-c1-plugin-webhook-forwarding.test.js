import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
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

// Runtime-boundary tests only: real manifest admission also requires the paired
// plugin-contract schema update before dynamic declarations can be installed.
function route(id, path, methods = ['GET'], anonymous = false) {
  return {
    type: 'webhook',
    id,
    path,
    methods,
    action: { method: id },
    ...(anonymous ? { verificationSecretRef: 'WEBHOOK_SECRET' } : {}),
  };
}

async function dynamicFixture(declared) {
  const webhooks = contributions();
  const calls = [];
  await webhooks.activate(admission(declared), async (_instance, method, params) => {
    calls.push({ method, request: params.request });
    return { status: 200, body: { handler: method, path: params.request.path } };
  });
  return { webhooks, calls, app: await appFor(webhooks) };
}
const fixturePrefix = '/api/plugins/dev.clowder.webhook-fixture/';
const ownerHeaders = () => ({
  'x-cat-cafe-user': process.env.DEFAULT_OWNER_USER_ID ?? 'owner-1',
  origin: 'http://localhost:5173',
});

test('dynamic path forwards the raw encoded identifier as one segment with Host owner identity', async () => {
  const { app, calls, webhooks } = await dynamicFixture([route('inspect', 'cases/:subjectKey')]);
  const path = `cases/${encodeURIComponent('pr:owner/repo#42')}`;
  const denied = await app.inject({ method: 'GET', url: fixturePrefix + path });
  assert.equal(denied.statusCode, 401);
  assert.equal(calls.length, 0);
  const response = await app.inject({ method: 'GET', url: fixturePrefix + path, headers: ownerHeaders() });
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0].request.path, path);
  assert.deepEqual(calls[0].request.principal, { kind: 'owner', id: ownerHeaders()['x-cat-cafe-user'] });
  assert.equal(calls[0].request.headers['x-cat-cafe-user'], undefined);
  webhooks.deactivate('pi_webhook');
  assert.equal(
    (await app.inject({ method: 'GET', url: fixturePrefix + path, headers: ownerHeaders() })).statusCode,
    404,
  );
});

test('same declared path chooses the handler for the requested method and reports the full Allow set', async () => {
  const { app, calls } = await dynamicFixture([
    route('read', 'records/item', ['GET'], true),
    route('patch', 'records/item', ['PATCH'], true),
  ]);
  const response = await app.inject({ method: 'PATCH', url: `${fixturePrefix}records/item` });
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0].method, 'patch');
  const wrongMethod = await app.inject({ method: 'DELETE', url: `${fixturePrefix}records/item` });
  assert.equal(wrongMethod.statusCode, 405);
  assert.deepEqual(wrongMethod.headers.allow.split(', ').sort(), ['GET', 'PATCH']);
  assert.equal(calls.length, 1);
});

test('each method retains its declared owner or anonymous authority', async () => {
  const { app, calls } = await dynamicFixture([
    route('public', 'records/:id', ['POST'], true),
    route('private', 'records/admin', ['GET']),
  ]);
  assert.equal((await app.inject({ method: 'POST', url: `${fixturePrefix}records/42` })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `${fixturePrefix}records/admin` })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: `${fixturePrefix}records/admin` })).statusCode, 200);
  assert.equal(calls.length, 2);
});

test('encoded fixed-path aliases cannot fall through to an anonymous parameter route', async () => {
  const { app, calls } = await dynamicFixture([
    route('public', 'records/:id', ['POST'], true),
    route('private', 'records/admin', ['GET']),
  ]);
  for (const encoded of ['%61dmin', 'ad%6Din', '%61%64%6d%69%6e']) {
    for (const method of ['GET', 'POST']) {
      const response = await app.inject({ method, url: `${fixturePrefix}records/${encoded}` });
      assert.equal(response.statusCode, 404, `${method} ${encoded}`);
    }
  }
  assert.equal(calls.length, 0);
  const valid = await app.inject({ method: 'POST', url: `${fixturePrefix}records/%34%32` });
  assert.equal(valid.statusCode, 200);
  assert.equal(calls[0].request.path, 'records/%34%32');
});

test('dynamic matching rejects structural path aliases and unsafe single-decoded identifiers', async () => {
  const { app, calls } = await dynamicFixture([route('read', 'records/:id', ['GET'], true)]);
  for (const path of [
    'records/',
    'records/a/b',
    '%72ecords/a',
    'records%2Fa',
    'records/%2e%2e',
    'records/%252F',
    'records/%5c',
    'records/%00',
    'records/a%2F..%2Fb',
    'records/a%2F%2Fb',
  ]) {
    const response = await app.inject({ method: 'GET', url: fixturePrefix + path });
    assert.equal(response.statusCode, 404, path);
  }
  assert.equal(calls.length, 0);
  const valid = await app.inject({ method: 'GET', url: `${fixturePrefix}records/owner%2Frepo` });
  assert.equal(valid.statusCode, 200);
  assert.equal(calls[0].request.path, 'records/owner%2Frepo');
});

for (const [name, declarations] of [
  ['dynamic first segment', [route('bad', ':root/item')]],
  ['partial parameter', [route('bad', 'records/a:id')]],
  ['duplicate parameter', [route('bad', 'records/:id/:id')]],
  ['equivalent patterns', [route('one', 'records/:id'), route('two', 'records/:other')]],
  ['crossing patterns', [route('one', 'records/:id/latest'), route('two', 'records/admin/:action')]],
]) {
  test(`activation refuses ${name}`, async () => {
    await assert.rejects(
      contributions().activate(admission(declarations), async () => ({ status: 200 })),
      { code: 'PROTOCOL_VIOLATION' },
    );
  });
}

function packedManifest(routes) {
  return {
    pluginId: 'dev.clowder.http-pairing',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'HTTP pairing',
    runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
    contributions: routes,
    features: [
      {
        id: 'http',
        name: 'HTTP',
        resources: [],
        capabilities: [],
        contributions: routes.map(({ type, id }) => ({ type, id })),
      },
    ],
  };
}

test('packed contract and Host activate and route underscore-prefixed parameter names', async () => {
  for (const name of ['_', '_id', '_2']) {
    const routes = [route('read', `records/:${name}`)];
    const validated = validateManifest(packedManifest(routes));
    assert.equal(validated.valid, true, JSON.stringify(validated.errors));
    const { app, calls } = await dynamicFixture(routes);
    const response = await app.inject({
      method: 'GET',
      url: `${fixturePrefix}records/owner%2Frepo`,
      headers: ownerHeaders(),
    });
    assert.equal(response.statusCode, 200, name);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'read');
    assert.equal(calls[0].request.path, 'records/owner%2Frepo');
  }
});

test('packed contract and Host reject same-method fixed/parameter overlap', async () => {
  const routes = [route('fixed', 'records/admin'), route('parameter', 'records/:id')];
  assert.equal(validateManifest(packedManifest(routes)).valid, false);
  await assert.rejects(
    contributions().activate(admission(routes), async () => ({})),
    { code: 'PROTOCOL_VIOLATION' },
  );
});

test('packed contract and Host admit equivalent parameters on distinct methods', async () => {
  const routes = [route('read', 'records/:id'), route('patch', 'records/:name', ['PATCH'])];
  const validated = validateManifest(packedManifest(routes));
  assert.equal(validated.valid, true, JSON.stringify(validated.errors));
  const { app, calls } = await dynamicFixture(routes);
  for (const method of ['GET', 'PATCH']) {
    const response = await app.inject({ method, url: `${fixturePrefix}records/a`, headers: ownerHeaders() });
    assert.equal(response.statusCode, 200);
  }
  assert.deepEqual(
    calls.map((call) => call.method),
    ['read', 'patch'],
  );
});

test('packed contract and Host select method before fixed versus parameter path', async () => {
  const routes = [route('read', 'records/admin'), route('write', 'records/:id', ['POST'])];
  assert.equal(validateManifest(packedManifest(routes)).valid, true);
  const { app, calls } = await dynamicFixture(routes);
  const noOrigin = await app.inject({
    method: 'POST',
    url: `${fixturePrefix}records/admin`,
    headers: { 'x-cat-cafe-user': ownerHeaders()['x-cat-cafe-user'] },
  });
  assert.equal(noOrigin.statusCode, 403);
  assert.equal(calls.length, 0);
  const response = await app.inject({ method: 'POST', url: `${fixturePrefix}records/admin`, headers: ownerHeaders() });
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0].method, 'write');
  const denied = await app.inject({ method: 'GET', url: `${fixturePrefix}records/admin` });
  assert.equal(denied.statusCode, 401);
  const missing = await app.inject({ method: 'DELETE', url: `${fixturePrefix}records/admin`, headers: ownerHeaders() });
  assert.equal(missing.statusCode, 405);
  assert.deepEqual(missing.headers.allow.split(', ').sort(), ['GET', 'POST']);
});

// The installed contract validates generic declarations; package business routes belong to package tests.
test('declared parameter routes preserve encoded paths and authenticated owner identity', async () => {
  const samples = [
    { method: 'GET', path: 'records/:id', value: 'id-42' },
    { method: 'POST', path: 'records/:id/action', value: 'pr:owner/repo#42' },
    { method: 'DELETE', path: 'records/:id', value: 'owner/repo' },
  ];
  const routes = samples.map(({ method, path }, i) => route(`route-${i}`, path, [method]));
  const validation = validateManifest(packedManifest(routes));
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const { app, calls } = await dynamicFixture(routes);
  for (const [i, { method, path, value }] of samples.entries()) {
    const rawPath = path.replace(':id', encodeURIComponent(value));
    const denied = await app.inject({
      method,
      url: fixturePrefix + rawPath,
      headers: { origin: 'http://localhost:5173' },
    });
    assert.equal(denied.statusCode, 401, `${method} ${rawPath}`);
    assert.equal(calls.length, i);
    const response = await app.inject({ method, url: fixturePrefix + rawPath, headers: ownerHeaders() });
    assert.equal(response.statusCode, 200, `${method} ${rawPath}`);
    assert.equal(calls[i].method, `route-${i}`);
    assert.equal(calls[i].request.path, rawPath);
    assert.deepEqual(calls[i].request.principal, { kind: 'owner', id: ownerHeaders()['x-cat-cafe-user'] });
  }
});
