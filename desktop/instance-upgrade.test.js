const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { resolveDesktopRuntime } = require('./runtime-config');

const script = path.join(__dirname, 'scripts/configure-desktop-instance.ps1');
const saved = {
  CAT_CAFE_DESKTOP_INSTANCE_ROOT: 'C:\\fixture-owned-instance',
  FRONTEND_PORT: '5158',
  API_SERVER_PORT: '3158',
  REDIS_PORT: '6367',
};
function configure(root, args = []) {
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-AppDir', root, ...args],
    { timeout: 60000, stdio: 'pipe', windowsHide: true },
  );
}

test('stable install marker remains authoritative after payload replacement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-install-identity-'));
  const payload = path.join(root, 'desktop-dist');
  fs.mkdirSync(payload);
  const identity = { ...saved, CAT_CAFE_DESKTOP_INSTANCE_ROOT: path.join(root, 'owned-instance') };
  try {
    fs.writeFileSync(path.join(root, 'desktop-instance.json'), JSON.stringify(identity));
    fs.writeFileSync(path.join(payload, 'desktop-instance.json'), JSON.stringify({ ...identity, REDIS_PORT: '6368' }));
    const actual = resolveDesktopRuntime({}, path.join(payload, 'Clowder AI.exe'));
    assert.equal(actual.redisPort, 6367);
    fs.writeFileSync(path.join(root, 'desktop-instance.json'), '{bad');
    assert.throws(() => resolveDesktopRuntime({}, path.join(payload, 'Clowder AI.exe')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'upgrade migrates legacy identity before replacement and preserves it without repeated parameters',
  { skip: process.platform !== 'win32' },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-install-upgrade-'));
    const payload = path.join(root, 'desktop-dist');
    fs.mkdirSync(payload);
    const data = path.join(root, 'owned-data');
    fs.mkdirSync(data);
    const body = JSON.stringify({ ...saved, CAT_CAFE_DESKTOP_INSTANCE_ROOT: data });
    const witness = path.join(data, 'roles-and-messages.json');
    fs.writeFileSync(witness, '{"role":"old-id","message":"history"}');
    try {
      fs.writeFileSync(path.join(payload, 'desktop-instance.json'), body);
      configure(root);
      assert.equal(fs.readFileSync(path.join(root, 'desktop-instance.json'), 'utf8'), body);
      // Simulate the exact payload replacement boundary; owned data is outside it.
      fs.renameSync(payload, path.join(root, 'previous-payload'));
      fs.mkdirSync(payload);
      configure(root);
      assert.equal(resolveDesktopRuntime({}, path.join(payload, 'Clowder AI.exe')).instanceRoot, data);
      assert.equal(resolveDesktopRuntime({}, path.join(payload, 'Clowder AI.exe')).apiPort, 3158);
      assert.equal(fs.readFileSync(witness, 'utf8'), '{"role":"old-id","message":"history"}');
      assert.equal(fs.readFileSync(path.join(root, 'desktop-instance.json'), 'utf8'), body);
      assert.throws(() =>
        configure(root, ['-InstanceRoot', data, '-FrontendPort', '5160', '-ApiPort', '3160', '-RedisPort', '6370']),
      );
      assert.equal(fs.readFileSync(path.join(root, 'desktop-instance.json'), 'utf8'), body);
      fs.writeFileSync(path.join(root, 'desktop-instance.json'), '{invalid');
      assert.throws(() => configure(root));
      assert.equal(fs.readFileSync(path.join(root, 'desktop-instance.json'), 'utf8'), '{invalid');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test('installer preserves identity before any payload delete', () => {
  const iss = fs.readFileSync(path.join(__dirname, 'installer/installation-identity.iss'), 'utf8');
  const prepare = iss.slice(iss.indexOf('function PrepareToInstall'));
  assert.match(prepare, /configure-desktop-instance\.ps1/);
  assert.ok(prepare.indexOf('configure-desktop-instance.ps1') < prepare.indexOf('stop-installed-desktop.ps1'));
  assert.match(prepare, /Unable to preserve the target installation identity/);
});
