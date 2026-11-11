import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
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
