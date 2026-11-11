import assert from 'node:assert/strict';
import fs, { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

assert.equal(process.env.CAT_CAFE_TEST_SANDBOX, '1', 'Run with packages/api/scripts/with-test-home.mjs');
const { isForeignAgentPrivatePath, resolveForeignAgentMountRoot } = await import(
  '../../dist/utils/foreign-agent-mount-guard.js'
);

it('matches complete reserved prefixes across case, separators and dot segments', () => {
  ['.cac', '.CAC\\skills', './.relay/skills', '.config//opencode/skills', '.CONFIG\\OpenCode'].forEach((path) => {
    assert.equal(isForeignAgentPrivatePath(path), true, path);
  });
  [
    '.cacfoo/skills',
    '.relay-tools',
    'x/.cac/skills',
    '.config/opencodeX',
    '.config/other',
    '.claude/skills',
    '.codex/skills',
  ].forEach((path) => {
    assert.equal(isForeignAgentPrivatePath(path), false, path);
  });
});

it('resolves an aliased home and reconstructs absent private-root descendants', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'foreign-agent-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realHome = join(root, 'real-home');
  const home = join(root, 'home-alias');
  const project = join(root, 'project');
  await Promise.all([realHome, project].map((path) => mkdir(path)));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(realHome, home, linkType);
  await symlink(realHome, join(project, 'bridge'), linkType);
  assert.equal(
    await resolveForeignAgentMountRoot(join(project, 'bridge', '.cac', 'new', 'skills'), home),
    join(home, '.cac'),
  );
  assert.equal(
    await resolveForeignAgentMountRoot(join(project, 'bridge', '.config', 'opencode', 'skills'), home),
    join(home, '.config/opencode'),
  );
  assert.equal(await resolveForeignAgentMountRoot(join(project, 'new', 'skills'), home), null);
  assert.equal(await resolveForeignAgentMountRoot(join(project, '.cac', 'skills'), home), null);
});

['file', 'file-link'].forEach((kind) => {
  it(`allows unrelated mounts when home/.config is a ${kind}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'foreign-agent-config-file-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    await mkdir(home);
    const config = join(home, '.config');
    if (kind === 'file') await writeFile(config, 'existing user file');
    else {
      const target = join(root, 'config-file');
      await writeFile(target, 'existing user file');
      await symlink(target, config, 'file');
    }
    assert.equal(await resolveForeignAgentMountRoot(join(root, 'project', 'skills'), home), null);
    assert.equal(await resolveForeignAgentMountRoot(join(home, '.cac', 'skills'), home), join(home, '.cac'));
  });
});

it('treats ENOTDIR from private-root resolution as absent while preserving permission errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'foreign-agent-root-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const privateRoot = join(root, '.config', 'opencode');
  const nativeRealpath = fs.realpath;
  let code = 'ENOTDIR';
  // Windows reports ENOENT for this layout; inject the POSIX error at the filesystem boundary.
  t.mock.method(fs, 'realpath', (path) => {
    if (path === privateRoot) return Promise.reject(Object.assign(new Error(code), { code }));
    return nativeRealpath(path);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.equal(await resolveForeignAgentMountRoot(join(root, 'project', 'skills'), root), null);
  code = 'EACCES';
  await assert.rejects(resolveForeignAgentMountRoot(join(root, 'project', 'skills'), root), { code: 'EACCES' });
});
