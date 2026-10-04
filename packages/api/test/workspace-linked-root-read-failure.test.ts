import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getLinkedRootsAsync } from '../src/domains/workspace/workspace-security.js';

test('invalid persisted root inventory is unavailable, never an empty candidate list', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f309-linked-root-read-'));
  const cwd = process.cwd();
  const prior = process.env.WORKSPACE_LINKED_ROOTS;
  const priorDataDir = process.env.CAT_CAFE_DATA_DIR;
  try {
    process.chdir(root);
    process.env.CAT_CAFE_DATA_DIR = join(root, 'state');
    delete process.env.WORKSPACE_LINKED_ROOTS;
    assert.deepEqual(await getLinkedRootsAsync(), [], 'only an absent config means no registered entries');
    await mkdir(join(root, '.cat-cafe'));
    const path = join(root, '.cat-cafe', 'linked-roots.json');
    for (const body of ['{broken', '{}', '[{"name":"A"}]']) {
      await writeFile(path, body);
      await assert.rejects(getLinkedRootsAsync(), undefined, `corrupt inventory must be visible: ${body}`);
    }
  } finally {
    process.chdir(cwd);
    if (prior === undefined) delete process.env.WORKSPACE_LINKED_ROOTS;
    else process.env.WORKSPACE_LINKED_ROOTS = prior;
    if (priorDataDir === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = priorDataDir;
    await rm(root, { recursive: true, force: true });
  }
});
