// F258 — update-manager unit tests
// Covers: launcher failure modes (spawn-error, nonzero, success) for
// Windows/macOS, and journal preservation on launcher failure (P1 regression).
// spawn is injected via deps for testability.

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { describe, test, beforeEach, afterEach } = require('node:test');

const UpdateManager = require('./update-manager');
const dl = require('./update-downloader');

// ── Mock spawn ────────────────────────────────────────────────────────

function mockSpawn({ emitError, closeCode }) {
  return () => {
    const child = new EventEmitter();
    child.unref = () => {};
    process.nextTick(() => {
      if (emitError) child.emit('error', new Error(emitError));
      else if (closeCode !== undefined) child.emit('close', closeCode);
    });
    return child;
  };
}

function baseDeps(tempDir, overrides = {}) {
  return {
    app: { getVersion: () => '0.11.0', getAppPath: () => path.join(tempDir, 'app.asar') },
    net: {},
    showDialog: async () => 0,
    showNotification: () => {},
    setProgressBar: () => {},
    openExternal: () => {},
    openPath: () => {},
    quitApp: async () => {},
    dbg: () => {},
    userDataRoot: tempDir,
    platform: 'win32',
    arch: 'x64',
    spawn: mockSpawn({ closeCode: 0 }),
    ...overrides,
  };
}

function controlledReleaseNet(releases) {
  const pending = [];
  return {
    net: {
      request() {
        const req = new EventEmitter();
        req.setHeader = () => {};
        req.abort = () => {};
        req.end = () => {
          pending.push(() => {
            const res = new EventEmitter();
            res.statusCode = 200;
            res.headers = {};
            res.destroy = () => {};
            req.emit('response', res);
            process.nextTick(() => {
              res.emit('data', Buffer.from(JSON.stringify(releases)));
              process.nextTick(() => res.emit('end'));
            });
          });
        };
        return req;
      },
    },
    respondNext() {
      const respond = pending.shift();
      assert.ok(respond, 'expected a pending release request');
      respond();
    },
  };
}

/** Create desktop-config.json so _getInstallType returns the given type. */
function setupInstallType(tempDir, type) {
  const dir = path.join(tempDir, '.cat-cafe');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'desktop-config.json'), JSON.stringify({ installType: type }));
}

const FAKE_CONTENT = Buffer.from('FAKE-INSTALLER');
const FAKE_HASH = createHash('sha256').update(FAKE_CONTENT).digest('hex');
const fakeTarget = {
  version: '0.12.0',
  asset: { id: 1, name: 'Setup.exe', digest: `sha256:${FAKE_HASH}`, size: FAKE_CONTENT.length },
};

/** Create a fake installer file matching fakeTarget's digest + size. */
function writeFakeInstaller(tempDir) {
  const updDir = dl.updatesDir(tempDir);
  mkdirSync(updDir, { recursive: true });
  const ip = path.join(updDir, 'Setup.exe');
  writeFileSync(ip, FAKE_CONTENT);
  return ip;
}

// ── Windows launcher ──────────────────────────────────────────────────

describe('Windows launcher (_spawnInstaller)', () => {
  let td;
  beforeEach(() => {
    td = mkdtempSync(path.join(tmpdir(), 'mgr-win-'));
  });
  afterEach(() => {
    rmSync(td, { recursive: true, force: true });
  });

  test('exit 0 resolves', async () => {
    const m = new UpdateManager(baseDeps(td, { spawn: mockSpawn({ closeCode: 0 }) }));
    await m._spawnInstaller('C:\\Setup.exe', 'C:\\log.txt');
  });

  test('exit nonzero rejects (UAC declined)', async () => {
    const m = new UpdateManager(baseDeps(td, { spawn: mockSpawn({ closeCode: 1 }) }));
    await assert.rejects(() => m._spawnInstaller('C:\\Setup.exe', null), /exit code 1/);
  });

  test('spawn error rejects', async () => {
    const m = new UpdateManager(baseDeps(td, { spawn: mockSpawn({ emitError: 'ENOENT' }) }));
    await assert.rejects(() => m._spawnInstaller('C:\\Setup.exe', null), /ENOENT/);
  });

  test('lets Inno self-elevate (no -Verb RunAs) and quotes /LOG=', async () => {
    let captured;
    const m = new UpdateManager(
      baseDeps(td, {
        spawn: (...a) => {
          captured = a;
          return mockSpawn({ closeCode: 0 })();
        },
      }),
    );
    await m._spawnInstaller('C:\\Clowder AI\\Setup.exe', 'C:\\Clowder AI\\log.txt');
    assert.equal(captured[0], 'powershell.exe');
    const cmd = captured[1].find((a) => a.includes('Start-Process'));
    assert.ok(!cmd.includes('-Verb RunAs'), 'must NOT pre-elevate — Inno handles UAC');
    assert.ok(cmd.includes('-PassThru -Wait'), 'must wait for Inno stub exit code');
    assert.ok(cmd.includes('"/LOG='), '/LOG= must be double-quoted');
  });
});

