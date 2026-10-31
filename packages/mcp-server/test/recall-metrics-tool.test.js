import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { test } from 'node:test';
import { createServer } from '../dist/index.js';
import { callbackGet } from '../dist/tools/callback-tools.js';
import { handleGetRecallMetrics } from '../dist/tools/recall-metrics-tool.js';
import { useInvocationAuth } from './helpers/invocation-auth.js';

async function endpoint(t, handler) {
  const server = createHttpServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
function configure(t, url) {
  useInvocationAuth(t);
  const previous = process.env.CAT_CAFE_API_URL;
  process.env.CAT_CAFE_API_URL = url;
  t.after(() => {
    if (previous === undefined) delete process.env.CAT_CAFE_API_URL;
    else process.env.CAT_CAFE_API_URL = previous;
  });
}
const readBudget = { timeoutMs: 120, maxResponseBytes: 65536 };

test('named metrics tool is registered as a closed aggregate read', () => {
  const tool = createServer()._registeredTools.cat_cafe_get_recall_metrics;
  assert.ok(tool, 'named metrics read must use the canonical MCP registry');
  assert.equal(tool.inputSchema.parse({}).days, 30);
  for (const input of [
    { days: 91 },
    { days: 1.5 },
    { url: 'http://example.invalid' },
    { method: 'POST' },
    { env: {} },
    { userId: 'other' },
  ])
    assert.equal(tool.inputSchema.safeParse(input).success, false);
});

test('bounded callback deadline includes a slow response body', async (t) => {
  const url = await endpoint(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"ready":');
    const timer = setTimeout(() => response.end('true}'), 450);
    response.on('close', () => clearTimeout(timer));
  });
  configure(t, url);
  const result = await callbackGet('/api/callbacks/get-recall-metrics', {}, { readBudget });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /budget|timeout|deadline/i);
});

test('bounded callback limits both successful and failed response bodies', async (t) => {
  let failed = false;
  const url = await endpoint(t, (_request, response) => {
    response.writeHead(failed ? 500 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ text: 'x'.repeat(70000) }));
  });
  configure(t, url);
  for (failed of [false, true]) {
    const result = await callbackGet('/api/callbacks/get-recall-metrics', {}, { readBudget });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /65536|64 KiB|limit/i);
    assert.ok(Buffer.byteLength(result.content[0].text) <= 65536);
  }
  failed = false;
  const ordinary = await callbackGet('/api/callbacks/ordinary');
  assert.equal(ordinary.isError, undefined);
  assert.ok(Buffer.byteLength(ordinary.content[0].text) > 65536);
});

test('bounded callback never follows redirects to another endpoint', async (t) => {
  let calls = 0;
  const target = await endpoint(t, (_request, response) => {
    calls++;
    response.end('{"unexpected":true}');
  });
  const url = await endpoint(t, (_request, response) => {
    response.writeHead(302, { location: target });
    response.end('redirect refused');
  });
  configure(t, url);
  const result = await callbackGet('/api/callbacks/get-recall-metrics', {}, { readBudget });
  assert.equal(result.isError, true);
  assert.equal(calls, 0);
});

test('bounded callbacks ignore ambient proxies and unsupported tool fields never cause requests', async (t) => {
  let proxyCalls = 0;
  let calls = 0;
  const proxy = await endpoint(t, (_request, response) => {
    proxyCalls++;
    response.end('{}');
  });
  const url = await endpoint(t, (request, response) => {
    calls++;
    assert.equal(request.method, 'GET');
    assert.equal(request.headers['x-callback-token'], 'token-registration-contract');
    response.end('{"fixed":true}');
  });
  configure(t, url);
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    const previous = process.env[name];
    process.env[name] = proxy;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const result = await callbackGet('/api/callbacks/get-recall-metrics', {}, { readBudget });
  assert.equal(result.isError, undefined);
  assert.equal(calls, 1);
  assert.equal(proxyCalls, 0);
  for (const input of [{ url }, { method: 'POST' }, { body: {} }, { headers: {} }, { env: {} }, { userId: 'x' }])
    assert.equal((await handleGetRecallMetrics(input)).isError, true);
  assert.equal(calls, 1);
});

test('the bounded deadline destroys the owned connection without retrying', async (t) => {
  let calls = 0;
  let closed;
  const closedPromise = new Promise((resolve) => {
    closed = resolve;
  });
  const url = await endpoint(t, (_request, response) => {
    calls++;
    response.writeHead(200);
    response.write('{');
    response.on('close', closed);
  });
  configure(t, url);
  const result = await callbackGet('/api/callbacks/get-recall-metrics', {}, { readBudget });
  assert.equal(result.isError, true);
  await Promise.race([
    closedPromise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('bounded connection remained open')), 500);
      timer.unref();
    }),
  ]);
  assert.equal(calls, 1);
});

test('a cancelled read makes no initial request or closes its started connection', async (t) => {
  let calls = 0;
  let ready;
  const readyPromise = new Promise((resolve) => {
    ready = resolve;
  });
  const url = await endpoint(t, (_request, response) => {
    calls++;
    response.writeHead(200);
    response.write('{');
    ready();
  });
  configure(t, url);
  const before = new AbortController();
  before.abort();
  const first = await callbackGet(
    '/api/callbacks/get-recall-metrics',
    {},
    { readBudget: { ...readBudget, signal: before.signal } },
  );
  assert.match(first.content[0].text, /cancelled/);
  assert.equal(calls, 0);
  const active = new AbortController();
  const pending = callbackGet(
    '/api/callbacks/get-recall-metrics',
    {},
    { readBudget: { ...readBudget, signal: active.signal } },
  );
  await readyPromise;
  active.abort();
  assert.match((await pending).content[0].text, /cancelled/);
  assert.equal(calls, 1);
});

test('registered metrics calls do not add an unbounded freshness transport after the fixed read', async (t) => {
  const paths = [];
  const url = await endpoint(t, (request, response) => {
    paths.push(`${request.method} ${request.url}`);
    response.end('{}');
  });
  configure(t, url);
  const tool = createServer()._registeredTools.cat_cafe_get_recall_metrics;
  for (let index = 0; index < 5; index++)
    assert.equal((await tool.handler({}, { signal: new AbortController().signal })).isError, undefined);
  assert.deepEqual(paths, Array(5).fill('GET /api/callbacks/get-recall-metrics?days=30'));
});
