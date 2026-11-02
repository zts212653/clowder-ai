import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, test } from 'node:test';
import { fetchPluginNetworkResource } from '../dist/domains/plugin/plugin-network-fetch.js';

const originalUrl = process.env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_URL;
const originalToken = process.env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_TOKEN;

afterEach(() => {
  if (originalUrl === undefined) delete process.env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_URL;
  else process.env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_URL = originalUrl;
  if (originalToken === undefined) delete process.env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_TOKEN;
  else process.env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_TOKEN = originalToken;
});

test('desktop plugin fetch uses the authenticated loopback bridge without touching the target directly', async (t) => {
  let received;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = {
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"plugins":[]}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  process.env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_URL = `http://127.0.0.1:${address.port}`;
  process.env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_TOKEN = 'desktop-secret';

  const response = await fetchPluginNetworkResource(
    'https://raw.githubusercontent.com/zts212653/clowder-ai-plugins/main/catalog/catalog.json',
  );

  assert.equal(await response.text(), '{"plugins":[]}');
  assert.deepEqual(received, {
    authorization: 'Bearer desktop-secret',
    body: { url: 'https://raw.githubusercontent.com/zts212653/clowder-ai-plugins/main/catalog/catalog.json' },
  });
});

test('desktop bridge configuration fails closed when only one credential is present', async () => {
  process.env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_URL = 'http://127.0.0.1:12345';
  delete process.env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_TOKEN;
  await assert.rejects(
    fetchPluginNetworkResource('https://registry.npmjs.org/a/-/a-1.0.0.tgz'),
    /configuration is incomplete/,
  );
});

test('desktop bridge accepts bodyless HTTP statuses without an uncaught Response constructor error', async (t) => {
  const statuses = [204, 205, 304];
  let index = 0;
  const server = http.createServer((_request, response) => {
    response.writeHead(statuses[index++]).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  process.env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_URL = `http://127.0.0.1:${address.port}`;
  process.env.CAT_CAFE_PLUGIN_NETWORK_BRIDGE_TOKEN = 'desktop-secret';

  for (const status of statuses) {
    const response = await fetchPluginNetworkResource('https://registry.npmjs.org/a/-/a-1.0.0.tgz');
    assert.equal(response.status, status);
    assert.equal(await response.text(), '');
  }
});