// ── macOS launcher ────────────────────────────────────────────────────

describe('macOS launcher (_spawnInstaller)', () => {
  let td;
  beforeEach(() => {
    td = mkdtempSync(path.join(tmpdir(), 'mgr-mac-'));
  });
  afterEach(() => {
    rmSync(td, { recursive: true, force: true });
  });

  test('exit 0 resolves', async () => {
    const m = new UpdateManager(baseDeps(td, { platform: 'darwin', spawn: mockSpawn({ closeCode: 0 }) }));
    await m._spawnInstaller('/app.dmg', null);
  });

  test('exit nonzero rejects', async () => {
    const m = new UpdateManager(baseDeps(td, { platform: 'darwin', spawn: mockSpawn({ closeCode: 1 }) }));
    await assert.rejects(() => m._spawnInstaller('/app.dmg', null), /exit code 1/);
  });

  test('spawn error rejects', async () => {
    const m = new UpdateManager(baseDeps(td, { platform: 'darwin', spawn: mockSpawn({ emitError: 'ENOENT' }) }));
    await assert.rejects(() => m._spawnInstaller('/app.dmg', null), /ENOENT/);
  });
});

// ── Journal preservation on launcher failure (P1 regression) ──────────

describe('journal preservation on launcher failure', () => {
  let td;
  beforeEach(() => {
    td = mkdtempSync(path.join(tmpdir(), 'mgr-jnl-'));
    setupInstallType(td, 'installer');
  });
  afterEach(() => {
    rmSync(td, { recursive: true, force: true });
  });

  test('_executeInstall: launcher fail does NOT clear journal (AC-3)', async () => {
    const m = new UpdateManager(baseDeps(td, { spawn: mockSpawn({ closeCode: 1 }) }));
    const ip = writeFakeInstaller(td);
    await m._executeInstall(fakeTarget, ip);
    // Journal MUST survive launcher failure — next startup shows recovery dialog
    const j = dl.readJournal(dl.updatesDir(td));
    assert.notEqual(j, null, 'journal must be preserved after launcher failure');
    assert.equal(j.targetVersion, '0.12.0');
  });

  test('_executeInstall: launcher success calls quitApp', async () => {
    let quit = false;
    const m = new UpdateManager(
      baseDeps(td, {
        spawn: mockSpawn({ closeCode: 0 }),
        quitApp: async () => {
          quit = true;
        },
      }),
    );
    await m._executeInstall(fakeTarget, writeFakeInstaller(td));
    assert.ok(quit, 'quitApp must be called on success');
  });

  test('_retryInstall: launcher fail does NOT clear journal', async () => {
    const m = new UpdateManager(baseDeps(td, { spawn: mockSpawn({ closeCode: 1 }) }));
    const updDir = dl.updatesDir(td);
    const ip = path.join(updDir, 'Setup.exe');
    mkdirSync(updDir, { recursive: true });
    writeFileSync(ip, 'FAKE');
    const h = createHash('sha256').update(Buffer.from('FAKE')).digest('hex');
    dl.writeJournal(updDir, {
      targetVersion: '0.12.0',
      assetId: 1,
      assetName: 'Setup.exe',
      digest: `sha256:${h}`,
      assetSize: 4,
      installerPath: ip,
      logPath: '',
      startedAt: '2026-07-20T00:00:00Z',
    });
    await m._retryInstall(dl.readJournal(updDir));
    assert.notEqual(dl.readJournal(updDir), null, 'journal must survive retry failure');
  });

  test('_retryInstall: launcher success calls quitApp', async () => {
    let quit = false;
    const m = new UpdateManager(
      baseDeps(td, {
        spawn: mockSpawn({ closeCode: 0 }),
        quitApp: async () => {
          quit = true;
        },
      }),
    );
    const updDir = dl.updatesDir(td);
    const ip = path.join(updDir, 'Setup.exe');
    mkdirSync(updDir, { recursive: true });
    writeFileSync(ip, 'FAKE');
    const h = createHash('sha256').update(Buffer.from('FAKE')).digest('hex');
    dl.writeJournal(updDir, {
      targetVersion: '0.12.0',
      assetId: 1,
      assetName: 'Setup.exe',
      digest: `sha256:${h}`,
      assetSize: 4,
      installerPath: ip,
      logPath: '',
      startedAt: '2026-07-20T00:00:00Z',
    });
    await m._retryInstall(dl.readJournal(updDir));
    assert.ok(quit, 'quitApp must be called on success');
  });
});

