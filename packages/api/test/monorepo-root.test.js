import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const { _clearCachesForTest, findMonorepoRoot, isSameProject } = await import('../dist/utils/monorepo-root.js');

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

  it('treats no-git public exports and their synthetic worktrees as the same project', () => {
    const project = mkdtempSync(join(tmpdir(), 'public-export-project-'));
    const worktree = mkdtempSync(join(tmpdir(), 'public-export-worktree-'));

    writeFileSync(join(project, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(project, '.git', 'worktrees', 'public-export-worktree')}\n`);

    assert.equal(isSameProject(worktree, project), true);
  });

  it('treats no-git public export subdirectories as the same project root', () => {
    const project = mkdtempSync(join(tmpdir(), 'public-export-subdir-project-'));
    const subdir = join(project, 'packages', 'api');

    writeFileSync(join(project, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    mkdirSync(subdir, { recursive: true });

    assert.equal(isSameProject(subdir, project), true);
  });
});
