import assert from 'node:assert/strict';
import { homedir } from 'node:os';
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
  it('returns 401 without identity header', async () => {
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
