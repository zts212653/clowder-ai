import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { listWorktrees } from '../src/domains/workspace/workspace-security.js';

test('an explicitly selected non-Git directory stays that directory instead of becoming the process checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f309-selected-nongit-'));
  try {
    const entries = await listWorktrees(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.root, resolve(root));
    assert.equal(entries[0]?.branch, 'exported');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
