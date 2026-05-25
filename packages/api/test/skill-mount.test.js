import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { isSkillMountedAtPoint } from '../dist/utils/skill-mount.js';

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

  it('ignores nested package git repositories when resolving the runtime repo root', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'skill-mount-nested-git-'));
    const nestedApi = join(tempRoot, 'packages', 'api');
    mkdirSync(nestedApi, { recursive: true });
    const gitInit = spawnSync('git', ['init'], {
      cwd: nestedApi,
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.equal(gitInit.status, 0, `git init failed; stdout=${gitInit.stdout} stderr=${gitInit.stderr}`);

    const moduleUrl = pathToFileURL(resolve(API_DIR, 'dist/utils/skill-mount.js')).href;
    const script = `
const mod = await import(${JSON.stringify(moduleUrl)});
console.log(await mod.resolveMainRepoPath());
`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: nestedApi,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 5_000,
    });

    try {
      assert.equal(
        result.status,
        0,
        `child should resolve root cleanly; stdout=${result.stdout} stderr=${result.stderr}`,
      );
      assert.equal(result.stdout.trim(), REPO_ROOT);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('isSkillMountedAtPoint', () => {
  it('rejects directory-level symlinks to a foreign cat-cafe-skills checkout', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'skill-mount-foreign-root-'));
    const repoA = join(tempRoot, 'repo-a', 'cat-cafe-skills');
    const repoB = join(tempRoot, 'repo-b', 'cat-cafe-skills');
    const providerRoot = join(tempRoot, 'project', '.codex');
    const providerSkills = join(providerRoot, 'skills');

    try {
      for (const root of [repoA, repoB]) {
        mkdirSync(join(root, 'debugging'), { recursive: true });
        writeFileSync(join(root, 'manifest.yaml'), 'skills: {}\n');
        writeFileSync(join(root, 'debugging', 'SKILL.md'), '---\nname: debugging\n---\n');
      }
      mkdirSync(providerRoot, { recursive: true });
      symlinkSync(repoB, providerSkills);

      const mounted = await isSkillMountedAtPoint([providerSkills], repoA, 'debugging', repoA);
      assert.equal(mounted, false, 'foreign cat-cafe-skills symlink must not satisfy repo-a mount health');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
