const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveDesktopRuntime, rewriteDesktopLoopbackUrl, readPackagedApiPort } = require('./runtime-config');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('keeps normal desktop defaults and ignores unrelated shell port overrides', () => {
  assert.deepEqual(resolveDesktopRuntime({ FRONTEND_PORT: '5158' }), {
    frontendPort: 3003,
    apiPort: 3004,
    redisPort: 6399,
    instanceRoot: null,
  });
});

test('installed instance survives an environment-free upgrade and rejects corrupt identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-runtime-'));
  const executable = path.join(root, 'Clowder AI.exe');
  const marker = path.join(root, 'desktop-instance.json');
  const saved = {
    CAT_CAFE_DESKTOP_INSTANCE_ROOT: root,
    FRONTEND_PORT: '5158',
    API_SERVER_PORT: '3158',
    REDIS_PORT: '6367',
  };
  try {
    fs.writeFileSync(marker, JSON.stringify(saved));
    const restored = fs.statSync(resolveDesktopRuntime({}, executable).instanceRoot, { bigint: true });
    const expected = fs.statSync(root, { bigint: true });
    assert.deepEqual([restored.dev, restored.ino], [expected.dev, expected.ino]);
    assert.equal(resolveDesktopRuntime({}, executable).redisPort, 6367);
    fs.writeFileSync(marker, '{}');
    assert.throws(() => resolveDesktopRuntime({}, executable), /identify its root/);
    fs.writeFileSync(marker, JSON.stringify({ ...saved, REDIS_PORT: '6399' }));
    assert.throws(() => resolveDesktopRuntime({}, executable), /isolated.*port/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('recognizes the packaged API port without treating arbitrary loopback services as the API', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-rewrites-'));
  const manifest = path.join(root, 'packages/web/.next/routes-manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  try {
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        rewrites: { afterFiles: [{ source: '/api/:path*', destination: 'http://localhost:3152/api/:path*' }] },
      }),
    );
    const config = {
      instanceRoot: root,
      frontendPort: 5158,
      apiPort: 3158,
      packagedApiPort: readPackagedApiPort(root),
    };
    assert.equal(rewriteDesktopLoopbackUrl('http://localhost:3152/api/cats', config), 'http://localhost:3158/api/cats');
    assert.equal(rewriteDesktopLoopbackUrl('http://localhost:7123/index.html', config), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('isolated renderer redirects packaged loopback defaults without touching other origins', () => {
  const config = { instanceRoot: '/owned', frontendPort: 5158, apiPort: 3158 };
  assert.equal(
    rewriteDesktopLoopbackUrl('http://localhost:3004/api/cats?x=1', config),
    'http://localhost:3158/api/cats?x=1',
  );
  assert.equal(
    rewriteDesktopLoopbackUrl('http://127.0.0.1:3003/uploads/avatar.png', config),
    'http://127.0.0.1:5158/uploads/avatar.png',
  );
  assert.equal(rewriteDesktopLoopbackUrl('http://outside.invalid:3004/api/cats', config), undefined);
  assert.equal(rewriteDesktopLoopbackUrl('http://localhost:3004/api/cats', { instanceRoot: null }), undefined);
});
test('never redirects its own page or API when the packaged API uses that same port', () => {
  const config = { instanceRoot: '/owned', frontendPort: 3152, apiPort: 3158, packagedApiPort: 3152 };
  assert.deepEqual(
    {
      page: rewriteDesktopLoopbackUrl('http://localhost:3152/?shell=v2', config),
      api: rewriteDesktopLoopbackUrl('http://localhost:3158/api/cats', { ...config, packagedApiPort: 3158 }),
    },
    { page: undefined, api: undefined },
  );
});
test('requires an explicit absolute instance root and three safe distinct ports', () => {
  const env = {
    CAT_CAFE_DESKTOP_INSTANCE_ROOT: path.join(os.tmpdir(), 'isolated-desktop'),
    FRONTEND_PORT: '5158',
    API_SERVER_PORT: '3158',
    REDIS_PORT: '6367',
  };
  assert.equal(resolveDesktopRuntime(env).redisPort, 6367);
  for (const key of ['FRONTEND_PORT', 'API_SERVER_PORT', 'REDIS_PORT']) {
    for (const value of ['', 'abc', '0', '65536', '3001', '3002', '3003', '3004', '6399'])
      assert.throws(() => resolveDesktopRuntime({ ...env, [key]: value }), /isolated.*port/i);
  }
  assert.throws(() => resolveDesktopRuntime({ ...env, API_SERVER_PORT: env.FRONTEND_PORT }), /distinct/);
  assert.throws(() => resolveDesktopRuntime({ ...env, CAT_CAFE_DESKTOP_INSTANCE_ROOT: '../production' }), /absolute/);
});
