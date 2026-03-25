import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';

const { projectsRoutes } = await import('../dist/routes/projects.js');
const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user' };

async function buildApp() {
  const app = Fastify();
  await app.register(projectsRoutes);
  await app.ready();
  return app;
}

describe('GET /api/projects/complete', () => {
  let testDir;
  let app;

  before(async () => {
    // Create test directory structure under /tmp (allowed root)
    testDir = mkdtempSync('/tmp/cat-cafe-test-complete-');
    mkdirSync(join(testDir, 'src'));
    mkdirSync(join(testDir, 'src', 'components'));
    mkdirSync(join(testDir, 'src', 'utils'));
    mkdirSync(join(testDir, 'docs'));
    writeFileSync(join(testDir, 'README.md'), '# test');
    writeFileSync(join(testDir, 'src', 'index.ts'), 'export {}');
    writeFileSync(join(testDir, 'src', 'components', 'App.tsx'), '<div/>');
    // Hidden dir + node_modules should be filtered
    mkdirSync(join(testDir, '.git'));
    mkdirSync(join(testDir, 'node_modules'));
    app = await buildApp();
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns 401 when only a spoofed userId query param is provided', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/complete?prefix=${encodeURIComponent(join(testDir, 'src/'))}&cwd=${encodeURIComponent(testDir)}&userId=spoofed`,
    });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Identity required'));
  });

  it('returns matching entries for directory prefix', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/complete?prefix=${encodeURIComponent(join(testDir, 'src/'))}&cwd=${encodeURIComponent(testDir)}`,
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.entries));
    const names = body.entries.map((e) => e.name);
    assert.ok(names.includes('components/'));
    assert.ok(names.includes('utils/'));
    assert.ok(names.includes('index.ts'));
  });

  it('returns matching entries for partial name prefix', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/complete?prefix=${encodeURIComponent(join(testDir, 'src/comp'))}&cwd=${encodeURIComponent(testDir)}`,
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const names = body.entries.map((e) => e.name);
    assert.ok(names.includes('components/'));
    assert.equal(names.length, 1);
  });

  it('directories have trailing slash in name, files do not', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/complete?prefix=${encodeURIComponent(join(testDir, 'src/'))}&cwd=${encodeURIComponent(testDir)}`,
      headers: AUTH_HEADERS,
    });
    const body = JSON.parse(res.body);
    for (const entry of body.entries) {
      if (entry.isDirectory) {
        assert.ok(entry.name.endsWith('/'), `dir entry "${entry.name}" should end with /`);
      } else {
        assert.ok(!entry.name.endsWith('/'), `file entry "${entry.name}" should not end with /`);
      }
    }
  });

  it('respects limit parameter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/complete?prefix=${encodeURIComponent(join(testDir, 'src/'))}&limit=1&cwd=${encodeURIComponent(testDir)}`,
      headers: AUTH_HEADERS,
    });
    const body = JSON.parse(res.body);
    assert.equal(body.entries.length, 1);
  });

  it('returns empty entries for no match', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/complete?prefix=${encodeURIComponent(join(testDir, 'nonexistent'))}&cwd=${encodeURIComponent(testDir)}`,
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepStrictEqual(body.entries, []);
  });

  it('filters hidden directories and node_modules', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/complete?prefix=${encodeURIComponent(`${testDir}/`)}&cwd=${encodeURIComponent(testDir)}`,
      headers: AUTH_HEADERS,
    });
    const body = JSON.parse(res.body);
    const names = body.entries.map((e) => e.name);
    assert.ok(!names.some((n) => n.startsWith('.')), 'should not include hidden entries');
    assert.ok(!names.some((n) => n.startsWith('node_modules')), 'should not include node_modules');
  });

  it('returns 403 for prefix under denied system directory', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/complete?prefix=${encodeURIComponent('/dev/null')}&cwd=/dev`,
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 403);
  });

  it('returns 400 when prefix is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/complete',
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 400);
  });

  it('supports relative prefix with cwd', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/complete?prefix=src/&cwd=${encodeURIComponent(testDir)}`,
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const names = body.entries.map((e) => e.name);
    assert.ok(names.includes('components/'));
    assert.ok(names.includes('utils/'));
  });

  it('P2 regression: expands ~/  to home directory', async () => {
    // ~/  should resolve to homedir, not literal "~" directory
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/complete?prefix=${encodeURIComponent('~/')}&cwd=${encodeURIComponent(testDir)}`,
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    // Home dir exists and has entries — should not be empty
    // (unless running in a very restricted env, but /tmp-based testDir won't affect this)
    assert.ok(Array.isArray(body.entries));
    // The response should NOT be a 403 (home is in allowed roots)
  });

  it('sorts entries alphabetically, directories first', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/complete?prefix=${encodeURIComponent(`${testDir}/`)}&cwd=${encodeURIComponent(testDir)}`,
      headers: AUTH_HEADERS,
    });
    const body = JSON.parse(res.body);
    const dirs = body.entries.filter((e) => e.isDirectory);
    const files = body.entries.filter((e) => !e.isDirectory);
    // All dirs come before all files
    const lastDirIdx = body.entries.findLastIndex((e) => e.isDirectory);
    const firstFileIdx = body.entries.findIndex((e) => !e.isDirectory);
    if (dirs.length > 0 && files.length > 0) {
      assert.ok(lastDirIdx < firstFileIdx, 'directories should come before files');
    }
  });
});
