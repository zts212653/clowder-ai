import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connectWorkspaceRoot, readRootConnection } from '../src/domains/workspace/roots/workspace-root-connection.js';
import { getLinkedRootsAsync, removeLinkedRoot } from '../src/domains/workspace/workspace-security.js';

test('environment aliases cannot hide a shared connection or prevent removing that separate grant', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'f309-root-env-'));
  const priorData = process.env.CAT_CAFE_DATA_DIR;
  const priorEnv = process.env.WORKSPACE_LINKED_ROOTS;
  try {
    process.env.CAT_CAFE_DATA_DIR = join(temp, 'state');
    const a = join(temp, 'A', 'shared');
    const b = join(temp, 'B', 'shared');
    await Promise.all([mkdir(a, { recursive: true }), mkdir(b, { recursive: true })]);
    process.env.WORKSPACE_LINKED_ROOTS = `shared:${b},same-physical-root:${a}`;
    const receipt = await connectWorkspaceRoot('operator', 'connect-A', await realpath(a), 0);
    const roots = await getLinkedRootsAsync();
    assert.equal(roots.length, 3);
    assert.equal(roots.filter((entry) => entry.removable).length, 1);
    assert.equal(roots.find((entry) => entry.removable)?.id, receipt.linked.id);
    assert.equal(await removeLinkedRoot(receipt.linked.id, receipt.currentEpoch), true);
    assert.equal((await readRootConnection('operator', 'connect-A'))?.connected, false);
    const remaining = await getLinkedRootsAsync();
    assert.equal(remaining.length, 2, 'removing one shared connection does not revoke independent configuration');
    assert.ok(remaining.every((entry) => !entry.removable));
    assert.equal((await connectWorkspaceRoot('operator', 'connect-A', await realpath(a), 0)).connected, false);
  } finally {
    if (priorData === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = priorData;
    if (priorEnv === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = priorEnv;
    await rm(temp, { recursive: true, force: true });
  }
});
