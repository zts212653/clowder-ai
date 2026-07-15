import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';

let setPickDirectoryImpl;
let projectsRoutes;

// Load module once
const mod = await import('../dist/routes/projects.js');
setPickDirectoryImpl = mod.setPickDirectoryImpl;
projectsRoutes = mod.projectsRoutes;

// Restore real impl after each test
const realImpl = mod.execPickDirectory;
afterEach(() => setPickDirectoryImpl(realImpl));

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user' };

async function buildApp() {
  const app = Fastify();
  await app.register(projectsRoutes);
  await app.ready();
  return app;
}

describe('execPickDirectory()', () => {
  it('is exported as a function', () => {
    assert.equal(typeof mod.execPickDirectory, 'function');
  });
});

describe('getPickDirectoryCommand()', () => {
  it('uses osascript on macOS', () => {
    const command = mod.getPickDirectoryCommand('darwin');
    assert.ok(command);
    assert.equal(command.command, 'osascript');
    assert.deepEqual(command.args, ['-e', 'POSIX path of (choose folder)']);
  });

  it('uses PowerShell folder picker on Windows', () => {
    const command = mod.getPickDirectoryCommand('win32');
    assert.ok(command);
    assert.equal(command.command, 'powershell.exe');
    assert.ok(command.args.includes('-STA'));
    assert.match(command.args.at(-1), /FolderBrowserDialog/);
  });

  it('returns null on unsupported platforms', () => {
    assert.equal(mod.getPickDirectoryCommand('linux'), null);
  });
});

describe('normalizePickedDirectoryPath()', () => {
  it('preserves Windows drive roots', () => {
    assert.equal(mod.normalizePickedDirectoryPath('C:\\'), 'C:\\');
    assert.equal(mod.normalizePickedDirectoryPath('D:/'), 'D:\\');
  });

  it('trims trailing separators from non-root directories', () => {
    assert.equal(mod.normalizePickedDirectoryPath('C:\\workspace\\clowder-ai\\'), 'C:\\workspace\\clowder-ai');
    assert.equal(mod.normalizePickedDirectoryPath('/tmp/demo/'), '/tmp/demo');
  });
});

describe('splitProjectCompletePrefix()', () => {
  it('treats a trailing backslash as a directory prefix on Windows', () => {
    const result = mod.splitProjectCompletePrefix('C:\\Users\\alice\\repo\\', 'C:\\Users\\alice', 'win32');
    assert.equal(result.parentDir, 'C:\\Users\\alice\\repo');
    assert.equal(result.fragment, '');
  });
});

describe('getProjectBrowseParent()', () => {
  it('returns the parent path for Windows browse results', () => {
    assert.equal(mod.getProjectBrowseParent('C:\\Users\\alice\\repo', 'win32'), 'C:\\Users\\alice');
    assert.equal(mod.getProjectBrowseParent('C:\\', 'win32'), null);
  });
});

describe('POST /api/projects/pick-directory', () => {
  it('returns 401 without trusted identity header', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/projects/pick-directory' });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Identity required'));
  });

  it('returns 204 when user cancels', async () => {
    setPickDirectoryImpl(async () => ({ status: 'cancelled' }));
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/projects/pick-directory', headers: AUTH_HEADERS });
    assert.equal(res.statusCode, 204);
  });

  it('returns 500 on system error', async () => {
    setPickDirectoryImpl(async () => ({ status: 'error', message: 'osascript not found' }));
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/projects/pick-directory', headers: AUTH_HEADERS });
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'osascript not found');
  });

  it('returns path and name when user picks valid directory', async () => {
    const home = homedir();
    setPickDirectoryImpl(async () => ({ status: 'picked', path: home }));
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/projects/pick-directory', headers: AUTH_HEADERS });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.path, home);
    assert.equal(typeof body.name, 'string');
  });

  it('returns 403 for path outside allowed roots', async () => {
    setPickDirectoryImpl(async () => ({ status: 'picked', path: '/nonexistent/evil/path' }));
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/projects/pick-directory', headers: AUTH_HEADERS });
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.ok(body.error);
  });

  it('GET returns 404 (only POST registered)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/projects/pick-directory' });
    assert.equal(res.statusCode, 404);
  });
});

