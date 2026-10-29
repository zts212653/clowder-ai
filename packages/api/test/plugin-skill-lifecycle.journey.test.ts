import assert from 'node:assert/strict';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pluginSkillLifecycleFixture } from './helpers/plugin-skill-lifecycle-fixture.js';

test('real Manager install → enable with conflict → choose source → restart → uninstall → reinstall', async () => {
  const f = await pluginSkillLifecycleFixture();
  try {
    let current = (await f.manager.getLocal(f.pluginId)).plugin;
    await f.manager.setEnabled(f.pluginId, { enabled: true, expectedRevision: current.lifecycleRevision! });
    current = (await f.manager.getLocal(f.pluginId)).plugin;
    assert.equal(current.activationFailed, undefined);
    assert.equal(current.intent, 'enabled');
    assert.equal(current.skillConflicts?.length, 1);
    assert.equal(current.skillConflicts![0].mountPointId, 'codex');
    assert.equal(await readFile(join(f.root, '.claude/skills/guide/SKILL.md'), 'utf8'), '# Fixture plugin guide\n');
    const result = await f.manager.resolveSkillConflict(f.pluginId, {
      ...current.skillConflicts![0],
      expectedRevision: current.lifecycleRevision!,
    });
    assert.equal(
      await readFile(join(f.root, result.backupPath, 'user.md'), 'utf8'),
      'User-owned content must survive.',
    );
    current = (await f.manager.getLocal(f.pluginId)).plugin;
    assert.deepEqual(current.skillConflicts, []);
    await f.manager.restart(f.pluginId, { expectedRevision: current.lifecycleRevision! });
    current = (await f.manager.getLocal(f.pluginId)).plugin;
    assert.equal(current.activationFailed, undefined);
    assert.deepEqual(current.skillConflicts, []);
    await f.manager.uninstall(f.pluginId, { expectedRevision: current.lifecycleRevision! });
    assert.equal(
      await readFile(join(f.root, result.backupPath, 'user.md'), 'utf8'),
      'User-owned content must survive.',
    );
    await f.install();
    current = (await f.manager.getLocal(f.pluginId)).plugin;
    await f.manager.setEnabled(f.pluginId, { enabled: true, expectedRevision: current.lifecycleRevision! });
    current = (await f.manager.getLocal(f.pluginId)).plugin;
    assert.equal(current.intent, 'enabled');
    assert.equal(current.activationFailed, undefined);
    assert.deepEqual(current.skillConflicts, []);
  } finally {
    await f.close();
  }
});

test('a blocked mount ancestor remains diagnostic and does not prevent uninstall', async () => {
  const f = await pluginSkillLifecycleFixture();
  try {
    let current = (await f.manager.getLocal(f.pluginId)).plugin;
    await f.manager.setEnabled(f.pluginId, { enabled: true, expectedRevision: current.lifecycleRevision! });
    await rename(join(f.root, '.codex'), join(f.root, 'preserved-codex'));
    await writeFile(join(f.root, '.codex'), 'user-owned blocker');
    current = (await f.manager.getLocal(f.pluginId)).plugin;
    assert.equal(current.activationFailed, undefined);
    assert.equal(
      current.skillConflicts?.some((c) => c.mountPointId === 'codex' && !c.canResolve),
      true,
    );
    await f.manager.uninstall(f.pluginId, { expectedRevision: current.lifecycleRevision! });
    assert.equal(await readFile(join(f.root, '.codex'), 'utf8'), 'user-owned blocker');
    assert.equal(
      await readFile(join(f.root, 'preserved-codex/skills/guide/user.md'), 'utf8'),
      'User-owned content must survive.',
    );
  } finally {
    await f.close();
  }
});

test(
  'an unreadable mount is diagnostic and does not prevent uninstall',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async () => {
    const f = await pluginSkillLifecycleFixture();
    try {
      let current = (await f.manager.getLocal(f.pluginId)).plugin;
      await f.manager.setEnabled(f.pluginId, { enabled: true, expectedRevision: current.lifecycleRevision! });
      await chmod(join(f.root, '.codex/skills'), 0o000);
      current = (await f.manager.getLocal(f.pluginId)).plugin;
      assert.equal(
        current.skillConflicts?.some((c) => c.mountPointId === 'codex' && !c.canResolve),
        true,
      );
      await f.manager.uninstall(f.pluginId, { expectedRevision: current.lifecycleRevision! });
    } finally {
      await chmod(join(f.root, '.codex/skills'), 0o755);
      await f.close();
    }
  },
);
