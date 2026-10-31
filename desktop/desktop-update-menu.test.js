const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, test } = require('node:test');

const {
  createDesktopTray,
  createDesktopTrayResult,
  createManualUpdateHandler,
  createNativeDesktopTrayResult,
} = require('./desktop-update-menu');

describe('desktop manual update entry point', () => {
  test('re-presents an existing prompt instead of queuing another check behind it', () => {
    let checks = 0;
    let hasPending = true;
    const onManualUpdate = createManualUpdateHandler({
      getUpdatePrompt: () => ({
        presentPending: () => hasPending,
      }),
      getUpdater: () => ({
        checkForUpdates: () => {
          checks += 1;
        },
      }),
    });

    assert.equal(onManualUpdate(), 'presented');
    assert.equal(checks, 0);

    hasPending = false;
    assert.equal(onManualUpdate(), 'started');
    assert.equal(checks, 1);
  });
});

function createMenu() {
  return { buildFromTemplate: (template) => ({ template }) };
}

test('tray creation returns a diagnosable success result', () => {
  const handlers = [];
  const result = createDesktopTrayResult({
    Menu: createMenu(),
    Tray: class {
      setToolTip() {}
      setContextMenu() {}
      on(event, handler) {
        handlers.push([event, handler]);
      }
    },
    iconPath: 'icon.ico',
    getMainWindow: () => null,
    onManualUpdate: () => {},
    onQuit: () => {},
    showAbout: () => {},
  });

  assert.equal(result.status, 'created');
  assert.ok(result.tray);
  assert.deepEqual(
    handlers.map(([event]) => event),
    ['double-click'],
  );
});

test('tray creation returns the native error instead of silently degrading', () => {
  const result = createDesktopTrayResult({
    Menu: createMenu(),
    Tray: class {
      constructor() {
        throw new Error('icon unavailable');
      }
    },
    iconPath: 'missing.ico',
    getMainWindow: () => null,
    onManualUpdate: () => {},
    onQuit: () => {},
    showAbout: () => {},
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.tray, null);
  assert.equal(result.error.message, 'icon unavailable');
  assert.equal(result.error.name, 'Error');
});

test('legacy tray callers still receive a Tray instance', () => {
  const tray = createDesktopTray({
    Menu: createMenu(),
    Tray: class {
      setToolTip() {}
      setContextMenu() {}
      on() {}
    },
    iconPath: 'icon.ico',
    getMainWindow: () => null,
    onManualUpdate: () => {},
    onQuit: () => {},
    showAbout: () => {},
  });

  assert.ok(tray);
  assert.equal(typeof tray.setToolTip, 'function');
});

test('macOS tray decodes PNG into a menu-bar-sized native image', () => {
  const image = {};
  const seen = {};
  const result = createDesktopTrayResult({
    Menu: createMenu(),
    Tray: class {
      constructor(icon) {
        seen.icon = icon;
      }
      setToolTip() {}
      setContextMenu() {}
      on() {}
    },
    nativeImage: {
      createFromPath(filename) {
        seen.filename = filename;
        return {
          resize(size) {
            seen.size = size;
            return image;
          },
        };
      },
    },
    platform: 'darwin',
    iconPath: '/assets/icon.png',
    getMainWindow: () => null,
    onManualUpdate() {},
    onQuit() {},
    showAbout() {},
  });
  assert.equal(result.status, 'created');
  assert.equal(seen.filename, '/assets/icon.png');
  assert.deepEqual(seen.size, { width: 18, height: 18 });
  assert.equal(seen.icon, image);
});

test('native tray wiring selects packaged platform assets and preserves Windows passthrough', () => {
  for (const platform of ['darwin', 'win32']) {
    const decoded = {};
    let received;
    let decodedPath;
    const result = createNativeDesktopTrayResult({
      platform,
      electron: {
        Menu: createMenu(),
        Tray: class {
          constructor(image) {
            received = image;
          }
          setToolTip() {}
          setContextMenu() {}
          on() {}
        },
        nativeImage: {
          createFromPath(filename) {
            decodedPath = filename;
            return { resize: () => decoded };
          },
        },
      },
      getMainWindow: () => null,
      onManualUpdate() {},
      onQuit() {},
      showAbout() {},
    });
    const expected = path.join(__dirname, 'assets', platform === 'win32' ? 'icon.ico' : 'icon.png');
    assert.equal(result.status, 'created');
    assert.equal(result.iconPath, expected);
    assert.equal(received, platform === 'darwin' ? decoded : expected);
    assert.equal(decodedPath, platform === 'darwin' ? expected : undefined);
  }
});
