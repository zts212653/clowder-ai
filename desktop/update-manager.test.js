// F273 — update-manager unit tests
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

function conditionalReleaseNet(releases) {
  const requests = [];
  return {
    requests,
    net: {
      request() {
        const req = new EventEmitter();
        const headers = {};
        req.setHeader = (name, value) => {
          headers[name.toLowerCase()] = value;
        };
        req.abort = () => {};
        req.end = () => {
          requests.push(headers);
          process.nextTick(() => {
            const res = new EventEmitter();
            res.statusCode = headers['if-none-match'] ? 304 : 200;
            res.headers = res.statusCode === 200 ? { etag: '"fresh-etag"' } : {};
            res.destroy = () => {};
            req.emit('response', res);
            if (res.statusCode === 200) {
              process.nextTick(() => {
                res.emit('data', Buffer.from(JSON.stringify(releases)));
                process.nextTick(() => res.emit('end'));
              });
            }
          });
        };
        return req;
      },
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
  asset: {
    id: 1,
    name: 'ClowderAI-Setup-0.12.0.exe',
    digest: `sha256:${FAKE_HASH}`,
    size: FAKE_CONTENT.length,
  },
};

function completeRelease(version = fakeTarget.version, winDigest = fakeTarget.asset.digest) {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    body: '',
    assets: [
      {
        id: 1,
        name: `ClowderAI-Setup-${version}.exe`,
        size: FAKE_CONTENT.length,
        digest: winDigest,
        browser_download_url: `https://github.com/zts212653/clowder-ai/releases/download/v${version}/win.exe`,
      },
      { id: 2, name: `ClowderAI-${version}-arm64.dmg`, size: 1, digest: 'sha256:b' },
      { id: 3, name: `ClowderAI-${version}-x64.dmg`, size: 1, digest: 'sha256:c' },
    ],
  };
}

/** Create a fake installer file matching fakeTarget's digest + size. */
function writeFakeInstaller(tempDir) {
  const updDir = dl.updatesDir(tempDir);
  mkdirSync(updDir, { recursive: true });
  const ip = path.join(updDir, fakeTarget.asset.name);
  writeFileSync(ip, FAKE_CONTENT);
  return ip;
}

function writeRetryJournal(tempDir) {
  const updDir = dl.updatesDir(tempDir);
  const installerPath = writeFakeInstaller(tempDir);
  dl.writeJournal(updDir, {
    targetVersion: fakeTarget.version,
    assetId: fakeTarget.asset.id,
    assetName: fakeTarget.asset.name,
    digest: fakeTarget.asset.digest,
    assetSize: fakeTarget.asset.size,
    installerPath,
    logPath: '',
    startedAt: '2026-07-20T00:00:00Z',
  });
  return dl.readJournal(updDir);
}

function retryDeps(tempDir, overrides = {}) {
  return baseDeps(tempDir, { net: conditionalReleaseNet([completeRelease()]).net, ...overrides });
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

  test('passes Inno switches as separate child arguments without PowerShell re-parsing', async () => {
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
    assert.equal(captured[0], 'C:\\Clowder AI\\Setup.exe');
    assert.deepEqual(captured[1], [
      '/SILENT',
      '/SUPPRESSMSGBOXES',
      '/NORESTART',
      '/SP-',
      '/LOG=C:\\Clowder AI\\log.txt',
    ]);
    assert.deepEqual(captured[2], { stdio: 'ignore' });
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

  test('_executeInstall: re-verifies after service shutdown before spawning', async () => {
    const installerPath = writeFakeInstaller(td);
    let spawnCalls = 0;
    const m = new UpdateManager(
      baseDeps(td, {
        stopServices: async () => {
          writeFileSync(installerPath, Buffer.from('REPLACED-DURING-SHUTDOWN'));
        },
        spawn: () => {
          spawnCalls += 1;
          return mockSpawn({ closeCode: 0 })();
        },
      }),
    );
    await m._executeInstall(fakeTarget, installerPath);
    assert.equal(spawnCalls, 0, 'a post-verification replacement must never reach the elevation boundary');
  });

  test('_retryInstall: launcher fail does NOT clear journal', async () => {
    const m = new UpdateManager(retryDeps(td, { spawn: mockSpawn({ closeCode: 1 }) }));
    await m._retryInstall(writeRetryJournal(td));
    assert.notEqual(dl.readJournal(dl.updatesDir(td)), null, 'journal must survive retry failure');
  });

  test('_retryInstall: launcher failure leaves startup service lifecycle to main', async () => {
    let stopCalls = 0;
    const m = new UpdateManager(
      retryDeps(td, {
        spawn: mockSpawn({ closeCode: 1 }),
        stopServices: async () => {
          stopCalls += 1;
        },
      }),
    );
    await m._retryInstall(writeRetryJournal(td));
    assert.equal(stopCalls, 0, 'startup recovery must not null main-owned services before normal startup');
  });

  test('_retryInstall: launcher failure reports the error', async () => {
    const dialogs = [];
    const m = new UpdateManager(
      retryDeps(td, {
        spawn: mockSpawn({ closeCode: 1 }),
        showDialog: async (options) => {
          dialogs.push(options);
          return 0;
        },
      }),
    );
    await m._retryInstall(writeRetryJournal(td));
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].title, 'Install Failed');
    assert.equal(dialogs[0].message, 'Could not start the installer');
  });

  test('_retryInstall: launcher success calls quitApp', async () => {
    let quit = false;
    const m = new UpdateManager(
      retryDeps(td, {
        spawn: mockSpawn({ closeCode: 0 }),
        quitApp: async () => {
          quit = true;
        },
      }),
    );
    await m._retryInstall(writeRetryJournal(td));
    assert.ok(quit, 'quitApp must be called on success');
  });

  test('_retryInstall: ignores journal-controlled elevated arguments and derives the log path locally', async () => {
    const journal = writeRetryJournal(td);
    const expectedInstallerPath = journal.installerPath;
    journal.installerPath = 'C:\\Users\\me\\Setup.exe" /DIR="C:\\Windows\\Temp\\Hijack';
    journal.logPath = 'C:\\Users\\me\\x" /DIR="C:\\Windows\\Temp\\Hijack';
    dl.writeJournal(dl.updatesDir(td), journal);
    let captured;
    const m = new UpdateManager(
      retryDeps(td, {
        spawn: (...args) => {
          captured = args;
          return mockSpawn({ closeCode: 0 })();
        },
      }),
    );

    await m._retryInstall(dl.readJournal(dl.updatesDir(td)));

    assert.equal(captured[0], expectedInstallerPath);
    assert.deepEqual(captured[1], [
      '/SILENT',
      '/SUPPRESSMSGBOXES',
      '/NORESTART',
      '/SP-',
      `/LOG=${path.join(dl.updatesDir(td), 'install.log')}`,
    ]);
    assert.ok(!captured[1].some((arg) => arg.startsWith('/DIR=')), 'journal data must not add Inno switches');
  });

  test('failed-upgrade View Log ignores a journal-controlled path', async () => {
    const journal = writeRetryJournal(td);
    journal.logPath = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
    dl.writeJournal(dl.updatesDir(td), journal);
    const opened = [];
    const m = new UpdateManager(
      retryDeps(td, {
        showDialog: async () => 2,
        openPath: (targetPath) => opened.push(targetPath),
      }),
    );

    await m.checkPendingUpgrade();

    assert.deepEqual(opened, [path.join(dl.updatesDir(td), 'install.log')]);
  });

  test('_retryInstall: rejects a journal digest not present in fresh release metadata', async () => {
    const malicious = Buffer.from('MALICIOUS-INSTALLER');
    const journal = writeRetryJournal(td);
    writeFileSync(journal.installerPath, malicious);
    journal.digest = `sha256:${createHash('sha256').update(malicious).digest('hex')}`;
    journal.assetSize = malicious.length;
    dl.writeJournal(dl.updatesDir(td), journal);
    let spawnCalls = 0;
    const m = new UpdateManager(
      retryDeps(td, {
        spawn: () => {
          spawnCalls += 1;
          return mockSpawn({ closeCode: 0 })();
        },
      }),
    );
    await m._retryInstall(dl.readJournal(dl.updatesDir(td)));
    assert.equal(spawnCalls, 0, 'journal metadata must not authorize an installer launch');
  });
});

