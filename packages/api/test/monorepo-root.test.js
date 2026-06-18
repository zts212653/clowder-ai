import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const { _clearCachesForTest, findMonorepoRoot } = await import('../dist/utils/monorepo-root.js');

describe('findMonorepoRoot', () => {
  afterEach(() => {
    _clearCachesForTest();
  });

  it('does not cache a child fallback root for traversed ancestor directories', () => {
    const project = mkdtempSync(join(tmpdir(), 'plain-project-'));
    const subdir = join(project, 'subdir');
    const nested = join(subdir, 'nested');
    mkdirSync(subdir);
    mkdirSync(nested);

    assert.equal(findMonorepoRoot(subdir), subdir);
    assert.equal(findMonorepoRoot(nested), nested);
    assert.equal(findMonorepoRoot(project), project);
  });
});
