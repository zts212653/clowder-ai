import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { closeBrowserEndpoint } from '../dist/domains/plugin/browser-service/endpoint-reservation.js';
import { PluginBrowserServiceProvider } from '../dist/domains/plugin/browser-service/provider.js';
import { loadRetainedBrowserAssets } from '../dist/domains/plugin/browser-service/retained-assets.js';

const parentOrigin = 'http://127.0.0.1:58002'; // Policy only: no connection is made to this address.
const declaration = {
  type: 'browser-service',
  id: 'api',
  action: { method: 'service.http' },
  routes: [
    { method: 'GET', path: '/health', browser: 'service', local: 'omit-origin' },
    { method: 'POST', path: '/write', browser: 'service', local: 'omit-origin' },
    { method: 'POST', path: '/parent', browser: 'parent' },
    { method: 'POST', path: '/exchange', local: 'parent-origin' },
  ],
  credentials: { bearer: true, cookies: [] },
};
const response = (body = 'ok') => ({
  status: 200,
  headers: [{ name: 'content-type', value: 'text/plain' }],
  bodyBase64: Buffer.from(body).toString('base64'),
});
const localRequest = { version: 1, method: 'GET', path: '/health', rawQuery: '', headers: [], rawBodyBase64: '' };
async function assetsFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cat-cafe-browser-endpoint-'));
  const assets = path.join(root, 'assets');
  await mkdir(assets);
  const bytes = Buffer.from('<!doctype html><title>retained fixture</title>');
  await writeFile(path.join(assets, 'index.html'), bytes);
  const files = [
    {
      path: '/index.html',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentType: 'text/html; charset=utf-8',
    },
  ];
  await writeFile(
    path.join(assets, 'manifest.json'),
    JSON.stringify({ version: 1, clientBuildId: 'fixture-v1', files }),
  );
  const assetDigest = createHash('sha256')
    .update(JSON.stringify(files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))))
    .digest('hex');
  const expected = { clientBuildId: 'fixture-v1', assetDigest };
  return { root, assets, expected, bundle: await loadRetainedBrowserAssets(assets, expected) };
}
async function fixture(t, { declarations = [declaration], resolveAssets } = {}) {
  const a = await assetsFixture();
  const identityDirectory = path.join(a.root, 'identities');
  const provider = new PluginBrowserServiceProvider({
    identityDirectory,
    parentOrigin,
    assets: resolveAssets ?? (async () => a.bundle),
  });
  const abort = new AbortController();
  let current = true;
  const input = {
    pluginInstanceId: 'owned-test-instance',
    packageRecord: {
      manifest: {
        features: [
          { id: 'feature', capabilities: [], contributions: declarations.map((d) => ({ type: d.type, id: d.id })) },
        ],
        contributions: declarations,
      },
    },
    effectiveGrants: [],
    signal: abort.signal,
    assertCurrent() {
      if (!current) throw new Error('revoked test activation');
    },
  };
  const sessions = [];
  const prepare = async () => {
    const session = await provider.prepare(input);
    sessions.push(session);
    return session;
  };
  t.after(async () => {
    try {
      for (const session of sessions) await session.stop('test cleanup');
    } finally {
      await provider.shutdown();
    }
  });
  return {
    ...a,
    input,
    provider,
    identityDirectory,
    prepare,
    revoke: () => {
      current = false;
    },
    abort,
  };
}
function http(origin, { target = '/health', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(origin + target, { method, headers, agent: false }, (res) => {
      const parts = [];
      res.on('data', (p) => parts.push(p));
      res.on('error', reject);
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }),
      );
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('retained assets verify real bytes and digest, then isolate returned copies from the sealed bundle', async () => {
  const a = await assetsFixture();
  const original = a.bundle.read('/').bytes.toString();
  a.bundle.read('/').bytes.fill(0);
  assert.equal(a.bundle.read('/').bytes.toString(), original);
  assert.equal(a.bundle.read('/../index.html'), undefined);
  await writeFile(path.join(a.assets, 'index.html'), 'tampered');
  assert.equal(a.bundle.read('/').bytes.toString(), original);
  await assert.rejects(loadRetainedBrowserAssets(a.assets, a.expected), { code: 'BROWSER_SERVICE_UNAVAILABLE' });
  await assert.rejects(loadRetainedBrowserAssets(a.assets, { ...a.expected, assetDigest: '0'.repeat(64) }), {
    code: 'BROWSER_SERVICE_UNAVAILABLE',
  });
});

test('reservation serves unavailable until publication, then actual assets and private HTTP bytes', async (t) => {
  const f = await fixture(t);
  await assert.rejects(readdir(f.identityDirectory), { code: 'ENOENT' });
  const session = await f.prepare(),
    binding = await session.host.getBinding('api');
  assert.equal(binding.assetDigest, f.expected.assetDigest);
  assert.equal((await http(binding.origin, { target: '/' })).status, 503);
  assert.equal((await session.host.dispatchLocal('api', localRequest)).code, 'BROWSER_SERVICE_UNAVAILABLE');
  let seen;
  await session.publish(
    new Map([
      [
        'api',
        async ({ request }, native, context) => {
          seen = { request, native, context };
          return response(request.rawQuery);
        },
      ],
    ]),
  );
  const page = await http(binding.origin, { target: '/' });
  assert.equal(page.status, 200);
  assert.match(page.body, /retained fixture/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors http:\/\/127\.0\.0\.1:58002/);
  for (const target of ['/?hostOrigin=http%3A%2F%2F127.0.0.1%3A58002', '/index.html?view=setup']) {
    const launch = await http(binding.origin, { target });
    assert.equal(launch.status, 200);
    assert.equal(launch.body, page.body);
    assert.equal(launch.headers['content-type'], page.headers['content-type']);
  }
  assert.equal(seen, undefined, 'asset query must not invoke the package handler');
  assert.equal((await http(binding.origin, { target: '/missing.html?view=setup' })).status, 400);
  assert.equal(
    (await http(binding.origin, { target: '/?view=setup', headers: { origin: 'http://foreign.invalid' } })).status,
    400,
  );
  assert.equal(seen, undefined, 'query must not bypass missing-path or origin checks');
  const api = await http(binding.origin, {
    target: '/health?a=1&a=%32',
    headers: { cookie: 'host-secret=do-not-forward' },
  });
  assert.equal(api.status, 200);
  assert.equal(api.body, 'a=1&a=%32');
  assert.equal(seen.native, undefined);
  assert.equal(seen.context.kind, 'http');
  assert.equal(
    seen.request.headers.some((h) => h.name === 'cookie'),
    false,
  );
  await assert.rejects(seen.context.assertCurrent());
});

test('real endpoint denies foreign Host/Origin, undeclared local route, excess ingress and unauthorized CORS', async (t) => {
  const f = await fixture(t),
    session = await f.prepare(),
    { origin } = await session.host.getBinding('api');
  let calls = 0;
  await session.publish(
    new Map([
      [
        'api',
        async () => {
          calls++;
          return response();
        },
      ],
    ]),
  );
  assert.equal((await http(origin, { headers: { host: 'attacker.invalid' } })).status, 400);
  assert.equal((await http(origin, { method: 'POST', target: '/write', body: 'x' })).status, 400);
  assert.equal(
    (await http(origin, { method: 'POST', target: '/write', headers: { origin: parentOrigin }, body: 'x' })).status,
    400,
  );
  assert.equal(
    (await http(origin, { method: 'POST', target: '/exchange', headers: { origin }, body: 'x' })).status,
    400,
  );
  const large = await http(origin, {
    method: 'POST',
    target: '/write',
    headers: { origin },
    body: Buffer.alloc(262145),
  });
  assert.equal(large.status, 413);
  assert.equal(JSON.parse(large.body).effect, 'not_started');
  assert.equal(
    (
      await http(origin, {
        method: 'OPTIONS',
        target: '/write',
        headers: { origin: parentOrigin, 'access-control-request-method': 'POST' },
      })
    ).status,
    400,
  );
  const cors = await http(origin, {
    method: 'OPTIONS',
    target: '/parent',
    headers: {
      origin: parentOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(cors.status, 204);
  assert.equal(cors.headers['access-control-allow-origin'], parentOrigin);
  assert.equal(cors.headers['access-control-allow-credentials'], undefined);
  assert.equal(calls, 0);
  assert.equal((await http(origin, { method: 'POST', target: '/write', headers: { origin }, body: 'ok' })).status, 200);
  assert.equal(calls, 1);
});

test('ordinary stop revokes old bindings but retains origin custody for same-Host reactivation', async (t) => {
  const f = await fixture(t),
    session = await f.prepare(),
    binding = await session.host.getBinding('api');
  await session.publish(new Map([['api', async () => response('old')]]));
  await session.stop('disable');
  await session.stop('repeated stop');
  await assert.rejects(binding.assertCurrent(), { code: 'BROWSER_SERVICE_REVOKED' });
  assert.equal((await http(binding.origin)).status, 503);
  assert.equal((await readdir(f.identityDirectory)).length, 1);
  const next = await f.prepare();
  assert.equal((await next.host.getBinding('api')).origin, binding.origin);
  assert.equal((await http(binding.origin)).status, 503);
  await next.publish(new Map([['api', async () => response('new')]]));
  await session.stop('late old stop must not revoke new activation');
  assert.equal((await http(binding.origin)).body, 'new');
  assert.equal((await session.host.dispatchLocal('api', localRequest)).code, 'BROWSER_SERVICE_REVOKED');
});

test('a foreign listener at Host restart fails closed without origin rotation or identity overwrite', async (t) => {
  const f = await fixture(t),
    session = await f.prepare(),
    { origin } = await session.host.getBinding('api');
  await session.stop('disable');
  await f.provider.shutdown(); // Final Host shutdown, not plugin disable.
  const filename = path.join(f.identityDirectory, (await readdir(f.identityDirectory))[0]);
  const before = await readFile(filename, 'utf8');
  const blocker = createServer((_req, res) => res.end());
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(Number(new URL(origin).port), '127.0.0.1', resolve);
  });
  t.after(() => closeBrowserEndpoint(blocker));
  const restarted = new PluginBrowserServiceProvider({
    identityDirectory: f.identityDirectory,
    parentOrigin,
    assets: async () => f.bundle,
  });
  t.after(() => restarted.shutdown());
  await assert.rejects(restarted.prepare(f.input), { code: 'BROWSER_SERVICE_UNAVAILABLE' });
  assert.equal(await readFile(filename, 'utf8'), before);
  await closeBrowserEndpoint(blocker);
  const next = await restarted.prepare(f.input);
  t.after(() => next.stop('cleanup'));
  assert.equal((await next.host.getBinding('api')).origin, origin);
});

test('preparation failure preserves reserved origins as tombstones until final Host shutdown', async (t) => {
  const second = { ...declaration, id: 'second', action: { method: 'second.http' } };
  const a = await assetsFixture();
  const f = await fixture(t, {
    declarations: [declaration, second],
    resolveAssets: async (_input, c) => {
      if (c.id === 'second') throw new Error('missing retained catalog asset');
      return a.bundle;
    },
  });
  await assert.rejects(f.prepare(), /missing retained catalog asset/);
  const names = await readdir(f.identityDirectory);
  assert.equal(names.length, 1);
  const record = JSON.parse(await readFile(path.join(f.identityDirectory, names[0]), 'utf8'));
  assert.equal((await http(`http://127.0.0.1:${record.port}`)).status, 503);
  await f.provider.shutdown();
  await assert.rejects(http(`http://127.0.0.1:${record.port}`));
});

test('revocation after handler entry suppresses late bytes and keeps unknown effect without replay', async (t) => {
  const f = await fixture(t),
    session = await f.prepare(),
    { origin } = await session.host.getBinding('api');
  const entered = Promise.withResolvers(),
    finish = Promise.withResolvers();
  let calls = 0;
  await session.publish(
    new Map([
      [
        'api',
        async () => {
          calls++;
          entered.resolve();
          await finish.promise;
          return response('private late response');
        },
      ],
    ]),
  );
  const result = http(origin);
  await entered.promise;
  f.revoke();
  finish.resolve();
  const received = await result;
  assert.equal(received.status, 410);
  assert.equal(received.body.includes('private late response'), false);
  const failure = JSON.parse(received.body);
  assert.equal(failure.effect, 'unknown');
  assert.equal(failure.automaticRetry, false);
  assert.equal(calls, 1);
});

test('published origin custody rejects a competing listener after disable', async (t) => {
  const f = await fixture(t);
  const session = await f.prepare();
  const { origin } = await session.host.getBinding('api');
  await session.publish(new Map([['api', async () => response()]]));
  await session.stop('disable');
  const contender = createServer((_req, res) => res.end('impostor'));
  t.after(() => closeBrowserEndpoint(contender));
  await assert.rejects(
    new Promise((resolve, reject) => {
      contender.once('error', reject);
      contender.listen({ host: '127.0.0.1', port: Number(new URL(origin).port), exclusive: true }, resolve);
    }),
    { code: 'EADDRINUSE' },
    'a published origin must remain owned while Host is alive, even with the plugin disabled',
  );
});

test('published origin custody survives failed reactivation with unavailable responses and no plugin calls', async (t) => {
  const assets = await assetsFixture();
  let rejectAssets = false;
  let calls = 0;
  const f = await fixture(t, {
    resolveAssets: async () => {
      if (rejectAssets) throw new Error('reactivation asset failure');
      return assets.bundle;
    },
  });
  const session = await f.prepare();
  const { origin } = await session.host.getBinding('api');
  await session.publish(
    new Map([
      [
        'api',
        async () => {
          calls++;
          return response('active');
        },
      ],
    ]),
  );
  assert.equal((await http(origin)).status, 200);
  assert.equal(calls, 1);
  await session.stop('disable');
  rejectAssets = true;
  await assert.rejects(f.prepare(), /reactivation asset failure/);
  for (const target of ['/health', '/']) {
    const result = await http(origin, { target, headers: { authorization: 'Bearer synthetic-test-canary' } });
    assert.equal(result.status, 503);
    assert.equal(JSON.parse(result.body).code, 'BROWSER_SERVICE_UNAVAILABLE');
    assert.equal(result.body.includes('synthetic-test-canary'), false);
  }
  assert.equal(calls, 1, 'disabled origin must not call an old package handler');
});

test('final Host shutdown fences pending prepare and cannot leak an origin acquired late', async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const a = await assetsFixture();
  const f = await fixture(t, {
    resolveAssets: async () => {
      entered.resolve();
      await release.promise;
      return a.bundle;
    },
  });
  const preparing = f.prepare();
  const rejected = assert.rejects(preparing, { code: 'BROWSER_SERVICE_REVOKED' });
  await entered.promise;
  const closing = f.provider.shutdown();
  release.resolve();
  await rejected;
  await closing;
  await assert.rejects(f.prepare(), { code: 'BROWSER_SERVICE_UNAVAILABLE' });
  await assert.rejects(readdir(f.identityDirectory), { code: 'ENOENT' });
});
