import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { SecretRemoteTransport } from '../src/secret-remote-transport.js';

test('HTTP/SSE auto negotiation does not retry an authentication rejection', async () => {
  const methods: string[] = [];
  const server = createServer((req, res) => {
    methods.push(req.method ?? '');
    res.writeHead(401).end('fixture denial');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const transport = new SecretRemoteTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {}, 'auto');
  transport.onerror = () => {};
  try {
    await transport.start();
    await assert.rejects(transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    assert.deepEqual(methods, ['POST']);
  } finally {
    await transport.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
