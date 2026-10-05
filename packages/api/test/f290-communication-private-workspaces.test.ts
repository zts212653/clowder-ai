import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { prepareCollectiveWorkDirectory } from '../src/domains/cats/services/agents/providers/collective-work-cli-policy.js';

test('Task execution generations and replacement native attempts keep persistent draft files in distinct writable directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f290-workspaces-'));
  try {
    const first = await prepareCollectiveWorkDirectory(root, 'owner', 'private-A', 'A', 1, 'message:g1');
    await writeFile(join(first.workspaceRoot, 'draft'), 'OLD_ATTEMPT_DRAFT');
    const replacement = await prepareCollectiveWorkDirectory(root, 'owner', 'private-A', 'A', 1, 'message:g1');
    const continued = await prepareCollectiveWorkDirectory(root, 'owner', 'private-A', 'A', 2, 'message:g2');
    assert.notEqual(
      first.workspaceRoot,
      replacement.workspaceRoot,
      'a superseded shell must not share successor writable drafts',
    );
    assert.notEqual(
      dirname(first.controlRoot),
      dirname(continued.controlRoot),
      'a new execution authority has a separate generation',
    );
    assert.equal(
      await readFile(join(first.workspaceRoot, 'draft'), 'utf8'),
      'OLD_ATTEMPT_DRAFT',
      'old drafts persist without widening write access',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