describe('download failures', () => {
  let td;
  beforeEach(() => {
    td = mkdtempSync(path.join(tmpdir(), 'mgr-download-'));
    setupInstallType(td, 'installer');
  });
  afterEach(() => {
    rmSync(td, { recursive: true, force: true });
  });

  test('transport failure offers Retry or Cancel', async () => {
    const dialogs = [];
    const m = new UpdateManager(
      baseDeps(td, {
        showDialog: async (options) => {
          dialogs.push(options);
          return 1;
        },
      }),
    );
    await m.downloadAndInstall(fakeTarget);
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].title, 'Download Failed');
    assert.equal(dialogs[0].message, 'Could not download update');
    assert.deepEqual(dialogs[0].buttons, ['Retry', 'Cancel']);
    assert.match(dialogs[0].detail, /net\.request/);
  });

  test('verified installer reuse bypasses the new-download disk-space gate', async () => {
    const originalCheckDiskSpace = dl.checkDiskSpace;
    const dialogs = [];
    dl.checkDiskSpace = () => false;
    try {
      const m = new UpdateManager(
        baseDeps(td, {
          showDialog: async (options) => {
            dialogs.push(options);
            return 1;
          },
        }),
      );
      writeFakeInstaller(td);
      await m.downloadAndInstall(fakeTarget);
      assert.equal(dialogs[0]?.title, 'Ready to Install');
    } finally {
      dl.checkDiskSpace = originalCheckDiskSpace;
    }
  });
});

