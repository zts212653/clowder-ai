const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createPluginNetworkBridge } = require('./plugin-network-bridge');
const ServiceManager = require('./service-manager');

async function request(endpoint, token, target) {
  return fetch(`${endpoint}/fetch`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ url: target }),
  });
}

function rawRequest(endpoint, token, target) {
  const url = new URL('/fetch', endpoint);
  const body = Buffer.from(JSON.stringify({ url: target }));
  const request = require('node:http').request(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'content-length': body.byteLength,
    },
  });
  request.on('error', () => {});
  request.end(body);
  return request;
}

test('bridges the canonical catalog through Electron net.fetch on loopback', async (t) => {
  const calls = [];
  const bridge = createPluginNetworkBridge({
    netFetch: async (url, init) => {
      calls.push([String(url), init]);
      return new Response('{"plugins":[]}', {
        headers: { 'content-type': 'application/json', 'content-length': '14' },
      });
    },
  });
  const binding = await bridge.start();
  t.after(() => bridge.close());

  const response = await request(
    binding.endpoint,
    binding.token,
    'https://raw.githubusercontent.com/zts212653/clowder-ai-plugins/main/catalog/catalog.json',
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"plugins":[]}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].signal.aborted, false);
});

test('rejects missing credentials and non-plugin destinations before Electron fetch', async (t) => {
  let calls = 0;
  const bridge = createPluginNetworkBridge({
    netFetch: async () => {
      calls += 1;
      return new Response('unexpected');
    },
  });
  const binding = await bridge.start();
  t.after(() => bridge.close());

  const unauthorized = await fetch(`${binding.endpoint}/fetch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://registry.npmjs.org/package.tgz' }),
  });
  const forbidden = await request(binding.endpoint, binding.token, 'https://example.com/private');

  assert.equal(unauthorized.status, 401);
  assert.equal(forbidden.status, 403);
  assert.equal(calls, 0);
});

test('propagates Electron transport failures as loopback transport failures', async (t) => {
  const bridge = createPluginNetworkBridge({
    netFetch: async () => {
      throw new TypeError('proxy connection reset');
    },
  });
  const binding = await bridge.start();
  t.after(() => bridge.close());

  await assert.rejects(
    request(
      binding.endpoint,
      binding.token,
      'https://raw.githubusercontent.com/zts212653/clowder-ai-plugins/main/catalog/catalog.json',
    ),
  );
});

test('destroys a partial loopback response when the Electron body stream fails', async (t) => {
  let pull = 0;
  const bridge = createPluginNetworkBridge({
    netFetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (pull === 0) {
              pull += 1;
              controller.enqueue(new TextEncoder().encode('partial'));
              return;
            }
            controller.error(new TypeError('upstream body reset'));
          },
        }),
        { headers: { 'content-type': 'application/octet-stream' } },
      ),
  });
  const binding = await bridge.start();
  t.after(() => bridge.close());

  await assert.rejects(async () => {
    const response = await request(
      binding.endpoint,
      binding.token,
      'https://raw.githubusercontent.com/zts212653/clowder-ai-plugins/main/catalog/catalog.json',
    );
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  });
  assert.equal(pull, 1);
});

test('aborts Electron fetch when the client disconnects after sending the complete request', async () => {
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  let abortedResolve;
  const aborted = new Promise((resolve) => {
    abortedResolve = resolve;
  });
  const bridge = createPluginNetworkBridge({
    netFetch: async (_url, init) => {
      startedResolve();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => {
            abortedResolve();
            reject(init.signal.reason ?? new Error('aborted'));
          },
          { once: true },
        );
      });
    },
  });
  const binding = await bridge.start();
  const client = rawRequest(
    binding.endpoint,
    binding.token,
    'https://raw.githubusercontent.com/zts212653/clowder-ai-plugins/main/catalog/catalog.json',
  );
  await started;
  client.destroy();
  await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('not aborted')), 250))]);
  await bridge.close();
});

test('closing the bridge aborts every in-flight Electron fetch before resolving', async () => {
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  let abortedResolve;
  const aborted = new Promise((resolve) => {
    abortedResolve = resolve;
  });
  const bridge = createPluginNetworkBridge({
    netFetch: async (_url, init) => {
      startedResolve();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => {
            abortedResolve();
            reject(init.signal.reason ?? new Error('aborted'));
          },
          { once: true },
        );
      });
    },
  });
  const binding = await bridge.start();
  rawRequest(
    binding.endpoint,
    binding.token,
    'https://raw.githubusercontent.com/zts212653/clowder-ai-plugins/main/catalog/catalog.json',
  );
  await started;
  await Promise.all([bridge.close(), aborted]);
});

for (const declaredLength of [String(32 * 1024 * 1024 + 1), 'not-a-number']) {
  test(`rejects declared package length ${declaredLength} and releases the upstream body`, async () => {
    let upstreamAborted = false;
    let bodyCancelled = false;
    const bridge = createPluginNetworkBridge({
      netFetch: async (_url, init) => {
        init.signal.addEventListener('abort', () => {
          upstreamAborted = true;
        });
        return new Response(
          new ReadableStream({
            cancel() {
              bodyCancelled = true;
            },
          }),
          { headers: { 'content-length': declaredLength } },
        );
      },
    });
    const binding = await bridge.start();

    const response = await request(binding.endpoint, binding.token, 'https://registry.npmjs.org/a/-/a.tgz');
    assert.equal(response.status, 413);
    await bridge.close();
    assert.equal(upstreamAborted, true);
    assert.equal(bodyCancelled, true);
  });
}

test('cancels a streaming catalog response that crosses the bounded body limit', async () => {
  let upstreamAborted = false;
  let bodyCancelled = false;
  const bridge = createPluginNetworkBridge({
    netFetch: async (_url, init) => {
      init.signal.addEventListener('abort', () => {
        upstreamAborted = true;
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(256 * 1024 + 1));
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
      );
    },
  });
  const binding = await bridge.start();

  await assert.rejects(
    request(
      binding.endpoint,
      binding.token,
      'https://raw.githubusercontent.com/zts212653/clowder-ai-plugins/main/catalog/catalog.json',
    ),
  );
  await bridge.close();
  assert.equal(upstreamAborted, true);
  assert.equal(bodyCancelled, true);
});

test('ServiceManager gives the API an ephemeral bridge credential and closes it with owned services', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-network-bridge-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const manager = new ServiceManager(userData, {
    frontendPort: 1,
    apiPort: 2,
    pluginNetworkFetch: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
  });

  await manager._startPluginNetworkBridge();
  const env = manager._buildApiEnv(userData);
  const endpoint = env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_URL;
  assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_TOKEN.length >= 32);

  await manager.stopAll();
  await assert.rejects(fetch(`${endpoint}/fetch`));
});
