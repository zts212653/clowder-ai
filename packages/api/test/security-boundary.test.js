import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

async function waitForMatch(child, regex, { timeoutMs }) {
  let output = '';
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, timeoutMs);

  const onData = (chunk) => {
    output += chunk.toString();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  try {
    while (!timedOut) {
      const match = output.match(regex);
      if (match) {
        return { match, output };
      }
      // avoid busy loop
      await delay(25);
    }
    throw new Error(`Timed out waiting for output matching ${regex}`);
  } finally {
    clearTimeout(timeout);
    child.stdout?.off('data', onData);
    child.stderr?.off('data', onData);
  }
}

async function canBindLoopback() {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      if (code === 'EPERM' || code === 'EACCES') {
        resolve(false);
      } else {
        resolve(true);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

test('API binds to 127.0.0.1 by default', async (t) => {
  if (!(await canBindLoopback())) {
    t.skip('Environment blocks 127.0.0.1 bind (sandbox EPERM/EACCES). Run this test outside sandbox.');
    return;
  }

  const apiDir = path.resolve(process.cwd());
  const childEnv = { ...process.env, API_SERVER_PORT: '0', MEMORY_STORE: '1', PREVIEW_GATEWAY_PORT: '0' };
  delete childEnv.API_SERVER_HOST;
  delete childEnv.REDIS_URL;
  delete childEnv.CAT_CAFE_REDIS_TEST_ISOLATED;

  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: apiDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.once('error', (err) => {
    throw err;
  });

  try {
    const { match } = await waitForMatch(child, /Server (?:listening at|running on) http:\/\/([^:]+):(\d+)/, {
      timeoutMs: 5000,
    });

    const host = match[1];
    const port = Number(match[2]);

    assert.equal(host, '127.0.0.1');
    assert.ok(Number.isInteger(port) && port > 0);

    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(2000)]);
  }
});
