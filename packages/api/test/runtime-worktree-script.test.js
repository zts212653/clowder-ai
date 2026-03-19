import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeScriptSource = join(__dirname, '..', '..', '..', 'scripts', 'runtime-worktree.sh');
const tempDirs = [];

function createTempProject(name) {
  const projectDir = mkdtempSync(join(tmpdir(), `${name}-`));
  tempDirs.push(projectDir);
  mkdirSync(join(projectDir, 'scripts'), { recursive: true });
  writeFileSync(join(projectDir, 'scripts', 'runtime-worktree.sh'), readFileSync(runtimeScriptSource, 'utf8'), {
    mode: 0o755,
  });
  writeFileSync(join(projectDir, 'scripts', 'start-dev.sh'), '#!/bin/sh\nprintf "STARTED:%s\\n" "$PWD"\n', {
    mode: 0o755,
  });
  return projectDir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('runtime-worktree.sh', () => {
  it('keeps the runtime-worktree entrypoint executable in the repository', () => {
    const mode = statSync(runtimeScriptSource).mode & 0o111;
    assert.notEqual(mode, 0, 'runtime-worktree.sh should retain an executable bit');
  });

  it('starts in-place when project is not a git repository', () => {
    const projectDir = createTempProject('runtime-non-git');

    const result = spawnSync('bash', [join(projectDir, 'scripts', 'runtime-worktree.sh'), 'start', '--no-sync'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_RUNTIME_RESTART_OK: '1' },
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /running in-place \(deployment mode\)/);
    assert.match(result.stdout, new RegExp(`STARTED:${projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('fails fast when project is a git repo but the configured remote is missing', () => {
    const projectDir = createTempProject('runtime-missing-remote');
    execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir, stdio: 'ignore' });

    const result = spawnSync('bash', [join(projectDir, 'scripts', 'runtime-worktree.sh'), 'start', '--no-sync'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_RUNTIME_RESTART_OK: '1' },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /remote 'origin' not found/);
    assert.doesNotMatch(result.stdout, /running in-place \(deployment mode\)/);
  });

  it('starts in-place when .git is a dangling pointer file', () => {
    const projectDir = createTempProject('runtime-dangling-git');
    writeFileSync(join(projectDir, '.git'), 'gitdir: /tmp/does-not-exist-anymore\n', 'utf8');

    const result = spawnSync('bash', [join(projectDir, 'scripts', 'runtime-worktree.sh'), 'start', '--no-sync'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_RUNTIME_RESTART_OK: '1' },
    });

    assert.equal(result.status, 0, `exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /running in-place \(deployment mode\)/);
    assert.match(result.stdout, new RegExp(`STARTED:${projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
});
