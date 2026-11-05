import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { waitForPreviewFixture } from './lib/preview-fixture-readiness.mjs';

async function serverFixture(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

test('fixture barrier rejects a reachable stale server until setup publishes this run marker', async (t) => {
  let requests = 0;
  const port = await serverFixture(t, (_request, response) => {
    requests += 1;
    response.end(requests === 1 ? 'previous fixture' : 'current fixture is ready');
  });
  await waitForPreviewFixture({
    port,
    expectedBody: 'current fixture is ready',
    deadline: performance.now() + 2_000,
    diagnostics: () => assert.fail('a ready fixture needs no failure diagnostics'),
  });
  assert.ok(requests >= 2, 'port reachability must not open the cleanup assertions');
});

test('fixture barrier bounds a stalled response and preserves startup diagnostics', async (t) => {
  const port = await serverFixture(t, () => {});
  const start = performance.now();
  await assert.rejects(
    waitForPreviewFixture({
      port,
      expectedBody: 'ready',
      deadline: start + 150,
      diagnostics: () => 'start.status=starting; log: storage setup incomplete',
    }),
    /startup deadline:[\s\S]*start.status=starting; log: storage setup incomplete/,
  );
  assert.ok(performance.now() - start < 2_000, 'the last HTTP request cannot outlive the startup budget');
});

test('an exhausted startup budget is not renewed after start returns', async () => {
  await assert.rejects(
    waitForPreviewFixture({
      port: 0,
      expectedBody: 'ready',
      deadline: performance.now() - 1,
      diagnostics: () => 'start consumed the budget',
    }),
    /no response before the startup deadline\nstart consumed the budget/,
  );
});
