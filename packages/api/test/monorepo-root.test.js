import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';

const { _clearCachesForTest, findMonorepoRoot, findMonorepoRootOrNull, isSameProject } = await import(
  '../dist/utils/monorepo-root.js'
);

describe('findMonorepoRoot', () => {
  afterEach(() => {
    _clearCachesForTest();
  });

  it('checks the filesystem root itself for the workspace marker (F314-5, as the readers it replaced did)', () => {
    const fsRoot = parse(tmpdir()).root;
    const marker = join(fsRoot, 'pnpm-workspace.yaml');
    mock.method(fs, 'existsSync', (path) => path === marker);
    syncBuiltinESMExports();
    try {
      assert.equal(findMonorepoRootOrNull(join(tmpdir(), 'f314-no-workspace', 'deep')), fsRoot);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
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

describe('findMonorepoRootOrNull (F314-5: one workspace-marker walk for every root lookup)', () => {
  afterEach(() => _clearCachesForTest());

  it('finds the marker from any descendant, and reports null rather than a fallback when there is none', () => {
    const project = mkdtempSync(join(tmpdir(), 'root-or-null-project-'));
    const nested = join(project, 'packages', 'api', 'dist', 'routes');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(project, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    const outside = mkdtempSync(join(tmpdir(), 'root-or-null-outside-'));

    assert.equal(findMonorepoRootOrNull(nested), project);
    assert.equal(findMonorepoRoot(nested), project);
    assert.equal(findMonorepoRootOrNull(outside), null);
    assert.equal(findMonorepoRoot(outside), outside, 'findMonorepoRoot keeps falling back to the start directory');
  });
});
