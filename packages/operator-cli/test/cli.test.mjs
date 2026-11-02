import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { test } from 'node:test';

const bin = new URL('../bin/cat-cafe.mjs', import.meta.url).pathname;
async function fixture(fn, hostname = '127.0.0.1') {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: body && JSON.parse(body) });
    if (req.headers['x-cat-cafe-user'] === 'redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/' });
      res.end();
      return;
    }
    if (req.headers.cookie === 'expired') res.setHeader('set-cookie', 'cat_cafe_session=new');
    if (req.headers['x-cat-cafe-user'] === 'denied') {
      res.writeHead(403);
      res.end('{"error":"denied"}');
      return;
    }
    if (req.headers['x-cat-cafe-user'] === 'missing-thread') {
      res.writeHead(404);
      res.end('{"error":"Thread not found","code":"THREAD_NOT_FOUND"}');
      return;
    }
    if (req.headers['x-cat-cafe-user'] === 'deleting-thread') {
      res.writeHead(409);
      res.end('{"code":"THREAD_DELETING"}');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        req.url === '/api/session' ? { userId: 'session-owner', csrfToken: 'secret' } : { ok: true, url: req.url },
      ),
    );
  });
  server.listen(0, hostname);
  await once(server, 'listening');
  try {
    await fn(`http://${hostname}:${server.address().port}`, requests);
  } finally {
    server.close();
  }
}
function run(base, args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, ...args], {
      env: { PATH: process.env.PATH, CAT_CAFE_BASE_URL: base, CAT_CAFE_USER: 'owner', ...env },
    });
    let out = '',
      err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
test('commands reach Host HTTP with identity and preserve JSON', async () =>
  fixture(async (base, requests) => {
    for (const args of [
      ['threads', 'list'],
      ['cats', 'list'],
      ['messages', 'list', '--thread', 'a & b', '--limit', '3'],
      ['messages', 'send', '--thread', 't', '--text', 'hello', '--mention', 'opus'],
    ]) {
      const result = await run(base, args);
      assert.equal(result.code, 0, result.err);
      assert.equal(JSON.parse(result.out).ok, true);
    }
    assert.deepEqual(
      requests.map((r) => [r.method, r.url]),
      [
        ['GET', '/api/threads'],
        ['GET', '/api/cats'],
        ['GET', '/api/messages?threadId=a+%26+b&limit=3'],
        ['POST', '/api/messages'],
      ],
    );
    assert.ok(requests.every((r) => r.headers['x-cat-cafe-user'] === 'owner'));
    assert.deepEqual(requests[3].body, { threadId: 't', content: 'hello', mentions: ['opus'] });
  }));
test('whoami distinguishes supplied header from server-verified session', async () =>
  fixture(async (base, requests) => {
    const header = await run(base, ['whoami']);
    assert.equal(header.code, 0);
    assert.deepEqual(JSON.parse(header.out), {
      baseUrl: base,
      userId: 'owner',
      identitySource: 'header',
      verified: false,
    });
    const session = await run(base, ['whoami'], { CAT_CAFE_USER: '', CAT_CAFE_SESSION_COOKIE: 'cat_cafe_session=abc' });
    assert.equal(session.code, 0);
    assert.deepEqual(JSON.parse(session.out), {
      baseUrl: base,
      userId: 'session-owner',
      identitySource: 'session',
      verified: true,
    });
    assert.equal(requests[1].headers.cookie, 'cat_cafe_session=abc');
  }));
test('validation and transport errors have stable exit codes', async () =>
  fixture(async (base, requests) => {
    assert.equal((await run(base, ['messages', 'list', '--thread', 't', '--limit', '0'])).code, 2);
    assert.equal((await run(base, ['messages', 'send', '--thread', 't'])).code, 2);
    assert.equal((await run(base, ['cats', 'list', '--typo'])).code, 2);
    assert.equal(requests.length, 0);
    assert.equal((await run('http://127.0.0.1:1', ['cats', 'list'])).code, 4);
  }));

