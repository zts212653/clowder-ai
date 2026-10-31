const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'project-mirror-startup-'));
const keys = ['CAT_CAFE_DESKTOP_INSTANCE_ROOT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
delete process.env.CAT_CAFE_DESKTOP_INSTANCE_ROOT;
for (const key of keys.slice(1)) process.env[key] = fixtureRoot;
const ServiceManager = require('./service-manager');
after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('one startup recovers unreadable docs mirrors when the actual Node consumer can read them', async () => {
  const installRoot = path.join(fixtureRoot, 'Clowder AI installed');
  const userRoot = path.join(fixtureRoot, 'user data');
  for (const relative of [
    'packages/api/dist/index.js',
    'docs/harness-feedback/eval-domains/eval-design-gate.yaml',
    'cat-cafe-skills/refs/shared-rules.md',
    'cat-cafe-skills/custody-recognition/SKILL.md',
    // Isolate the docs regression from the old loose-plugin prerequisite.
    'plugins/github/plugin.yaml',
  ]) {
    const file = path.join(installRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'startup fixture\n');
    // Existing read-only project resources also exercise preservation: startup
    // must not require replacing real directories to recover a reader failure.
    if (!relative.startsWith('packages/')) {
      const mirrorFile = path.join(userRoot, 'project', relative);
      fs.mkdirSync(path.dirname(mirrorFile), { recursive: true });
      fs.writeFileSync(mirrorFile, 'startup fixture\n');
    }
  }
  fs.mkdirSync(path.join(installRoot, 'packages/api/node_modules'), { recursive: true });
  const node = path.join(installRoot, process.platform === 'win32' ? 'node/node.exe' : 'node/bin/node');
  fs.mkdirSync(path.dirname(node), { recursive: true });
  // A Homebrew Node binary resolves libnode relative to its executable. A
  // hard link gives dyld a second path for the same inode and can poison
  // concurrent probes. POSIX symlinks retain the real installed loader root;
  // Windows Node is a standalone executable and can be copied safely.
  if (process.platform === 'win32') fs.copyFileSync(process.execPath, node);
  else fs.symlinkSync(process.execPath, node);
  const manager = new ServiceManager(installRoot, { frontendPort: 5200, apiPort: 3200, redisPort: 6300 });
  manager._getUserDataDir = () => userRoot;
  manager._isPortOpen = async () => false;
  const starts = [];
  manager._startRedis = async () => starts.push('redis');
  manager._startApi = async (selectedNode) => {
    assert.equal(selectedNode, node, 'readiness and API must use the same bundled Node');
    starts.push('api');
  };
  manager._startNextJs = () => starts.push('web');
  manager._waitForHttpReady = async () => {};
  const originalRead = fs.readFileSync;
  const docsProbe = path.join(userRoot, 'project/docs/harness-feedback/eval-domains/eval-design-gate.yaml');
  let failedParentReads = 0;
  fs.readFileSync = function readWithParentOnlyFailure(file, ...args) {
    if (file === docsProbe) {
      failedParentReads += 1;
      throw Object.assign(new Error('UNKNOWN: unknown error, open'), {
        code: 'UNKNOWN',
        errno: -4094,
        syscall: 'open',
      });
    }
    return originalRead.call(this, file, ...args);
  };
  try {
    await manager.startAll();
    assert.ok(failedParentReads > 0, 'the actual startup entry must encounter the injected failure');
    assert.deepEqual(starts.sort(), ['api', 'redis', 'web']);
  } finally {
    fs.readFileSync = originalRead;
  }
});
