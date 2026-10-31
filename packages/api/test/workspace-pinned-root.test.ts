import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getLinkedRootsAsync } from '../src/domains/workspace/roots/workspace-linked-roots.js';
import { connectWorkspaceRoot } from '../src/domains/workspace/roots/workspace-root-connection.js';
import {
  durableIdForCanonicalRoot,
  resolveAuthorizedWorkspaceContentWorktree,
} from '../src/domains/workspace/workspace-worktree-identity.js';

test('replacing a confirmed directory with a symlink grants neither its old identity nor the new target identity', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'f309-pinned-root-'));
  const priorData = process.env.CAT_CAFE_DATA_DIR;
  const priorLinked = process.env.WORKSPACE_LINKED_ROOTS;
  try {
    process.env.CAT_CAFE_DATA_DIR = join(temp, 'state');
    delete process.env.WORKSPACE_LINKED_ROOTS;
    const a = join(temp, 'A');
    const b = join(temp, 'B');
    await Promise.all([mkdir(a), mkdir(b)]);
    const first = await connectWorkspaceRoot('operator', 'connect-A', await realpath(a), 0);
    await rename(a, `${a}-original`);
    await symlink(b, a);
    for (const id of [first.linked.id, durableIdForCanonicalRoot(await realpath(b))]) {
      const result = await resolveAuthorizedWorkspaceContentWorktree({
        worktreeId: id,
        currentEntries: [],
        linkedEntries: await getLinkedRootsAsync(),
        legacyRoots: [],
        listWorktrees: async () => [],
      });
      assert.equal(result, null, `only the original physical A was confirmed, never ${id}`);
    }
  } finally {
    if (priorData === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = priorData;
    if (priorLinked === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = priorLinked;
    await rm(temp, { recursive: true, force: true });
  }
});
