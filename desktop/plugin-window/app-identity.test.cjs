const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { COMPANION_ICON_ICNS, COMPANION_ICON_PNG, configureCompanionAppIdentity } = require('./app-identity.cjs');

test('Companion uses its own name and Dock icon without creating a new Dock surface', async () => {
  const calls = [];
  const app = {
    setName(name) {
      calls.push(['name', name]);
    },
    whenReady: async () => calls.push(['ready']),
    dock: {
      setIcon(path) {
        calls.push(['icon', path]);
      },
    },
  };
  await configureCompanionAppIdentity(app, { platform: 'darwin' });
  assert.deepEqual(calls, [['name', 'Clowder Companion'], ['ready'], ['icon', COMPANION_ICON_PNG]]);
});

test('Companion icon artifacts are real 1024px RGBA PNG and ICNS package resources', () => {
  const png = readFileSync(COMPANION_ICON_PNG);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  assert.equal(png[25], 6, 'PNG must carry an alpha channel, not a baked checkerboard');
  assert.equal(readFileSync(COMPANION_ICON_ICNS).subarray(0, 4).toString(), 'icns');
  const desktopPackage = JSON.parse(readFileSync(require.resolve('../package.json'), 'utf8'));
  assert.ok(desktopPackage.build.files.includes('plugin-window/**/*'));
});

test('non-macOS hosts keep the product name without inventing a Dock API', async () => {
  const calls = [];
  await configureCompanionAppIdentity(
    {
      setName(name) {
        calls.push(['name', name]);
      },
      whenReady: async () => calls.push(['ready']),
    },
    { platform: 'linux' },
  );
  assert.deepEqual(calls, [['name', 'Clowder Companion']]);
});
