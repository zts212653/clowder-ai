import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';

export async function findFreePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  server.close();
  await once(server, 'close');
  return address.port;
}

async function pageScriptsReady(response, url) {
  // A route-level 200 can precede its client chunks. Keep the density fixture's
  // stricter readiness condition: at least one script, with every script fully available.
  const html = await response.text();
  const scriptUrls = Array.from(
    html.matchAll(/<script[^>]+src="([^"]+)"/g),
    ([, source]) => new URL(source.replaceAll('&amp;', '&'), url),
  );
  if (scriptUrls.length === 0) return false;
  const scriptResponses = await Promise.all(scriptUrls.map((scriptUrl) => fetch(scriptUrl)));
  const scriptsReady = scriptResponses.every((scriptResponse) => scriptResponse.ok);
  await Promise.all(scriptResponses.map((scriptResponse) => scriptResponse.arrayBuffer()));
  return scriptsReady;
}

export async function waitForPage(url, server, output, { timeoutMs = 180_000, readiness = 'response' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next.js exited before readiness:\n${output.join('')}`);
    try {
      const response = await fetch(url);
      if (response.ok) {
        switch (readiness) {
          case 'response':
            return;
          case 'body':
            await response.arrayBuffer();
            return;
          case 'scripts':
            if (await pageScriptsReady(response, url)) return;
            break;
        }
      }
    } catch {
      // The server is still compiling or has not opened its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}:\n${output.join('')}`);
}

export async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

export function createTestChildEnvironment(overrides = {}) {
  // Node's test-runner coordination state must not reach the application or Chromium.
  return Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(([key]) => !key.startsWith('NODE_TEST_')),
  );
}

export function assertNoTestRunnerEnvironment(childEnv, childName) {
  assert.deepEqual(
    Object.keys(childEnv).filter((key) => key.startsWith('NODE_TEST_')),
    [],
    `${childName} must not inherit Node test-runner coordination state`,
  );
}
