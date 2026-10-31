import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { requireCodexTestHistoryPolicy } from './native-codex-history-policy.mjs';

test('real Codex acceptance rejects a shared login/history home without a specific archival plan', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-test-history-'));
  const instance = path.join(root, 'instance'),
    nativeHome = path.join(root, 'daily-codex');
  try {
    await fs.mkdir(instance);
    await fs.mkdir(nativeHome);
    await fs.writeFile(path.join(instance, 'client-homes.json'), JSON.stringify({ codex: nativeHome }));
    await assert.rejects(requireCodexTestHistoryPolicy(instance), /native history is shared/);
    await assert.rejects(requireCodexTestHistoryPolicy(instance, 'approved'), /native history is shared/);
    assert.deepEqual(await requireCodexTestHistoryPolicy(instance, 'approved-verified-archive'), {
      nativeHome: await fs.realpath(nativeHome),
      scope: 'shared-native-history',
      requiresVerifiedArchival: true,
    });
    assert.deepEqual(
      await fs.readdir(nativeHome),
      [],
      'The guard never reads or copies login contents or creates sessions',
    );
  } finally {
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'codex-test-history-')));
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('a genuinely absent override stays inside the instance, while corrupt configuration fails closed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-test-history-'));
  try {
    const result = await requireCodexTestHistoryPolicy(root);
    assert.equal(result.requiresVerifiedArchival, false);
    assert.equal(result.nativeHome, path.join(await fs.realpath(root), 'home', '.codex'));
    await fs.writeFile(path.join(root, 'client-homes.json'), '{bad');
    await assert.rejects(requireCodexTestHistoryPolicy(root), SyntaxError);
    await fs.writeFile(path.join(root, 'client-homes.json'), '[]');
    await assert.rejects(requireCodexTestHistoryPolicy(root), /Invalid client homes/);
  } finally {
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'codex-test-history-')));
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('an apparently isolated home through a junction or symlink remains shared', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-test-history-'));
  try {
    const instance = path.join(root, 'instance'),
      daily = path.join(root, 'daily');
    await fs.mkdir(instance);
    await fs.mkdir(daily);
    const alias = path.join(instance, 'native');
    await fs.symlink(daily, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(path.join(instance, 'client-homes.json'), JSON.stringify({ codex: alias }));
    await assert.rejects(requireCodexTestHistoryPolicy(instance), /native history is shared/);
  } finally {
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'codex-test-history-')));
    await fs.rm(root, { recursive: true, force: true });
  }
});
