const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { createDesktopWebGateway, createDesktopNextApp, resolveDesktopWebHost } = require('./runtime-web-server');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

test('production entry preloads its verified build config and production env before requiring Next', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-web-entry-'));
  const write = (name, value) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const revision = 'a'.repeat(40);
  try {
    write('package.json', { private: true });
    write('.next/.build-commit', revision);
    write('.next/BUILD_ID', 'fixture-build');
    write('.next/required-server-files.json', {
      version: 1,
      config: { distDir: '.next', env: { NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION: revision } },
    });
    write('next.config.js', 'throw new Error("Build-only configuration must not execute");');
    write('node_modules/next/package.json', { name: 'next', version: '14.2.35', main: 'index.js' });
    write(
      'node_modules/@next/env/index.js',
      `exports.loadEnvConfig = (_dir, dev) => {
      if (dev !== false) throw new Error('Expected production environment');
      process.env.RUNTIME_WEB_ENV_FIXTURE = 'production-file';
    };`,
    );
    write(
      'node_modules/next/index.js',
      `const config = process.env.__NEXT_PRIVATE_STANDALONE_CONFIG;
      console.log('FIXTURE_CONFIG=' + JSON.stringify({
        config: config ? JSON.parse(config) : null, env: process.env.RUNTIME_WEB_ENV_FIXTURE,
        nodeEnv: process.env.NODE_ENV
      }));
      module.exports = () => ({ prepare: async () => { throw new Error('FIXTURE_STOP_BEFORE_LISTEN'); } });`,
    );
    const env = { ...process.env, NODE_ENV: 'development' };
    delete env.__NEXT_PRIVATE_STANDALONE_CONFIG;
    delete env.RUNTIME_WEB_ENV_FIXTURE;
    const result = spawnSync(process.execPath, [path.join(__dirname, 'runtime-web-server.js'), root, '0', '0'], {
      env,
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    const line = result.stdout.split('\n').find((value) => value.startsWith('FIXTURE_CONFIG='));
    assert.ok(line, result.stderr);
    const observed = JSON.parse(line.slice('FIXTURE_CONFIG='.length));
    assert.equal(observed.config?.env.NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION, revision);
    assert.equal(observed.env, 'production-file');
    assert.equal(observed.nodeEnv, 'production');
    assert.match(result.stderr, /FIXTURE_STOP_BEFORE_LISTEN/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('packaged rewrites proxy body and uploads to the actual owned API and keep pages in Next', async () => {
  const seen = [];
  const api = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      seen.push({ method: request.method, path: request.url, body });
      response.writeHead(201, { 'content-type': 'text/plain' });
      response.end('owned API');
    });
  });
  await listen(api);
  const gateway = createDesktopWebGateway((_request, response) => response.end('Next page'), api.address().port);
  await listen(gateway);
  const base = `http://127.0.0.1:${gateway.address().port}`;
  try {
    const result = await fetch(`${base}/api/cats`, { method: 'POST', body: 'owned payload' });
    assert.equal(result.status, 201);
    assert.equal(await result.text(), 'owned API');
    assert.equal(await (await fetch(`${base}/uploads/avatar.png`)).text(), 'owned API');
    assert.equal(await (await fetch(`${base}/settings`)).text(), 'Next page');
    assert.deepEqual(seen, [
      { method: 'POST', path: '/api/cats', body: 'owned payload' },
      { method: 'GET', path: '/uploads/avatar.png', body: '' },
    ]);
  } finally {
    await close(gateway);
    await close(api);
  }
});

test('desktop listen address defaults to loopback and only permits the explicit public bind', () => {
  assert.equal(resolveDesktopWebHost(), '127.0.0.1');
  assert.equal(resolveDesktopWebHost('127.0.0.1'), '127.0.0.1');
  assert.equal(resolveDesktopWebHost('0.0.0.0'), '0.0.0.0');
  for (const hostname of ['localhost', 'example.test', '', '::']) {
    assert.throws(() => resolveDesktopWebHost(hostname), /Unsupported desktop Web listen address/);
  }
});

test('first document timings exclude proxy requests and record no URL or query values', async () => {
  const events = [];
  const api = http.createServer((_request, response) => response.end('API'));
  await listen(api);
  const gateway = createDesktopWebGateway((_request, response) => response.end('page'), api.address().port, {
    mark: (phase, details = {}) => events.push({ phase, ...details }),
  });
  await listen(gateway);
  const base = `http://127.0.0.1:${gateway.address().port}`;
  try {
    await (await fetch(`${base}/api/session`)).text();
    await (await fetch(`${base}/settings`)).text();
    assert.deepEqual(events, []);
    await (await fetch(`${base}/?private-fixture-value=never-log`)).text();
    await (await fetch(`${base}/`)).text();
    assert.deepEqual(
      events.map((event) => event.phase),
      ['firstRequest', 'firstResponse'],
    );
    assert.equal(events[1].statusCode, 200);
    assert.ok(events[1].durationMs >= 0);
    assert.doesNotMatch(JSON.stringify(events), /private-fixture|\/api|settings|127\.0/);
  } finally {
    await close(gateway);
    await close(api);
  }
});

test('records an interrupted first document response without waiting for finish', async () => {
  const events = [];
  let responseClosed;
  const closed = new Promise((resolve) => {
    responseClosed = resolve;
  });
  const gateway = createDesktopWebGateway(
    (_request, response) => {
      response.once('close', responseClosed);
      response.write('partial document');
    },
    1,
    { mark: (phase, details = {}) => events.push({ phase, ...details }) },
  );
  await listen(gateway);
  const request = http.get(`http://127.0.0.1:${gateway.address().port}/?never-log=this`, (response) => {
    response.once('data', () => request.destroy());
    response.on('error', () => {});
  });
  request.on('error', () => {});
  try {
    await closed;
    assert.deepEqual(
      events.map((event) => event.phase),
      ['firstRequest', 'firstResponseAborted'],
    );
    assert.ok(events[1].durationMs >= 0);
    assert.doesNotMatch(JSON.stringify(events), /never-log|127\.0/);
  } finally {
    request.destroy();
    await close(gateway);
  }
});

test('real Next custom server leaves socket upgrades exclusively with the desktop gateway', async () => {
  const requireWeb = createRequire(path.join(__dirname, '../packages/web/package.json'));
  const next = requireWeb('next');
  let apiHits = 0;
  let nextHits = 0;
  const api = http.createServer();
  api.on('upgrade', (_request, socket) => {
    apiHits++;
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  await listen(api);
  // Use Next's actual getRequestHandler/setupWebSocketHandler, without preparing
  // a build or invoking rendering, APIs, agents or any complete application.
  const app = createDesktopNextApp(next, { dir: path.join(__dirname, '../packages/web') });
  app.requestHandler = (_request, response) => response.end('fixture');
  app.upgradeHandler = () => {
    nextHits++;
  };
  const gateway = createDesktopWebGateway(app.getRequestHandler(), api.address().port);
  await listen(gateway);
  try {
    await (await fetch(`http://127.0.0.1:${gateway.address().port}/`)).text();
    const response = await new Promise((resolve, reject) => {
      let data = '';
      const socket = net.connect(gateway.address().port, '127.0.0.1', () => {
        socket.write(
          'GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
        );
      });
      socket.on('data', (chunk) => {
        data += chunk;
      });
      socket.once('error', reject);
      socket.once('end', () => {
        socket.destroy();
        resolve(data);
      });
    });
    assert.match(response, /^HTTP\/1\.1 101/);
    assert.equal(apiHits, 1);
    assert.equal(nextHits, 0);
    assert.equal(gateway.listenerCount('upgrade'), 1);
    assert.equal(app.options.httpServer.listenerCount('upgrade'), 1);
    assert.equal(app.options.httpServer.listening, false);
  } finally {
    await close(gateway);
    await close(api);
  }
});