describe('release metadata trust boundary', () => {
  let td;
  beforeEach(() => {
    td = mkdtempSync(path.join(tmpdir(), 'mgr-release-cache-'));
  });
  afterEach(() => {
    rmSync(td, { recursive: true, force: true });
  });

  test('304 response re-fetches metadata instead of trusting the persistent release cache', async () => {
    writeFileSync(path.join(td, 'update-settings.json'), JSON.stringify({ autoCheck: true, etag: '"cached-etag"' }));
    writeFileSync(path.join(td, 'release-cache.json'), JSON.stringify([completeRelease('9.9.9', 'sha256:attacker')]));
    const feed = conditionalReleaseNet([]);
    let dialogCount = 0;
    const m = new UpdateManager(
      baseDeps(td, {
        net: feed.net,
        showDialog: async () => {
          dialogCount += 1;
          return 1;
        },
      }),
    );
    await m.checkForUpdates();
    assert.equal(feed.requests.length, 2, '304 must be followed by an unconditional metadata fetch');
    assert.equal(feed.requests[1]['if-none-match'], undefined);
    assert.equal(dialogCount, 0, 'persistent cache contents must not reach the update prompt');
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

  test('Skip preserves the refreshed ETag and last-check timestamp', async () => {
    writeFileSync(
      path.join(td, 'update-settings.json'),
      JSON.stringify({ autoCheck: true, skippedVersion: null, etag: '"stale-etag"', lastCheckAt: null }),
    );
    const feed = conditionalReleaseNet([completeRelease()]);
    const m = new UpdateManager(
      baseDeps(td, {
        net: feed.net,
        showDialog: async () => 2,
      }),
    );

    await m.checkForUpdates();

    const settings = JSON.parse(readFileSync(path.join(td, 'update-settings.json'), 'utf8'));
    assert.equal(feed.requests.length, 2, '304 must be followed by an unconditional metadata refresh');
    assert.equal(settings.skippedVersion, fakeTarget.version);
    assert.equal(settings.etag, '"fresh-etag"', 'Skip must not restore the stale ETag snapshot');
    assert.ok(settings.lastCheckAt, 'Skip must preserve the timestamp from the completed check');
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

  test('installer-requested quit reaches the same service shutdown lifecycle', () => {
    const mainSource = readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const installerSource = readFileSync(path.join(__dirname, 'installer', 'cat-cafe.iss'), 'utf8');
    const secondInstanceStart = mainSource.indexOf("app.on('second-instance'");
    const secondInstanceEnd = mainSource.indexOf("\napp.on('ready'", secondInstanceStart);
    const secondInstanceBody = mainSource.slice(secondInstanceStart, secondInstanceEnd);

    assert.match(mainSource, /QUIT_FOR_UPDATE_ARG\s*=\s*'--quit-for-update'/);
    assert.match(secondInstanceBody, /commandLine\.includes\(QUIT_FOR_UPDATE_ARG\)/);
    assert.match(secondInstanceBody, /quitApp\(\)/);
    assert.match(installerSource, /ExecAsOriginalUser[\s\S]*--quit-for-update[\s\S]*ewNoWait/);
    assert.doesNotMatch(installerSource, /CloseMainWindow/);
    assert.ok(
      installerSource.indexOf('--quit-for-update') < installerSource.indexOf('Stop-Process -Force'),
      'coordinated app quit must precede the bounded force-cleanup fallback',
    );
  });

  test('macOS application menu retains standard editing roles', () => {
    const source = readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) {
      assert.match(source, new RegExp(`role: '${role}'`), `macOS menu must preserve the ${role} role`);
    }
  });
});