describe('automatic update schedule', () => {
  let td;
  beforeEach(() => {
    td = mkdtempSync(path.join(tmpdir(), 'mgr-schedule-'));
  });
  afterEach(() => {
    rmSync(td, { recursive: true, force: true });
  });

  test('checks at startup and then once every 24 hours', () => {
    let intervalCallback;
    let intervalMs;
    let clearedHandle;
    const intervalHandle = { kind: 'daily-update-check' };
    const calls = [];
    const m = new UpdateManager(
      baseDeps(td, {
        setInterval: (callback, ms) => {
          intervalCallback = callback;
          intervalMs = ms;
          return intervalHandle;
        },
        clearInterval: (handle) => {
          clearedHandle = handle;
        },
      }),
    );
    m.checkForUpdates = (opts) => {
      calls.push(opts);
    };

    try {
      m.startSchedule();
      assert.deepEqual(calls, [undefined], 'startup check must run immediately and remain silent');
      assert.equal(intervalMs, 24 * 60 * 60 * 1000);

      intervalCallback();
      assert.deepEqual(calls, [undefined, undefined], 'daily check must remain automatic/silent');
    } finally {
      m.stopSchedule();
    }

    assert.equal(clearedHandle, intervalHandle);
  });
});

describe('overlapping update checks', () => {
  let td;
  beforeEach(() => {
    td = mkdtempSync(path.join(tmpdir(), 'mgr-check-'));
  });
  afterEach(() => {
    rmSync(td, { recursive: true, force: true });
  });

  test('serializes checks so a later check observes the persisted Skip choice', async () => {
    const release = {
      tag_name: 'v0.12.0',
      draft: false,
      prerelease: false,
      body: '',
      assets: [
        { id: 1, name: 'ClowderAI-Setup-0.12.0.exe', size: 1, digest: 'sha256:a' },
        { id: 2, name: 'ClowderAI-0.12.0-arm64.dmg', size: 1, digest: 'sha256:b' },
        { id: 3, name: 'ClowderAI-0.12.0-x64.dmg', size: 1, digest: 'sha256:c' },
      ],
    };
    const controlled = controlledReleaseNet([release]);
    let dialogCount = 0;
    const m = new UpdateManager(
      baseDeps(td, {
        net: controlled.net,
        showDialog: async () => {
          dialogCount += 1;
          return dialogCount === 1 ? 2 : 1;
        },
      }),
    );

    const first = m.checkForUpdates();
    const second = m.checkForUpdates();
    await new Promise((resolve) => setImmediate(resolve));
    controlled.respondNext();
    await first;
    controlled.respondNext();
    await second;

    const settings = JSON.parse(readFileSync(path.join(td, 'update-settings.json'), 'utf8'));
    assert.equal(dialogCount, 1, 'the queued check must not show a duplicate update prompt');
    assert.equal(settings.skippedVersion, '0.12.0', 'the queued check must not overwrite the Skip choice');
  });
});

describe('main process update-schedule lifecycle', () => {
  test('stops the schedule before service shutdown on every quit path', () => {
    const source = readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const quitStart = source.indexOf('async function quitApp() {');
    const quitEnd = source.indexOf('\nfunction sendSplashStatus', quitStart);
    const quitBody = source.slice(quitStart, quitEnd);
    const beforeQuitStart = source.indexOf("app.on('before-quit'");
    const beforeQuitBody = source.slice(beforeQuitStart);

    assert.ok(quitStart >= 0 && quitEnd > quitStart, 'quitApp lifecycle must be present');
    assert.ok(beforeQuitStart >= 0, 'before-quit lifecycle must be present');

    for (const [name, body] of [
      ['quitApp', quitBody],
      ['before-quit', beforeQuitBody],
    ]) {
      const stopScheduleAt = body.indexOf('updater?.stopSchedule()');
      const stopServicesAt = body.indexOf('services.stopAll()');
      assert.ok(stopScheduleAt >= 0, `${name} must stop the update schedule`);
      assert.ok(
        stopServicesAt < 0 || stopScheduleAt < stopServicesAt,
        `${name} must stop the schedule before stopping services`,
      );
    }
  });
});
