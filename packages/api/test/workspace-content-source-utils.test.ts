import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  canonicalizeWorkspaceContentLocator,
  openedWorkspaceContentMatchesCanonicalLocator,
} from '../src/domains/workspace/workspace-content-source-utils.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('opened-fd containment proof rejects a pathname swapped after canonical resolution', async () => {
  const created = await mkdtemp(join(tmpdir(), 'f309-opened-fd-'));
  roots.push(created);
  const root = await realpath(created);
  const path = join(root, 'notes.md');
  await writeFile(path, 'original owner bytes');
  const resolved = await canonicalizeWorkspaceContentLocator(root, { worktreeId: 'workspace', path: 'notes.md' });
  const handle = await open(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await rename(path, join(root, 'notes-before-swap.md'));
    await writeFile(path, 'replacement owner bytes');
    assert.equal(
      await openedWorkspaceContentMatchesCanonicalLocator(root, resolved.path, resolved.locator, handle),
      false,
    );
  } finally {
    await handle.close();
  }
});
