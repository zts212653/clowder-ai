import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { readRuntimeServiceReadiness } from '../dist/domains/runtime-deployment/RuntimeDeploymentServiceReadiness.js';

test('current Web health can degrade and recover without rewriting an old boot', async () => {
  const web = createServer((_request, response) => {
    response.writeHead(200);
    response.end('ready');
  });
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve));
  const port = web.address().port;
  const query = (isApiReady) => readRuntimeServiceReadiness({ isApiReady, webPort: port });
  try {
    assert.deepEqual(await query(async () => true), ['api', 'web']);
    assert.deepEqual(await query(async () => false), ['web']);
  } finally {
    await new Promise((resolve) => web.close(resolve));
  }
  assert.deepEqual(await query(async () => true), ['api'], 'Web cannot remain ready from its old startup report');
});

test('unknown API health and an invalid Web port fail closed per service', async () => {
  assert.deepEqual(
    await readRuntimeServiceReadiness({
      isApiReady: async () => {
        throw new Error('redis down');
      },
      webPort: Number.NaN,
    }),
    [],
  );
});