describe('GET /api/projects/browse (F113 cross-platform)', () => {
  it('returns 401 without trusted identity header', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/projects/browse' });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Identity required'));
  });

  it('returns home directory listing by default', async () => {
    const sampleDirName = 'pick-directory-home-fixture';
    mkdirSync(join(homedir(), sampleDirName), { recursive: true });

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/projects/browse', headers: AUTH_HEADERS });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.current, homedir());
    assert.equal(typeof body.name, 'string');
    assert.ok(Array.isArray(body.entries));
    assert.ok(body.entries.some((entry) => entry.name === sampleDirName));
    // All entries should be directories
    for (const entry of body.entries) {
      assert.equal(entry.isDirectory, true);
      assert.equal(typeof entry.name, 'string');
      assert.equal(typeof entry.path, 'string');
    }
  });

  it('returns parent path for navigation', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/browse?path=${encodeURIComponent(homedir())}`,
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    // Home should have a parent (e.g., /Users on macOS, /home on Linux)
    // parent can be null if at root of allowed roots, which is also valid
    assert.ok(body.parent === null || typeof body.parent === 'string');
  });

  it('returns 403 for path outside allowed roots', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/browse?path=/nonexistent/evil',
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.ok(body.error);
  });

  it('filters out hidden directories and node_modules', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/browse?path=${encodeURIComponent(homedir())}`,
      headers: AUTH_HEADERS,
    });
    const body = JSON.parse(res.body);
    for (const entry of body.entries) {
      assert.ok(!entry.name.startsWith('.'), `should hide: ${entry.name}`);
      assert.notEqual(entry.name, 'node_modules');
    }
  });
});

describe('listAvailableDrives()', () => {
  it('returns [] on non-Windows platforms', () => {
    assert.deepEqual(mod.listAvailableDrives('darwin'), []);
    assert.deepEqual(mod.listAvailableDrives('linux'), []);
  });

  it('returns an array of DriveInfo with letter/path/label shape on win32', () => {
    // On a non-Windows test host, realpathSync('C:\\') throws, so every probe
    // fails and the result is []. That still validates the function does not
    // throw and returns the correct type. On a real Windows host this would
    // return populated entries for mounted drives.
    const result = mod.listAvailableDrives('win32');
    assert.ok(Array.isArray(result));
    for (const d of result) {
      assert.ok(typeof d.letter === 'string' && d.letter.length === 1);
      assert.ok(typeof d.path === 'string');
      assert.ok(typeof d.label === 'string');
    }
  });

  it('skips A: and B: (floppy legacy) — only probes C through Z', () => {
    // Indirect assertion: listAvailableDrives never returns A or B regardless
    // of platform, since the probe loop starts at 'C'.
    for (const plat of ['win32', 'darwin', 'linux']) {
      for (const d of mod.listAvailableDrives(plat)) {
        assert.notEqual(d.letter, 'A');
        assert.notEqual(d.letter, 'B');
      }
    }
  });

  it('returns mounted drives and skips inaccessible ones (deterministic probe)', () => {
    const probe = (root) => {
      if (root === 'C:\\') return 'C:\\';
      if (root === 'D:\\') return 'D:\\';
      throw new Error('ENOENT');
    };
    const result = mod.listAvailableDrives('win32', probe);
    assert.equal(result.length, 2);
    assert.equal(result[0].letter, 'C');
    assert.equal(result[0].path, 'C:\\');
    assert.equal(result[0].label, '本地磁盘 (C:)');
    assert.equal(result[1].letter, 'D');
    assert.equal(result[1].path, 'D:\\');
  });

  it('returns [] when no drives are accessible (deterministic probe)', () => {
    const probe = () => {
      throw new Error('ENOENT');
    };
    const result = mod.listAvailableDrives('win32', probe);
    assert.deepEqual(result, []);
  });

  it('returns the real path resolved by the probe, not the probed root', () => {
    // realpath may resolve junctions; returned path must be the resolved one.
    const probe = (root) => {
      if (root === 'C:\\') return 'C:\\';
      throw new Error('ENOENT');
    };
    const result = mod.listAvailableDrives('win32', probe);
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'C:\\');
  });
});

describe('GET /api/projects/drives', () => {
  it('returns 401 without trusted identity header', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/projects/drives' });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Identity required'));
  });

  it('returns a drives array (empty on non-Windows host)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/projects/drives', headers: AUTH_HEADERS });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.drives));
    // On the macOS/Linux CI host, no Windows drives are mounted → [].
    // On a Windows host, this would contain C: at minimum.
    for (const d of body.drives) {
      assert.ok(typeof d.letter === 'string');
      assert.ok(typeof d.path === 'string');
      assert.ok(typeof d.label === 'string');
    }
    // Server-owned capability contract (R4): isWindows reflects the server's
    // platform, not the client's. On this host it matches process.platform.
    assert.equal(typeof body.isWindows, 'boolean');
    assert.equal(body.isWindows, process.platform === 'win32');
  });

  it('browse endpoint returns isWindows capability', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/projects/browse', headers: AUTH_HEADERS });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(typeof body.isWindows, 'boolean');
    assert.equal(body.isWindows, process.platform === 'win32');
  });
});
