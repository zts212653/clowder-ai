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
const { createShutdownController } = require('./shutdown-controller');
const { createWindowRecoveryController } = require('./window-recovery');
const { isInstallationShutdownRequest } = require('./installation-lifecycle');

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

function failingReleaseNet(message = 'offline') {
  let requests = 0;
  return {
    get requests() {
      return requests;
    },
    net: {
      request() {
        requests += 1;
        const req = new EventEmitter();
        req.setHeader = () => {};
        req.abort = () => {};
        req.end = () => process.nextTick(() => req.emit('error', new Error(message)));
        return req;
      },
    },
  };
}

function conditionalRefreshFailureNet() {
  let requests = 0;
  return {
    get requests() {
      return requests;
    },
    net: {
      request() {
        requests += 1;
        const requestNumber = requests;
        const req = new EventEmitter();
        req.setHeader = () => {};
        req.abort = () => {};
        req.end = () =>
          process.nextTick(() => {
            if (requestNumber === 2) {
              req.emit('error', new Error('unconditional refresh failed'));
              return;
            }
            const res = new EventEmitter();
            res.statusCode = 304;
            res.headers = {};
            res.destroy = () => {};
            req.emit('response', res);
          });
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

  test('transport failure offers Retry, browser download, or Cancel', async () => {
    const dialogs = [];
    const opened = [];
    const progress = [];
    const m = new UpdateManager(
      baseDeps(td, {
        setProgressBar: (value, context) => progress.push([value, context]),
        showDialog: async (options) => {
          dialogs.push(options);
          return 1;
        },
        openExternal: (url) => opened.push(url),
      }),
    );
    await m.downloadAndInstall(fakeTarget);
    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].title, 'Download Failed');
    assert.equal(dialogs[0].message, 'Could not download update');
    assert.deepEqual(dialogs[0].buttons, ['Retry', 'Download in Browser', 'Cancel']);
    assert.match(dialogs[0].detail, /net\.request/);
    assert.deepEqual(opened, [`https://github.com/zts212653/clowder-ai/releases/tag/v${fakeTarget.version}`]);
    assert.deepEqual(progress, [
      [
        0,
        {
          version: fakeTarget.version,
          assetName: fakeTarget.asset.name,
        },
      ],
      [
        -1,
        {
          version: fakeTarget.version,
          assetName: fakeTarget.asset.name,
        },
      ],
    ]);
  });

  test('sanitizes signed download URLs before logging or showing an error', async () => {
    const secret = 'X-Amz-Signature=TOP-SECRET';
    const dialogs = [];
    const logs = [];
    const m = new UpdateManager(
      baseDeps(td, {
        net: {
          request() {
            throw new Error(`request failed https://release-assets.githubusercontent.com/file.exe?${secret}`);
          },
        },
        dbg: (line) => logs.push(line),
        showDialog: async (options) => {
          dialogs.push(options);
          return 2;
        },
      }),
    );

    await m.downloadAndInstall(fakeTarget);

    const output = [...logs, ...dialogs.map((dialog) => dialog.detail)].join('\n');
    assert.doesNotMatch(output, /TOP-SECRET/);
    assert.match(output, /\[url\]/);
  });

  test('directory creation failure offers recovery and releases the download lock', async () => {
    const blockedRoot = path.join(td, 'not-a-directory');
    writeFileSync(blockedRoot, 'file blocks updates directory creation');
    const dialogs = [];
    const m = new UpdateManager(
      baseDeps(blockedRoot, {
        platform: 'darwin',
        showDialog: async (options) => {
          dialogs.push(options);
          return 2;
        },
      }),
    );

    await m.downloadAndInstall(fakeTarget);
    await m.downloadAndInstall(fakeTarget);

    assert.deepEqual(
      dialogs.map((dialog) => dialog.title),
      ['Download Failed', 'Download Failed'],
      'a failed mkdir must not leave later download attempts locked out',
    );
  });

  test('browser fallback rejection is logged and shown to the user', async () => {
    const dialogs = [];
    const logs = [];
    const m = new UpdateManager(
      baseDeps(td, {
        dbg: (line) => logs.push(line),
        showDialog: async (options) => {
          dialogs.push(options);
          return options.title === 'Download Failed' ? 1 : 0;
        },
        openExternal: async () => {
          throw new Error('no browser handler');
        },
      }),
    );

    await m.downloadAndInstall(fakeTarget);

    assert.deepEqual(
      dialogs.map((dialog) => dialog.title),
      ['Download Failed', 'Could Not Open Browser'],
    );
    assert.ok(logs.some((line) => line.includes('Could not open update release page')));
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

describe('rendered update prompt', () => {
  let td;
  beforeEach(() => {
    td = mkdtempSync(path.join(tmpdir(), 'mgr-prompt-'));
  });
  afterEach(() => {
    rmSync(td, { recursive: true, force: true });
  });

  test('delegates only the selected Windows asset and canonical link to the renderer', async () => {
    const prompts = [];
    const downloads = [];
    const target = {
      ...fakeTarget,
      releaseNotes:
        '## Downloads\n\n| Platform | File |\n| --- | --- |\n| Windows | Setup.exe |\n| macOS | arm64.dmg |',
    };
    const m = new UpdateManager(
      baseDeps(td, {
        showUpdatePrompt: async (prompt) => {
          prompts.push(prompt);
          return 'download';
        },
        showDialog: async () => 1,
      }),
    );
    m.downloadAndInstall = async (selected) => downloads.push(selected);

    await m._promptUpdate(target);

    assert.deepEqual(prompts, [
      {
        kind: 'available',
        version: fakeTarget.version,
        currentVersion: '0.11.0',
        platform: 'windows',
        assetName: fakeTarget.asset.name,
        releaseUrl: `https://github.com/zts212653/clowder-ai/releases/tag/v${fakeTarget.version}`,
        releaseNotes: target.releaseNotes,
      },
    ]);
    assert.deepEqual(downloads, [target]);
  });

  test('delegates only the selected macOS architecture asset to the renderer', async () => {
    const prompts = [];
    const target = {
      ...fakeTarget,
      asset: {
        ...fakeTarget.asset,
        name: 'ClowderAI-0.12.0-arm64.dmg',
      },
      releaseNotes: 'Windows: ClowderAI-Setup-0.12.0.exe\nmacOS: ClowderAI-0.12.0-x64.dmg',
    };
    const m = new UpdateManager(
      baseDeps(td, {
        platform: 'darwin',
        arch: 'arm64',
        showUpdatePrompt: async (prompt) => {
          prompts.push(prompt);
          return 'later';
        },
      }),
    );

    await m._promptUpdate(target);

    assert.deepEqual(prompts, [
      {
        kind: 'available',
        version: fakeTarget.version,
        currentVersion: '0.11.0',
        platform: 'macos',
        assetName: 'ClowderAI-0.12.0-arm64.dmg',
        releaseUrl: `https://github.com/zts212653/clowder-ai/releases/tag/v${fakeTarget.version}`,
        releaseNotes: target.releaseNotes,
      },
    ]);
  });

  test('bounds renderer release notes while preserving a complete-release escape hatch', async () => {
    const prompts = [];
    const m = new UpdateManager(
      baseDeps(td, {
        showUpdatePrompt: async (prompt) => {
          prompts.push(prompt);
          return 'later';
        },
      }),
    );

    await m._promptUpdate({ ...fakeTarget, releaseNotes: `# Notes\n\n${'x'.repeat(40_000)}` });

    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].releaseNotes.length <= 32_000);
    assert.match(prompts[0].releaseNotes, /Release notes truncated/);
    assert.match(prompts[0].releaseUrl, /releases\/tag\/v0\.12\.0$/);
  });

  test('maps renderer Skip action to persisted settings', async () => {
    writeFileSync(
      path.join(td, 'update-settings.json'),
      JSON.stringify({ autoCheck: true, etag: '"fresh"', skippedVersion: null }),
    );
    const m = new UpdateManager(
      baseDeps(td, {
        showUpdatePrompt: async () => 'skip',
        showDialog: async () => 1,
      }),
    );

    await m._promptUpdate(fakeTarget);

    const settings = JSON.parse(readFileSync(path.join(td, 'update-settings.json'), 'utf8'));
    assert.equal(settings.skippedVersion, fakeTarget.version);
    assert.equal(settings.etag, '"fresh"');
  });

  test('merges the latest auto-check preference when persisting a Skip action', async () => {
    writeFileSync(
      path.join(td, 'update-settings.json'),
      JSON.stringify({
        autoCheck: true,
        etag: '"fresh"',
        lastCheckAt: '2026-07-28T00:00:00.000Z',
        skippedVersion: null,
      }),
    );
    let m;
    m = new UpdateManager(
      baseDeps(td, {
        showUpdatePrompt: async () => {
          m.setAutoCheck(false);
          return 'skip';
        },
        showDialog: async () => 1,
      }),
    );

    await m._promptUpdate(fakeTarget);

    const settings = JSON.parse(readFileSync(path.join(td, 'update-settings.json'), 'utf8'));
    assert.equal(settings.autoCheck, false);
    assert.equal(settings.skippedVersion, fakeTarget.version);
    assert.equal(settings.etag, '"fresh"');
  });

  test('does not replace an unavailable rendered update prompt with a native dialog', async () => {
    const dialogs = [];
    const m = new UpdateManager(
      baseDeps(td, {
        showUpdatePrompt: async () => undefined,
        showDialog: async (options) => {
          dialogs.push(options);
          return 1;
        },
      }),
    );

    await m._promptUpdate({
      ...fakeTarget,
      releaseNotes: '## Downloads\n\n- Windows: ClowderAI-Setup-0.12.0.exe\n- macOS: ClowderAI-0.12.0-arm64.dmg',
    });

    assert.deepEqual(dialogs, []);
  });
});

describe('rendered install confirmation', () => {
  let td;
  beforeEach(() => {
    td = mkdtempSync(path.join(tmpdir(), 'mgr-install-prompt-'));
    setupInstallType(td, 'installer');
  });
  afterEach(() => {
    rmSync(td, { recursive: true, force: true });
  });

  test('uses the healthy renderer for Ready to Install and preserves the verified launch path', async () => {
    const promptCalls = [];
    const dialogs = [];
    let quit = false;
    const m = new UpdateManager(
      baseDeps(td, {
        showUpdatePrompt: async (prompt, options) => {
          promptCalls.push([prompt, options]);
          return 'install';
        },
        showDialog: async (options) => {
          dialogs.push(options);
          return 0;
        },
        quitApp: async () => {
          quit = true;
        },
      }),
    );

    await m._executeInstall(fakeTarget, writeFakeInstaller(td));

    assert.deepEqual(promptCalls, [
      [
        {
          kind: 'ready-to-install',
          version: fakeTarget.version,
          platform: 'windows',
          assetName: fakeTarget.asset.name,
        },
        { presentationTimeoutMs: 15_000 },
      ],
    ]);
    assert.deepEqual(dialogs, []);
    assert.equal(quit, true);
  });

  test('does not fall through to the native dialog when renderer chooses Later', async () => {
    const dialogs = [];
    let spawnCalls = 0;
    const m = new UpdateManager(
      baseDeps(td, {
        showUpdatePrompt: async () => 'later',
        showDialog: async (options) => {
          dialogs.push(options);
          return 0;
        },
        spawn: () => {
          spawnCalls += 1;
          return mockSpawn({ closeCode: 0 })();
        },
      }),
    );

    await m._executeInstall(fakeTarget, writeFakeInstaller(td));

    assert.deepEqual(dialogs, []);
    assert.equal(spawnCalls, 0);
  });

  test('retains the native confirmation when the renderer presentation is unavailable', async () => {
    const dialogs = [];
    const m = new UpdateManager(
      baseDeps(td, {
        showUpdatePrompt: async () => undefined,
        showDialog: async (options) => {
          dialogs.push(options);
          return 1;
        },
      }),
    );

    await m._executeInstall(fakeTarget, writeFakeInstaller(td));

    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0].title, 'Ready to Install');
  });
});