test('rejects expired sessions before a write and reports HTTP failures', async () =>
  fixture(async (base, requests) => {
    const expired = await run(base, ['messages', 'send', '--thread', 't', '--text', 'hello'], {
      CAT_CAFE_SESSION_COOKIE: 'expired',
    });
    assert.equal(expired.code, 3);
    assert.match(expired.err, /not accepted/);
    assert.deepEqual(
      requests.map((r) => r.url),
      ['/api/session'],
    );
    const denied = await run(base, ['threads', 'list'], { CAT_CAFE_USER: 'denied' });
    assert.equal(denied.code, 3);
    assert.match(denied.err, /HTTP 403/);
    assert.match(denied.err, /error=denied/);
    assert.equal(denied.out, '');
    const missing = await run(base, ['messages', 'list', '--thread', 'missing'], { CAT_CAFE_USER: 'missing-thread' });
    assert.equal(missing.code, 3);
    assert.match(missing.err, /HTTP 404/);
    assert.match(missing.err, /error=Thread not found/);
    assert.match(missing.err, /code=THREAD_NOT_FOUND/);
    assert.equal(missing.out, '');
    const deleting = await run(base, ['messages', 'list', '--thread', 'deleting'], {
      CAT_CAFE_USER: 'deleting-thread',
    });
    assert.equal(deleting.code, 3);
    assert.match(deleting.err, /HTTP 409/);
    assert.match(deleting.err, /code=THREAD_DELETING/);
    assert.equal(deleting.out, '');
  }));

test('remote HTTP cookies require explicit opt-in before any request; header identity remains allowed', async (t) => {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((address) => address?.family === 'IPv4' && !address.internal)?.address;
  if (!address) {
    t.skip('No non-loopback IPv4 interface for the HTTP fixture');
    return;
  }
  await fixture(async (base, requests) => {
    const args = ['messages', 'send', '--thread', 't', '--text', 'hello'];
    const cookieEnv = { CAT_CAFE_SESSION_COOKIE: 'cat_cafe_session=abc' };
    for (const override of ['', '0', 'true']) {
      const denied = await run(base, args, { ...cookieEnv, CAT_CAFE_ALLOW_INSECURE_COOKIE: override });
      assert.equal(denied.code, 2, denied.err);
      assert.match(denied.err, /HTTP.*non-loopback/);
      assert.match(denied.err, /CAT_CAFE_ALLOW_INSECURE_COOKIE=1/);
      assert.equal(denied.out, '');
      assert.ok(!denied.err.includes(cookieEnv.CAT_CAFE_SESSION_COOKIE));
    }
    assert.equal(requests.length, 0);
    const allowed = await run(base, args, { ...cookieEnv, CAT_CAFE_ALLOW_INSECURE_COOKIE: '1' });
    assert.equal(allowed.code, 0, allowed.err);
    assert.deepEqual(
      requests.map((request) => request.url),
      ['/api/session', '/api/messages'],
    );
    assert.ok(requests.every((request) => request.headers.cookie === cookieEnv.CAT_CAFE_SESSION_COOKIE));
    const header = await run(base, args);
    assert.equal(header.code, 0, header.err);
    assert.equal(requests[2].headers['x-cat-cafe-user'], 'owner');
    assert.equal(requests[2].headers.cookie, undefined);
  }, address);
});

test('cookie transport guard permits loopback HTTP and remote HTTPS', async () => {
  for (const base of ['http://127.0.0.1:1', 'http://localhost:1', 'http://[::1]:1', 'https://192.0.2.1:1']) {
    const result = await run(base, ['whoami'], { CAT_CAFE_SESSION_COOKIE: 'cat_cafe_session=abc' });
    assert.equal(result.code, 4, result.err);
    assert.match(result.err, /Could not reach Host API/);
  }
});

test('session is checked and forwarded on ordinary operations; redirects are not followed', async () =>
  fixture(async (base, requests) => {
    const sent = await run(base, ['messages', 'send', '--thread', 't', '--text', 'hi'], {
      CAT_CAFE_SESSION_COOKIE: 'cat_cafe_session=abc',
    });
    assert.equal(sent.code, 0, sent.err);
    assert.deepEqual(
      requests.map((r) => r.url),
      ['/api/session', '/api/messages'],
    );
    assert.equal(requests[1].headers.cookie, 'cat_cafe_session=abc');
    const redirected = await run(base, ['cats', 'list'], { CAT_CAFE_USER: 'redirect' });
    assert.equal(redirected.code, 3);
    assert.match(redirected.err, /HTTP 302/);
  }));
