import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  assertNoTestRunnerEnvironment,
  createTestChildEnvironment,
  findFreePort,
  stopServer,
  waitForPage,
} from './browser/_harness.mjs';

async function startHttpFixture(t, handler) {
  const server = createServer(handler);
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}/page` };
}

test('findFreePort releases a loopback port that a server can bind', async (t) => {
  const port = await findFreePort();
  const server = createServer();
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  assert.equal(server.address().port, port);
});

test('response readiness retries unsuccessful HTTP responses', async (t) => {
  let requests = 0;
  const { url } = await startHttpFixture(t, (_request, response) => {
    response.writeHead(++requests === 1 ? 503 : 200);
    response.end('fixture');
  });
  await waitForPage(url, { exitCode: null }, [], { timeoutMs: 3_000 });
  assert.equal(requests, 2);
});

test('body readiness waits for the full response after its headers arrive', async (t) => {
  const { server, url } = await startHttpFixture(t, (_request, response) => response.write('partial'));
  const requested = once(server, 'request');
  const headersReceived = Promise.withResolvers();
  const fetchPage = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (...args) => {
    const response = await fetchPage(...args);
    headersReceived.resolve();
    return response;
  });
  let ready = false;
  const waiting = waitForPage(url, { exitCode: null }, [], { readiness: 'body', timeoutMs: 3_000 }).then(() => {
    ready = true;
  });
  const [, response] = await requested;
  await headersReceived.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ready, false);
  response.end(' complete');
  await waiting;
  assert.equal(ready, true);
});

test('scripts readiness requires script tags and retries until every script is available', async (t) => {
  let pages = 0;
  const scripts = [];
  const { url } = await startHttpFixture(t, (request, response) => {
    if (request.url === '/page') {
      pages += 1;
      response.end(
        pages === 1
          ? '<html>compiling</html>'
          : '<script src="/client.js?first=1&amp;second=2"></script><script src="/other.js"></script>',
      );
      return;
    }
    scripts.push(request.url);
    response.writeHead(pages === 2 && request.url.startsWith('/client.js') ? 503 : 200);
    response.end('fixture script');
  });
  await waitForPage(url, { exitCode: null }, [], { readiness: 'scripts', timeoutMs: 3_000 });
  assert.equal(pages, 3);
  assert.deepEqual(scripts, ['/client.js?first=1&second=2', '/other.js', '/client.js?first=1&second=2', '/other.js']);
});

test('readiness reports a server exit with captured diagnostics', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(7)'], { env: createTestChildEnvironment() });
  await once(child, 'exit');
  await assert.rejects(waitForPage('http://127.0.0.1:1/page', child, ['fixture failed']), /fixture failed/);
});

test('readiness honors its timeout and includes the URL and captured output', async (t) => {
  const { url } = await startHttpFixture(t, (_request, response) => {
    response.writeHead(503);
    response.end();
  });
  await assert.rejects(waitForPage(url, { exitCode: null }, ['still compiling'], { timeoutMs: 20 }), (error) => {
    assert.ok(error.message.includes(`Timed out waiting for ${url}`));
    assert.ok(error.message.includes('still compiling'));
    return true;
  });
});

test('stopServer terminates its child and accepts an already completed child', async (t) => {
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], {
    env: createTestChildEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await once(child.stdout, 'data');
  await stopServer(child);
  assert.ok(child.exitCode !== null || child.signalCode !== null);

  const completed = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: createTestChildEnvironment() });
  await once(completed, 'exit');
  await stopServer(completed);
  await stopServer(undefined);
});

test('child environments remove inherited and overridden test-runner state without mutating the parent', () => {
  const parentContext = process.env.NODE_TEST_CONTEXT;
  const childEnv = createTestChildEnvironment({ NODE_TEST_ISSUE1997: 'coordination', ISSUE1997_FIXTURE: 'kept' });
  assert.equal(childEnv.ISSUE1997_FIXTURE, 'kept');
  assert.equal(process.env.NODE_TEST_CONTEXT, parentContext);
  assertNoTestRunnerEnvironment(childEnv, 'fixture');
  assert.throws(
    () => assertNoTestRunnerEnvironment({ NODE_TEST_ISSUE1997: 'coordination' }, 'fixture child'),
    /fixture child must not inherit/,
  );
});
