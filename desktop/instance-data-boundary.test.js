const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { resolveDesktopRuntime } = require('./runtime-config');

function identity(root) {
  return { CAT_CAFE_DESKTOP_INSTANCE_ROOT: root, FRONTEND_PORT: '5162', API_SERVER_PORT: '3162', REDIS_PORT: '6338' };
}
function configure(install, root) {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(__dirname, 'scripts/configure-desktop-instance.ps1'),
      '-AppDir',
      install,
      ...(root ? ['-InstanceRoot', root, '-FrontendPort', '5162', '-ApiPort', '3162', '-RedisPort', '6338'] : []),
    ],
    { stdio: 'pipe', timeout: 30000 },
  );
}
for (const directory of ['desktop-dist', 'packages', 'node', 'node_modules', path.join('scripts', 'node_modules')]) {
  test(`runtime rejects data inside replacement directory ${directory}`, () => {
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'instance-boundary-'));
    try {
      const root = path.join(own, 'install', directory, 'owned-data');
      fs.mkdirSync(root, { recursive: true });
      assert.throws(
        () => resolveDesktopRuntime(identity(root), path.join(own, 'install/desktop-dist/Clowder AI.exe')),
        /replacement boundary/i,
      );
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  });
  for (const mode of ['parameters', 'persistent', 'legacy']) {
    test(
      `pre-install refuses ${mode} data in ${directory} without touching identity or history`,
      { skip: process.platform !== 'win32' },
      () => {
        const own = fs.mkdtempSync(path.join(os.tmpdir(), 'preinstall-boundary-'));
        try {
          const install = path.join(own, 'install');
          const root = path.join(install, directory, 'owned-data');
          fs.mkdirSync(root, { recursive: true });
          const history = path.join(root, 'history.json');
          fs.writeFileSync(history, '{"catId":"old-cat","message":"keep me"}');
          const body = JSON.stringify(identity(root));
          const marker = path.join(
            install,
            mode === 'legacy' ? 'desktop-dist/desktop-instance.json' : 'desktop-instance.json',
          );
          if (mode !== 'parameters') {
            fs.mkdirSync(path.dirname(marker), { recursive: true });
            fs.writeFileSync(marker, body);
          }
          assert.throws(() => configure(install, mode === 'parameters' ? root : undefined), /replacement boundary/i);
          assert.equal(fs.readFileSync(history, 'utf8'), '{"catId":"old-cat","message":"keep me"}');
          if (mode !== 'parameters') assert.equal(fs.readFileSync(marker, 'utf8'), body);
          if (mode !== 'persistent') assert.equal(fs.existsSync(path.join(install, 'desktop-instance.json')), false);
        } finally {
          fs.rmSync(own, { recursive: true, force: true });
        }
      },
    );
  }
}
test(
  'canonical alias cannot bypass pre-install or runtime checks; outside sibling data remains valid',
  { skip: process.platform !== 'win32' },
  () => {
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-boundary-'));
    try {
      const install = path.join(own, 'install');
      const payload = path.join(install, 'packages');
      fs.mkdirSync(payload, { recursive: true });
      const alias = path.join(own, 'alias');
      fs.symlinkSync(payload, alias, 'junction');
      const aliasedRoot = path.join(alias, 'not-created-yet');
      assert.throws(() => configure(install, aliasedRoot), /replacement boundary/i);
      assert.throws(
        () => resolveDesktopRuntime(identity(aliasedRoot), path.join(install, 'desktop-dist/Clowder AI.exe')),
        /replacement boundary/i,
      );
      const outside = path.join(own, 'install-sibling/owned-data');
      fs.mkdirSync(outside, { recursive: true });
      configure(install, outside);
      const restored = resolveDesktopRuntime({}, path.join(install, 'desktop-dist/Clowder AI.exe')).instanceRoot;
      // Windows runners may supply TEMP using an 8.3 alias. Compare the actual
      // directory identity rather than requiring one spelling of the same path.
      assert.equal(fs.realpathSync.native(restored), fs.realpathSync.native(outside));
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  },
);

test(
  'an unresolved junction is never treated as an ordinary missing data directory',
  { skip: process.platform !== 'win32' },
  () => {
    const own = fs.mkdtempSync(path.join(os.tmpdir(), 'dangling-boundary-'));
    try {
      const install = path.join(own, 'install');
      fs.mkdirSync(install);
      const alias = path.join(own, 'alias');
      fs.symlinkSync(path.join(install, 'packages'), alias, 'junction');
      const root = path.join(alias, 'future');
      assert.throws(() => resolveDesktopRuntime(identity(root), path.join(install, 'desktop-dist/Clowder AI.exe')));
      assert.throws(() => configure(install, root));
      assert.equal(fs.existsSync(path.join(install, 'desktop-instance.json')), false);
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
  },
);
