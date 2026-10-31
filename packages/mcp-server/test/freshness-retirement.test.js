import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { test } from 'node:test';
import { createServer } from '../dist/index.js';
import { useInvocationAuth } from './helpers/invocation-auth.js';

test('registered read tools never poll or append a retired freshness notice', async (t) => {
  useInvocationAuth(t);
  const requests = [];
  const api = createHttpServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ threads: [] }));
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const original = process.env.CAT_CAFE_API_URL;
  process.env.CAT_CAFE_API_URL = `http://127.0.0.1:${api.address().port}`;
  t.after(async () => {
    if (original === undefined) delete process.env.CAT_CAFE_API_URL;
    else process.env.CAT_CAFE_API_URL = original;
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
  });
  const server = createServer();
  const tool = server._registeredTools.cat_cafe_list_threads;
  for (let i = 0; i < 12; i++) {
    const result = await tool.handler({}, { signal: new AbortController().signal });
    assert.notEqual(result.isError, true);
    assert.equal(result.content.length, 1, 'the source result has no auxiliary notice block');
    assert.doesNotMatch(result.content[0].text, /freshness notice/i);
  }
  assert.equal(requests.length, 12, 'crossing both old 5-call thresholds must not make extra HTTP calls');
  assert.ok(requests.every((path) => !path.includes('freshness')));
});
