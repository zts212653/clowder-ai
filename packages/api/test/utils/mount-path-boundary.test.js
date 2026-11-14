import assert from 'node:assert/strict';
import fs, { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

assert.equal(process.env.CAT_CAFE_TEST_SANDBOX, '1', 'Run with packages/api/scripts/with-test-home.mjs');
const { resolveMountBoundaryEscape } = await import('../../dist/utils/mount-path-boundary.js');

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

it('uses the physical project root, including aliases and absent tail directories', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mount-root-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const alias = join(root, 'alias');
  const outside = join(root, 'project-other');
  await Promise.all([project, outside].map((path) => mkdir(path)));
  await symlink(project, alias, LINK_TYPE);
  await symlink(project, join(project, 'inside'), LINK_TYPE);
  await symlink(outside, join(project, 'bridge'), LINK_TYPE);
  assert.equal(await resolveMountBoundaryEscape(alias, join(alias, 'new', 'skills')), null);
  assert.equal(await resolveMountBoundaryEscape(project, join(project, 'inside', 'new', 'skills')), null);
  assert.equal(
    await resolveMountBoundaryEscape(alias, join(alias, 'bridge', 'new', 'skills')),
    join(await fs.realpath(outside), 'new', 'skills'),
  );
});

it('treats explicitly configured directories inside a home project like any other project', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mount-home-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['.cac/skills', '.relay/skills', '.config/opencode/skills', '.cacfoo/skills']) {
    assert.equal(await resolveMountBoundaryEscape(root, join(root, path)), null, path);
  }
});

it('resolves absent descendants behind a file within the boundary helper', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mount-file-blocker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.config'), 'existing user file');
  assert.equal(await resolveMountBoundaryEscape(root, join(root, '.config', 'skills')), null);
  assert.equal(await resolveMountBoundaryEscape(root, join(root, '.test-skills')), null);
});

it('handles ENOTDIR from missing-tail resolution but propagates permission errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mount-boundary-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, 'missing', 'skills');
  const nativeRealpath = fs.realpath;
  let code = 'ENOTDIR';
  // Windows returns ENOENT for this layout; inject the POSIX error at the filesystem boundary.
  t.mock.method(fs, 'realpath', (path) => {
    if (path === destination) return Promise.reject(Object.assign(new Error(code), { code }));
    return nativeRealpath(path);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.equal(await resolveMountBoundaryEscape(root, destination), null);
  code = 'EACCES';
  await assert.rejects(resolveMountBoundaryEscape(root, destination), { code: 'EACCES' });
});
