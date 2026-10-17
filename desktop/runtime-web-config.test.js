const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { loadDesktopWebConfig } = require('./runtime-web-config');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-web-config-'));
  const revision = 'a'.repeat(40);
  const config = {
    distDir: '.next',
    env: { NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION: revision },
    basePath: '',
    experimental: { proxyTimeout: 120000 },
    _originalRewrites: {
      beforeFiles: [],
      afterFiles: [{ source: '/api/:path*', destination: 'http://build/api/:path*' }],
    },
  };
  fs.mkdirSync(path.join(root, '.next'));
  fs.writeFileSync(path.join(root, '.next/.build-commit'), revision);
  fs.writeFileSync(path.join(root, '.next/BUILD_ID'), 'fixture-build');
  const save = (value) => fs.writeFileSync(path.join(root, '.next/required-server-files.json'), JSON.stringify(value));
  save({ version: 1, config });
  const nextPackage = path.join(root, 'next/package.json');
  fs.mkdirSync(path.dirname(nextPackage), { recursive: true });
  fs.writeFileSync(nextPackage, '{"name":"next","version":"14.2.35"}');
  fs.mkdirSync(path.join(root, 'next/node_modules/@next/env'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'next/node_modules/@next/env/index.js'),
    `exports.loadEnvConfig = (web, dev) => {
    if (dev !== false || !web) throw new Error('Expected production environment');
    if (!process.env.RUNTIME_WEB_ENV_TEST) process.env.RUNTIME_WEB_ENV_TEST = 'file-value';
  };`,
  );
  const requireWeb = { resolve: () => nextPackage };
  const original = Object.fromEntries(
    ['__NEXT_PRIVATE_STANDALONE_CONFIG', 'RUNTIME_WEB_ENV_TEST'].map((k) => [k, process.env[k]]),
  );
  return {
    root,
    config,
    save,
    requireWeb,
    close() {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('verified production snapshot retains build env, routes and runtime env precedence', () => {
  const f = fixture();
  try {
    process.env.RUNTIME_WEB_ENV_TEST = 'process-value';
    process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = '{"stale":true}';
    assert.deepEqual(loadDesktopWebConfig(f.root, f.requireWeb), f.config);
    assert.deepEqual(JSON.parse(process.env.__NEXT_PRIVATE_STANDALONE_CONFIG), f.config);
    assert.equal(process.env.RUNTIME_WEB_ENV_TEST, 'process-value');
    delete process.env.RUNTIME_WEB_ENV_TEST;
    loadDesktopWebConfig(f.root, f.requireWeb);
    assert.equal(process.env.RUNTIME_WEB_ENV_TEST, 'file-value');
  } finally {
    f.close();
  }
});

for (const [name, update] of [
  ['missing manifest', (f) => fs.unlinkSync(path.join(f.root, '.next/required-server-files.json'))],
  ['invalid JSON', (f) => fs.writeFileSync(path.join(f.root, '.next/required-server-files.json'), '{')],
  ['unsupported manifest', (f) => f.save({ version: 2, config: f.config })],
  ['unsafe distDir', (f) => f.save({ version: 1, config: { ...f.config, distDir: '../other-build' } })],
  [
    'mismatched revision',
    (f) =>
      f.save({ version: 1, config: { ...f.config, env: { NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION: 'b'.repeat(40) } } }),
  ],
  ['missing build stamp', (f) => fs.unlinkSync(path.join(f.root, '.next/.build-commit'))],
  ['invalid build stamp', (f) => fs.writeFileSync(path.join(f.root, '.next/.build-commit'), 'invalid')],
  ['missing BUILD_ID', (f) => fs.unlinkSync(path.join(f.root, '.next/BUILD_ID'))],
  ['empty BUILD_ID', (f) => fs.writeFileSync(path.join(f.root, '.next/BUILD_ID'), ' \n')],
])
  test(`rejects ${name} without replacing the current process config`, () => {
    const f = fixture();
    try {
      process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = 'unchanged';
      update(f);
      assert.throws(() => loadDesktopWebConfig(f.root, f.requireWeb), /Packaged Next production config/);
      assert.equal(process.env.__NEXT_PRIVATE_STANDALONE_CONFIG, 'unchanged');
    } finally {
      f.close();
    }
  });
