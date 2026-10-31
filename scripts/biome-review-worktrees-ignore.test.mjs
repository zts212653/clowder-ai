import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const tempDirs = [];
const repoRoot = process.cwd();
const biomeBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'biome.cmd' : 'biome');

function makeFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'biome-review-worktrees-'));
  tempDirs.push(dir);

  copyFileSync(path.join(repoRoot, 'biome.json'), path.join(dir, 'biome.json'));
  writeFileSync(path.join(dir, '.gitignore'), '', 'utf8');
  writeFileSync(path.join(dir, 'index.js'), 'const ok = true;\n', 'utf8');

  const reviewWorktree = path.join(dir, '.review-worktrees', 'pr-123');
  mkdirSync(reviewWorktree, { recursive: true });
  writeFileSync(
    path.join(reviewWorktree, 'biome.json'),
    JSON.stringify({ $schema: 'https://biomejs.dev/schemas/2.4.1/schema.json' }, null, 2),
    'utf8',
  );
  writeFileSync(path.join(reviewWorktree, 'fixture.js'), 'const nested = true;\n', 'utf8');

  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('Biome review worktree ignore guard', () => {
  it('does not inspect nested biome configs under .review-worktrees', () => {
    const fixture = makeFixture();
    const result = spawnSync(biomeBin, ['check', '.', '--diagnostic-level=error', '--colors=off'], {
      cwd: fixture,
      encoding: 'utf8',
      env: process.env,
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.doesNotMatch(output, /nested root configuration/i);
    assert.doesNotMatch(output, /\.review-worktrees/);
  });
});