describe('automatic and manual update-check result matrix', () => {
  let td;
  beforeEach(() => {
    td = mkdtempSync(path.join(tmpdir(), 'mgr-check-result-'));
  });
  afterEach(() => {
    rmSync(td, { recursive: true, force: true });
  });

  test('automatic no-update and failure results stay silent and remain retryable', async () => {
    const noUpdate = conditionalReleaseNet([]);
    const prompts = [];
    const dialogs = [];
    const logs = [];
    const m = new UpdateManager(
      baseDeps(td, {
        net: noUpdate.net,
        showUpdatePrompt: async (prompt) => {
          prompts.push(prompt);
          return 'dismiss';
        },
        showDialog: async (dialog) => {
          dialogs.push(dialog);
          return 0;
        },
        dbg: (line) => logs.push(line),
      }),
    );

    await m.checkForUpdates();
    m._d.net = failingReleaseNet('offline').net;
    await m.checkForUpdates();

    assert.deepEqual(prompts, []);
    assert.deepEqual(dialogs, []);
    assert.ok(logs.includes('No update available'));
    assert.ok(logs.some((line) => line.includes('Release fetch failed')));
  });

  test('automatic checks surface only a newer non-skipped release', async () => {
    writeFileSync(
      path.join(td, 'update-settings.json'),
      JSON.stringify({ autoCheck: true, skippedVersion: fakeTarget.version }),
    );
    const skippedFeed = conditionalReleaseNet([completeRelease()]);
    const prompts = [];
    const m = new UpdateManager(
      baseDeps(td, {
        net: skippedFeed.net,
        showUpdatePrompt: async (prompt) => {
          prompts.push(prompt);
          return 'later';
        },
      }),
    );

    await m.checkForUpdates();
    assert.deepEqual(prompts, [], 'automatic checks must continue to honor Skip This Version');

    writeFileSync(path.join(td, 'update-settings.json'), JSON.stringify({ autoCheck: true, skippedVersion: null }));
    m._d.net = conditionalReleaseNet([completeRelease()]).net;
    await m.checkForUpdates();

    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].kind, 'available');
    assert.equal(prompts[0].version, fakeTarget.version);
  });

  test('manual no-update always renders an in-app up-to-date result', async () => {
    const prompts = [];
    const dialogs = [];
    const m = new UpdateManager(
      baseDeps(td, {
        net: conditionalReleaseNet([]).net,
        showUpdatePrompt: async (prompt) => {
          prompts.push(prompt);
          return 'dismiss';
        },
        showDialog: async (dialog) => {
          dialogs.push(dialog);
          return 0;
        },
      }),
    );

    await m.checkForUpdates({ manual: true });

    assert.deepEqual(prompts, [{ kind: 'up-to-date', version: '0.11.0' }]);
    assert.deepEqual(dialogs, []);
  });

  test('manual failure always renders an in-app result with the canonical Releases path', async () => {
    const prompts = [];
    const dialogs = [];
    const feed = failingReleaseNet('offline');
    const m = new UpdateManager(
      baseDeps(td, {
        net: feed.net,
        showUpdatePrompt: async (prompt) => {
          prompts.push(prompt);
          return 'dismiss';
        },
        showDialog: async (dialog) => {
          dialogs.push(dialog);
          return 0;
        },
      }),
    );

    await m.checkForUpdates({ manual: true });

    assert.deepEqual(prompts, [
      {
        kind: 'check-failed',
        version: '0.11.0',
        releaseUrl: 'https://github.com/zts212653/clowder-ai/releases',
      },
    ]);
    assert.deepEqual(dialogs, []);
    assert.equal(feed.requests, 1);
  });

  test('manual conditional-refresh failure renders the same failed result', async () => {
    writeFileSync(path.join(td, 'update-settings.json'), JSON.stringify({ autoCheck: true, etag: '"cached"' }));
    const prompts = [];
    const feed = conditionalRefreshFailureNet();
    const m = new UpdateManager(
      baseDeps(td, {
        net: feed.net,
        showUpdatePrompt: async (prompt) => {
          prompts.push(prompt);
          return 'dismiss';
        },
      }),
    );

    await m.checkForUpdates({ manual: true });

    assert.equal(feed.requests, 2);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].kind, 'check-failed');
  });

  test('manual checks ignore the automatic skipped-version preference', async () => {
    writeFileSync(
      path.join(td, 'update-settings.json'),
      JSON.stringify({ autoCheck: true, skippedVersion: fakeTarget.version }),
    );
    const prompts = [];
    const m = new UpdateManager(
      baseDeps(td, {
        net: conditionalReleaseNet([completeRelease()]).net,
        showUpdatePrompt: async (prompt) => {
          prompts.push(prompt);
          return 'later';
        },
      }),
    );

    await m.checkForUpdates({ manual: true });

    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].kind, 'available');
    assert.equal(prompts[0].version, fakeTarget.version);
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

  test('is idempotent when renderer readiness is announced more than once', () => {
    const intervalCallbacks = [];
    const calls = [];
    const m = new UpdateManager(
      baseDeps(td, {
        setInterval: (callback) => {
          intervalCallbacks.push(callback);
          return { index: intervalCallbacks.length };
        },
      }),
    );
    m.checkForUpdates = () => calls.push('check');

    m.startSchedule();
    m.startSchedule();

    assert.deepEqual(calls, ['check']);
    assert.equal(intervalCallbacks.length, 1);
    m.stopSchedule();
  });

  test('persists the default-on preference and stops or restarts future automatic checks', () => {
    const intervalHandles = [];
    const clearedHandles = [];
    const calls = [];
    const m = new UpdateManager(
      baseDeps(td, {
        setInterval: () => {
          const handle = { index: intervalHandles.length };
          intervalHandles.push(handle);
          return handle;
        },
        clearInterval: (handle) => clearedHandles.push(handle),
      }),
    );
    m.checkForUpdates = (opts) => calls.push(opts);

    assert.deepEqual(m.getSettings(), { autoCheck: true });

    m.startSchedule();
    assert.deepEqual(calls, [undefined]);
    assert.equal(intervalHandles.length, 1);

    assert.deepEqual(m.setAutoCheck(false), { autoCheck: false });
    assert.deepEqual(m.getSettings(), { autoCheck: false });
    assert.deepEqual(clearedHandles, [intervalHandles[0]]);

    m.startSchedule();
    assert.deepEqual(calls, [undefined], 'renderer readiness must not bypass a disabled preference');

    assert.deepEqual(m.setAutoCheck(true), { autoCheck: true });
    assert.deepEqual(calls, [undefined, undefined], 're-enabling must check immediately');
    assert.equal(intervalHandles.length, 2, 're-enabling must create one new daily timer');
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
    let promptCount = 0;
    const m = new UpdateManager(
      baseDeps(td, {
        net: controlled.net,
        showUpdatePrompt: async () => {
          promptCount += 1;
          return 'skip';
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
    assert.equal(promptCount, 1, 'the queued check must not show a duplicate update prompt');
    assert.equal(settings.skippedVersion, '0.12.0', 'the queued check must not overwrite the Skip choice');
  });

  test('preserves an auto-check change made while a release request is in flight', async () => {
    writeFileSync(path.join(td, 'update-settings.json'), JSON.stringify({ autoCheck: true }));
    const controlled = controlledReleaseNet([]);
    const m = new UpdateManager(baseDeps(td, { net: controlled.net }));

    const check = m.checkForUpdates();
    await new Promise((resolve) => setImmediate(resolve));
    m.setAutoCheck(false);
    controlled.respondNext();
    await check;

    const settings = JSON.parse(readFileSync(path.join(td, 'update-settings.json'), 'utf8'));
    assert.equal(settings.autoCheck, false);
    assert.ok(settings.lastCheckAt);
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
        showUpdatePrompt: async () => 'skip',
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
  function createShutdownHarness() {
    const events = [];
    const state = {
      services: {
        stopAll: async () => events.push('stopAll'),
      },
      tray: { destroy: () => events.push('tray.destroy') },
      updater: { stopSchedule: () => events.push('schedule.stop') },
      updatePrompt: { dispose: () => events.push('prompt.dispose') },
      isQuitting: false,
      phase: 'ready',
    };
    const controller = createShutdownController({
      app: { quit: () => events.push('app.quit') },
      startupController: { abort: () => events.push('startup.abort') },
      getServices: () => state.services,
      setServices: (value) => {
        state.services = value;
      },
      getTray: () => state.tray,
      setTray: (value) => {
        state.tray = value;
      },
      getUpdater: () => state.updater,
      getUpdatePrompt: () => state.updatePrompt,
      setUpdatePrompt: (value) => {
        state.updatePrompt = value;
      },
      setQuitting: (value) => {
        state.isQuitting = value;
      },
      setPhase: (value) => {
        state.phase = value;
      },
      dbg: () => {},
    });
    return { controller, events, state };
  }

  test('wires the rendered prompt and default session into the packaged main window', () => {
    const mainSource = readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const runtimeSource = readFileSync(path.join(__dirname, 'desktop-update-runtime.js'), 'utf8');
    const source = `${mainSource}\n${runtimeSource}`;
    const navigationSource = readFileSync(path.join(__dirname, 'renderer-navigation.js'), 'utf8');
    const visibleSource = readFileSync(path.join(__dirname, 'visible-renderer.js'), 'utf8');
    const controllerSource = readFileSync(path.join(__dirname, 'update-prompt-controller.js'), 'utf8');
    const preloadSource = readFileSync(path.join(__dirname, 'preload.js'), 'utf8');

    assert.match(source, /preload:\s*path\.join\(__dirname,\s*'preload\.js'\)/);
    assert.match(source, /new UpdatePromptController/);
    assert.match(source, /showUpdatePrompt:\s*\(prompt, options\)\s*=>\s*updatePrompt\.show\(prompt, options\)/);
    assert.match(source, /netSession:\s*session\.defaultSession/);
    assert.match(mainSource, /const \{ installRendererNavigation \} = require\('\.\/renderer-navigation'\)/);
    assert.match(
      mainSource,
      /installRendererNavigation\(\{\s*window: mainWindow,\s*appOrigin: APP_ORIGIN,\s*apiOrigin: API_ORIGIN,\s*getLinkOrigins: \(\) => rendererLinkOrigins,\s*shell,\s*dbg,\s*\}\)/,
      'the actual main window must use the current app, API and runtime preview-origin policy',
    );
    assert.match(navigationSource, /setWindowOpenHandler/);
    assert.match(navigationSource, /isAllowedRendererLink/);
    assert.match(
      source,
      /showVisibleRenderer\(\{\s*window: mainWindow,\s*url: createVersionedRendererUrl\(APP_URL,\s*app\.getVersion\(\)\),/,
      "desktop startup must bypass another package version's service-worker document cache",
    );
    assert.match(mainSource, /const \{ showVisibleRenderer \} = require\('\.\/visible-renderer'\)/);
    assert.match(visibleSource, /window\.loadURL\(url\)/);
    assert.match(source, /rendererLinkOrigins\s*=\s*createBaseRendererLinkOrigins\(\)/);
    assert.match(source, /resolveRendererLinkOrigins/);
    assert.match(source, /net\.fetch\(`\$\{API_ORIGIN\}\/api\/preview\/status`/);
    assert.equal(
      mainSource.match(
        /(?:await refreshRendererLinkOrigins\(\)|await startupTimeline\.runPhase\('preview-origin', \(\) => refreshRendererLinkOrigins\(\)\))/g,
      )?.length,
      2,
      'both initial startup and installer-recovery restart must refresh the runtime preview origin',
    );
    assert.match(
      mainSource,
      /startServices:[\s\S]*?await services\.startAll\(\);\s*await refreshRendererLinkOrigins\(\);/,
      'installer recovery must replace the runtime preview origin after the restarted services are ready',
    );
    assert.match(
      mainSource,
      /stopServices:[\s\S]*?services = null;[\s\S]*?rendererLinkOrigins = createBaseRendererLinkOrigins\(\);/,
      'stopping services must revoke the no-longer-owned preview origin',
    );
    assert.match(navigationSource, /isAllowedRendererLink\(parsed\.href,\s*getLinkOrigins\(\)\)/);
    assert.doesNotMatch(
      [source, navigationSource].join('\n'),
      /process\.env\.PREVIEW_GATEWAY_PORT/,
      'popup admission must use the API runtime port rather than configured intent',
    );
    assert.match(
      navigationSource,
      /const guardAppNavigation = \(event\) => \{\s*if \(event\.isMainFrame === false \|\| isExpectedOrigin\(event\.url, appOrigin\)\) return;/,
      'subframe redirects must remain under the iframe/gateway policy',
    );
    assert.match(navigationSource, /webContents\.on\('will-navigate',\s*\(event\)\s*=>/);
    assert.match(navigationSource, /webContents\.on\('will-redirect',\s*guardAppNavigation\)/);
    assert.match(
      navigationSource,
      /webContents\.on\('will-navigate',[\s\S]*?event\.isMainFrame !== false && isAllowedRendererDownload\(event\.url,\s*apiOrigin\)[\s\S]*?webContents\.downloadURL\(event\.url\)/,
      'trusted API /uploads navigation must become a download without admitting API top-level navigation',
    );
    assert.match(source, /trustedOrigin:\s*APP_ORIGIN/);
    assert.match(source, /onRendererReady:\s*\(\)\s*=>\s*updater\?\.startSchedule\(\)/);
    assert.doesNotMatch(
      source,
      /createMainWindow\(\);\s*\/\/ F273: Start update check after services are up\s*updater\.startSchedule\(\)/,
      'startup checking must wait for the trusted renderer readiness contract',
    );
    assert.match(source, /updatePrompt\.setProgress/);
    assert.match(
      source,
      /webContents\.on\('did-navigate',\s*\(\)\s*=>\s*updatePrompt\?\.markRendererUnavailable\(\)\)/,
    );
    assert.doesNotMatch(source, /deliverDocumentCapability|markDocumentCommitted/);
    assert.doesNotMatch(source, /webContents\.on\('did-start-navigation'/);
    assert.doesNotMatch(source, /webContents\.on\('did-start-loading'/);
    assert.doesNotMatch(source, /shouldInvalidateRendererReadiness/);
    assert.doesNotMatch(
      `${controllerSource}\n${preloadSource}`,
      /desktop-update:register|document-capability/,
      'renderer documents must not be able to request or replace readiness authority',
    );
    // Actual main-window wiring and renderer crash invalidation are exercised
    // by main-renderer-lifecycle.test.js, including the extracted helper.
  });

  test('uses one runtime-safe Windows AppUserModelID in the process and installed shortcuts', () => {
    const source = readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    const installer = readFileSync(path.join(__dirname, 'installer', 'cat-cafe.iss'), 'utf8');
    const installerId = installer.match(/#define MyAppUserModelID\s+"([^"]+)"/)?.[1];

    assert.doesNotMatch(
      source,
      /require\(['"]\.\/package\.json['"]\)\.build/,
      'packaged startup must not read electron-builder-only build metadata',
    );
    const { DESKTOP_APP_ID } = require('./app-identity');
    assert.equal(DESKTOP_APP_ID, pkg.build.appId, 'runtime identity must match the electron-builder appId');
    assert.equal(installerId, DESKTOP_APP_ID, 'Inno shortcuts must use the runtime AppUserModelID');
    assert.ok(pkg.build.files.includes('app-identity.js'), 'the runtime identity module must be packaged');
    for (const runtimeModule of [
      'desktop-update-menu.js',
      'desktop-update-runtime.js',
      'mac-install-location.js',
      'memory-fallback-consent.js',
      'shutdown-controller.js',
      'startup-failure-handler.js',
      'update-install-flow.js',
    ]) {
      assert.ok(pkg.build.files.includes(runtimeModule), `${runtimeModule} must be packaged`);
    }
    assert.match(source, /require\(['"]\.\/app-identity['"]\)/);
    assert.match(source, /app\.setAppUserModelId\(DESKTOP_APP_ID\)/);
    assert.ok(
      source.indexOf('app.setAppUserModelId(DESKTOP_APP_ID)') < source.indexOf("app.on('ready'"),
      'the process identity must be set before any Windows UI or notification',
    );
    assert.match(installer, /Name: "\{group\}\\\{#MyAppName\}"[^\n]*AppUserModelID: "\{#MyAppUserModelID\}"/);
    assert.match(installer, /Name: "\{autodesktop\}\\\{#MyAppName\}"[^\n]*AppUserModelID: "\{#MyAppUserModelID\}"/);
  });

  test('keeps renderer progress projection independent from optional tray presentation', () => {
    const source = readFileSync(path.join(__dirname, 'desktop-update-runtime.js'), 'utf8');
    const progressStart = source.indexOf('setProgressBar: (progress, context) => {');
    const progressEnd = source.indexOf('\n    openExternal:', progressStart);
    const progressCallback = source.slice(progressStart, progressEnd);

    assert.ok(progressStart >= 0 && progressEnd > progressStart, 'setProgressBar callback must be present');
    assert.doesNotMatch(
      progressCallback,
      /if\s*\(!tray\)\s*return/,
      'the documented no-tray fallback must not suppress AppShell progress or its terminal clear',
    );
    assert.match(progressCallback, /if\s*\(tray\)[\s\S]*tray\.setToolTip/);
    assert.match(progressCallback, /updatePrompt\.setProgress/);
  });

  test('quitApp stops the update schedule before draining services and is idempotent', async () => {
    const { controller, events, state } = createShutdownHarness();

    const first = controller.quitApp();
    const second = controller.quitApp();
    assert.equal(first, second, 'every quit caller shares the one shutdown');
    await first;

    assert.deepEqual(events, [
      'startup.abort',
      'schedule.stop',
      'prompt.dispose',
      'stopAll',
      'tray.destroy',
      'app.quit',
    ]);
    assert.equal(state.isQuitting, true);
    assert.equal(state.phase, 'quitting');
    assert.equal(state.services, null);
    assert.equal(state.tray, null);
    assert.equal(state.updatePrompt, null);
  });

  test('before-quit blocks exit only while services still need draining', async () => {
    const { controller, events, state } = createShutdownHarness();
    let prevented = 0;
    const event = {
      preventDefault: () => {
        prevented += 1;
      },
    };

    const cleanup = controller.handleBeforeQuit(event);
    assert.equal(prevented, 1);
    await cleanup;
    assert.deepEqual(events, [
      'startup.abort',
      'schedule.stop',
      'prompt.dispose',
      'stopAll',
      'tray.destroy',
      'app.quit',
    ]);

    // The re-issued app.quit() must pass through without blocking again.
    const settledEvents = events.length;
    controller.handleBeforeQuit(event);
    const repeatedEvents = events.slice(settledEvents);
    assert.equal(prevented, 1);
    assert.ok(!repeatedEvents.includes('stopAll'), 'drained services must not be stopped twice');
    assert.ok(!repeatedEvents.includes('app.quit'), 'the second before-quit must not re-issue app.quit');
    assert.equal(state.services, null);
  });

  test('installer-requested quit drains services once through the shared shutdown controller', async () => {
    const mainSource = readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const secondInstanceStart = mainSource.indexOf("app.on('second-instance'");
    const secondInstanceEnd = mainSource.indexOf("\napp.on('ready'", secondInstanceStart);

    assert.match(mainSource, /QUIT_FOR_UPDATE_ARG\s*=\s*'--quit-owned-installation'/);
    assert.match(
      mainSource.slice(secondInstanceStart, secondInstanceEnd),
      /windowRecovery\.handleSecondInstance\(commandLine, identity\)/,
      'the installer request must stay wired to window recovery',
    );

    const { controller, events, state } = createShutdownHarness();
    const base = mkdtempSync(path.join(tmpdir(), 'installer-quit-'));
    try {
      const root = path.join(base, 'install');
      const userData = path.join(base, 'instance');
      mkdirSync(root);
      mkdirSync(userData);
      const recovery = createWindowRecoveryController({
        getState: () => ({
          phase: 'ready',
          mainWindow: null,
          splashWindow: null,
          services: state.services,
          isQuitting: state.isQuitting,
        }),
        createMainWindow: async () => {},
        quitArg: '--quit-owned-installation',
        isShutdownRequest: isInstallationShutdownRequest,
        projectRoot: root,
        getUserDataRoot: () => userData,
        quitApp: controller.quitApp,
        dbg: () => {},
      });

      recovery.handleSecondInstance(['clowder-ai.exe', '--quit-owned-installation'], {
        installRoot: path.join(base, 'foreign-install'),
        userDataRoot: userData,
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(events, [], 'a foreign installation identity cannot shut this instance down');

      recovery.handleSecondInstance(['clowder-ai.exe', '--quit-owned-installation'], {
        installRoot: root,
        userDataRoot: userData,
      });
      recovery.handleSecondInstance(['clowder-ai.exe', '--quit-owned-installation'], {
        installRoot: root,
        userDataRoot: userData,
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(events, [
        'startup.abort',
        'schedule.stop',
        'prompt.dispose',
        'stopAll',
        'tray.destroy',
        'app.quit',
      ]);
      assert.equal(state.services, null);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('macOS application menu retains standard editing roles', () => {
    const source = readFileSync(path.join(__dirname, 'desktop-update-menu.js'), 'utf8');
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) {
      assert.match(source, new RegExp(`role: '${role}'`), `macOS menu must preserve the ${role} role`);
    }
  });

  test('keeps every refactored updater production module within the 350-line hard boundary', () => {
    const files = [
      'main.js',
      'desktop-update-menu.js',
      'desktop-update-runtime.js',
      'mac-install-location.js',
      'update-manager.js',
      'update-install-flow.js',
      'update-prompt-controller.js',
      '../packages/web/src/components/DesktopUpdatePrompt.tsx',
      '../packages/web/src/components/DesktopUpdatePromptDialog.tsx',
      '../packages/web/src/components/DesktopUpdatePromptContent.tsx',
    ];
    for (const file of files) {
      const lines = readFileSync(path.join(__dirname, file), 'utf8').trimEnd().split('\n').length;
      assert.ok(lines <= 350, `${file} has ${lines} lines; production hard limit is 350`);
    }
  });
});
