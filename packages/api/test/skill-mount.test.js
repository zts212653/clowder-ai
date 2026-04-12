import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const API_DIR = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(API_DIR, '../..');

describe('resolveMainRepoPath', () => {
  it('falls back to the repository root when git is unavailable', () => {
    const script = `
const mod = await import('./dist/utils/skill-mount.js');
console.log(await mod.resolveMainRepoPath());
`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: API_DIR,
      env: { ...process.env, PATH: '/nonexistent' },
      encoding: 'utf8',
      timeout: 5_000,
    });

    assert.equal(
      result.status,
      0,
      `child should resolve fallback path cleanly; stdout=${result.stdout} stderr=${result.stderr}`,
    );
    assert.equal(result.stdout.trim(), REPO_ROOT);
  });
});
