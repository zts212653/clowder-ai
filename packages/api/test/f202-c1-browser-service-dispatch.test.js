import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  BrowserServiceDispatchBudget,
  BrowserServiceDispatcher,
} from '../dist/domains/plugin/browser-service/dispatch.js';
import {
  admitBrowserServiceRequest,
  admitBrowserServiceResponse,
  BROWSER_SERVICE_LIMITS,
} from '../dist/domains/plugin/browser-service/transport-policy.js';
import { currentPluginCallContext, withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { withPluginTransportPurpose } from '../dist/domains/plugin/carrier/plugin-transport-context.js';

const contribution = {
  type: 'browser-service',
  id: 'api',
  action: { method: 'service.http' },
  routes: [
    { method: 'GET', path: '/health', browser: 'service', local: 'omit-origin' },
    { method: 'POST', path: '/write', browser: 'service', local: 'omit-origin' },
    { method: 'GET', path: '/callback', browser: 'callback' },
    { method: 'POST', path: '/exchange', local: 'parent-origin' },
  ],
  credentials: {
    bearer: true,
    cookies: [{ name: 'completion', path: '/callback', httpOnly: true, sameSite: 'Strict', maxAgeSeconds: 300 }],
  },
};
const binding = {
  contributionId: 'api',
  origin: 'http://127.0.0.1:58001',
  parentOrigin: 'http://127.0.0.1:58002',
  clientBuildId: 'test',
  assetDigest: 'test',
  limits: BROWSER_SERVICE_LIMITS,
  async assertCurrent() {},
};
const response = { status: 200, headers: [], bodyBase64: '' };
const request = (overrides = {}) => ({
  version: 1,
  method: 'GET',
  path: '/health',
  rawQuery: '',
  headers: [],
  rawBodyBase64: '',
  ...overrides,
});
const origin = (value) => [{ name: 'origin', value }];
const deferred = () => Promise.withResolvers();
function fixture({
  instanceId = 'one',
  budget = new BrowserServiceDispatchBudget(),
  handler = async () => response,
  current = async () => {},
} = {}) {
  const activation = new AbortController();
  const dispatcher = new BrowserServiceDispatcher({
    instanceId,
    budget,
    contribution,
    binding: { ...binding, assertCurrent: current },
    activationSignal: activation.signal,
    handler: () => handler,
  });
  return { dispatcher, activation };
}
function rejected(run, code = 'BROWSER_SERVICE_INVALID_REQUEST') {
  assert.throws(run, { code });
}

// These are transport-policy tests. The fixture binding is not a listening endpoint or production provider.
test('literal routes preserve duplicate raw query parameters and refuse undeclared targets', () => {
  const accepted = admitBrowserServiceRequest(
    request({ rawQuery: 'tag=a&tag=b&literal=%2B' }),
    'local',
    contribution,
    binding,
  );
  assert.equal(accepted.rawQuery, 'tag=a&tag=b&literal=%2B');
  for (const path of ['/health/extra', 'http://example.invalid/health', '/a/../health', '/%2e%2e/health'])
    rejected(() => admitBrowserServiceRequest(request({ path }), 'local', contribution, binding));
});

test('browser mutations require exact service origin and callbacks never accept a foreign origin', () => {
  const write = request({ method: 'POST', path: '/write' });
  for (const headers of [[], origin(binding.parentOrigin), origin('http://evil.invalid')])
    rejected(() => admitBrowserServiceRequest({ ...write, headers }, 'browser', contribution, binding));
  assert.equal(
    admitBrowserServiceRequest({ ...write, headers: origin(binding.origin) }, 'browser', contribution, binding).path,
    '/write',
  );
  assert.equal(
    admitBrowserServiceRequest(request({ path: '/callback' }), 'browser', contribution, binding).path,
    '/callback',
  );
  rejected(() =>
    admitBrowserServiceRequest(
      request({ path: '/callback', headers: origin('http://evil.invalid') }),
      'browser',
      contribution,
      binding,
    ),
  );
});

test('local dispatch admits only declared local routes and exact parent exchange origin without cookies', () => {
  const exchange = request({ method: 'POST', path: '/exchange', headers: origin(binding.parentOrigin) });
  assert.equal(admitBrowserServiceRequest(exchange, 'local', contribution, binding).path, '/exchange');
  rejected(() => admitBrowserServiceRequest(exchange, 'browser', contribution, binding));
  rejected(() => admitBrowserServiceRequest({ ...exchange, headers: [] }, 'local', contribution, binding));
  rejected(() => admitBrowserServiceRequest(request({ path: '/callback' }), 'local', contribution, binding));
  rejected(() =>
    admitBrowserServiceRequest(
      request({ headers: [{ name: 'cookie', value: 'completion=x' }] }),
      'local',
      contribution,
      binding,
    ),
  );
});

test('browser cookies are stripped to declared names and duplicate business cookies are refused', () => {
  const accepted = admitBrowserServiceRequest(
    request({ headers: [{ name: 'cookie', value: 'host_session=secret; completion=ok; ambient=no' }] }),
    'browser',
    contribution,
    binding,
  );
  assert.deepEqual(accepted.headers, [{ name: 'cookie', value: 'completion=ok' }]);
  rejected(() =>
    admitBrowserServiceRequest(
      request({ headers: [{ name: 'cookie', value: 'completion=a; completion=b' }] }),
      'browser',
      contribution,
      binding,
    ),
  );
});

test('request wire rejects noncanonical base64, GET bodies and header/target budgets before entry', () => {
  const atLimit = request({ method: 'POST', path: '/write', rawBodyBase64: Buffer.alloc(262144).toString('base64') });
  assert.equal(
    admitBrowserServiceRequest(atLimit, 'local', contribution, binding).rawBodyBase64,
    atLimit.rawBodyBase64,
  );
  for (const value of [
    request({ rawBodyBase64: 'YQ==' }),
    request({ method: 'POST', path: '/write', rawBodyBase64: 'YQ' }),
    request({ rawQuery: 'x'.repeat(8193) }),
    request({ headers: [{ name: 'accept', value: 'x'.repeat(8193) }] }),
    request({ headers: [{ name: 'host', value: 'evil' }] }),
  ])
    rejected(() => admitBrowserServiceRequest(value, 'local', contribution, binding));
  rejected(
    () =>
      admitBrowserServiceRequest(
        request({ method: 'POST', path: '/write', rawBodyBase64: Buffer.alloc(262145).toString('base64') }),
        'local',
        contribution,
        binding,
      ),
    'BROWSER_SERVICE_REQUEST_TOO_LARGE',
  );
});

test('responses support large declared bodies but reject overflow, bodyless-status data and external redirects', () => {
  const large = { ...response, bodyBase64: Buffer.alloc(33554432).toString('base64') };
  assert.equal(admitBrowserServiceResponse(large, contribution, binding.origin).bodyBase64, large.bodyBase64);
  rejected(
    () =>
      admitBrowserServiceResponse(
        { ...response, bodyBase64: Buffer.alloc(33554433).toString('base64') },
        contribution,
        binding.origin,
      ),
    'BROWSER_SERVICE_RESPONSE_TOO_LARGE',
  );
  for (const value of [
    { ...response, status: 204, bodyBase64: 'YQ==' },
    { ...response, headers: [{ name: 'location', value: '//evil.invalid' }] },
    { ...response, headers: [{ name: 'access-control-allow-origin', value: '*' }] },
  ])
    rejected(
      () => admitBrowserServiceResponse(value, contribution, binding.origin),
      'BROWSER_SERVICE_INVALID_RESPONSE',
    );
});

test('completion cookies require exact declaration, path, expiry, HttpOnly, SameSite and transport security', () => {
  const cookie = 'completion=ok; Path=/callback; HttpOnly; SameSite=Strict; Max-Age=300';
  const wrap = (value) => ({ ...response, headers: [{ name: 'set-cookie', value }] });
  assert.equal(admitBrowserServiceResponse(wrap(cookie), contribution, binding.origin).headers[0].value, cookie);
  assert.equal(admitBrowserServiceResponse(wrap(cookie.replace('300', '0')), contribution, binding.origin).status, 200);
  for (const value of [
    `${cookie}; Domain=127.0.0.1`,
    cookie.replace('/callback', '/'),
    cookie.replace('300', '301'),
    cookie.replace('; HttpOnly', ''),
    `${cookie}; SameSite=Strict`,
    cookie.replace('completion=', 'host_session='),
  ])
    rejected(
      () => admitBrowserServiceResponse(wrap(value), contribution, binding.origin),
      'BROWSER_SERVICE_INVALID_RESPONSE',
    );
  rejected(
    () => admitBrowserServiceResponse(wrap(cookie), contribution, 'https://127.0.0.1:58001'),
    'BROWSER_SERVICE_INVALID_RESPONSE',
  );
  assert.equal(
    admitBrowserServiceResponse(wrap(`${cookie}; Secure`), contribution, 'https://127.0.0.1:58001').status,
    200,
  );
});

test('unpublished or revoked service rejects before entering a handler without retry', async () => {
  const unpublished = fixture({ handler: null });
  assert.deepEqual(await unpublished.dispatcher.dispatch('local', request()), {
    kind: 'transport-error',
    code: 'BROWSER_SERVICE_UNAVAILABLE',
    effect: 'not_started',
    automaticRetry: false,
  });
  let calls = 0;
  const stopped = fixture({
    handler: async () => {
      calls++;
      return response;
    },
  });
  stopped.activation.abort();
  assert.equal((await stopped.dispatcher.dispatch('local', request())).code, 'BROWSER_SERVICE_REVOKED');
  assert.equal(calls, 0);
});

test('private HTTP handlers receive no native authority and cannot recursively dispatch locally', async () => {
  let seen, nested, retained;
  const f = fixture({
    handler: async (_input, native, context) => {
      seen = { native, inherited: currentPluginCallContext('one'), contextKeys: Object.keys(context).sort() };
      retained = context;
      nested = await f.dispatcher.dispatch('local', request());
      return response;
    },
  });
  const result = await withPluginCallContext(
    'one',
    { catId: 'cat', threadId: 'thread', userId: 'user', invocationId: 'inv', async assertCurrent() {} },
    () => f.dispatcher.dispatch('local', request()),
  );
  assert.equal(result.kind, 'response');
  assert.equal(seen.native, undefined);
  assert.equal(seen.inherited, undefined);
  assert.deepEqual(seen.contextKeys, ['assertCurrent', 'contributionId', 'kind', 'lane', 'requestId', 'signal']);
  assert.equal(nested.code, 'BROWSER_SERVICE_INVALID_REQUEST');
  assert.equal(nested.effect, 'not_started');
  await assert.rejects(retained.assertCurrent, { code: 'BROWSER_SERVICE_REVOKED' });
});

test('browser and verifier descendants remain ineligible for local dispatch after the parent returns', async () => {
  for (const purpose of ['browser', 'verifier', 'local']) {
    const trigger = deferred(),
      result = deferred();
    let calls = 0;
    const f = fixture({
      handler: async () => {
        calls++;
        return response;
      },
    });
    await withPluginTransportPurpose(purpose, async () => {
      void trigger.promise.then(async () => result.resolve(await f.dispatcher.dispatch('local', request())));
    });
    trigger.resolve();
    assert.equal((await result.promise).code, 'BROWSER_SERVICE_INVALID_REQUEST');
    assert.equal(calls, 0);
  }
});

test('late responses after currentness loss have unknown effect and cannot deliver cookies', async () => {
  let current = true;
  const f = fixture({
    current: async () => {
      if (!current) throw Error('revoked');
    },
    handler: async () => {
      current = false;
      return {
        ...response,
        headers: [
          { name: 'set-cookie', value: 'completion=x; Path=/callback; HttpOnly; SameSite=Strict; Max-Age=300' },
        ],
      };
    },
  });
  const result = await f.dispatcher.dispatch('local', request());
  assert.equal(result.kind, 'transport-error');
  assert.equal(result.effect, 'unknown');
  assert.equal(result.automaticRetry, false);
  assert.equal('response' in result, false);
});

test('one entry per instance and two per Host remain occupied after abort until handlers settle', async () => {
  const budget = new BrowserServiceDispatchBudget(),
    enteredA = deferred(),
    enteredB = deferred(),
    releaseA = deferred(),
    releaseB = deferred();
  const a = fixture({
    instanceId: 'a',
    budget,
    handler: async () => {
      enteredA.resolve();
      return releaseA.promise;
    },
  });
  const b = fixture({
    instanceId: 'b',
    budget,
    handler: async () => {
      enteredB.resolve();
      return releaseB.promise;
    },
  });
  const c = fixture({ instanceId: 'c', budget });
  const cancellation = new AbortController();
  const first = a.dispatcher.dispatch('local', request(), cancellation.signal);
  await enteredA.promise;
  const second = b.dispatcher.dispatch('local', request());
  await enteredB.promise;
  assert.equal((await a.dispatcher.dispatch('local', request())).code, 'BROWSER_SERVICE_BUSY');
  assert.equal((await c.dispatcher.dispatch('local', request())).code, 'BROWSER_SERVICE_BUSY');
  cancellation.abort();
  assert.equal((await first).effect, 'unknown');
  assert.equal((await a.dispatcher.dispatch('local', request())).code, 'BROWSER_SERVICE_BUSY');
  assert.equal((await c.dispatcher.dispatch('local', request())).code, 'BROWSER_SERVICE_BUSY');
  releaseA.resolve(response);
  await nextTurn();
  assert.equal((await c.dispatcher.dispatch('local', request())).kind, 'response');
  releaseB.resolve(response);
  assert.equal((await second).kind, 'response');
});

test('ten-second timeout rejects without freeing the underlying handler slot or replaying work', async (t) => {
  const entered = deferred(),
    release = deferred();
  // Keep the isolated test alive while the production deadline deliberately uses unref().
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  let calls = 0;
  const f = fixture({
    handler: async () => {
      calls++;
      entered.resolve();
      return release.promise;
    },
  });
  const started = performance.now();
  const pending = f.dispatcher.dispatch('local', request());
  await entered.promise;
  const result = await pending;
  assert.deepEqual(result, {
    kind: 'transport-error',
    code: 'BROWSER_SERVICE_TIMEOUT',
    effect: 'unknown',
    automaticRetry: false,
  });
  assert.ok(performance.now() - started >= 9900);
  assert.equal((await f.dispatcher.dispatch('local', request())).code, 'BROWSER_SERVICE_BUSY');
  assert.equal(calls, 1);
  release.resolve(response);
  await nextTurn();
  assert.equal((await f.dispatcher.dispatch('local', request())).kind, 'response');
  assert.equal(calls, 2);
});
