// @ts-check
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createVignetteWriter } from '../dist/domains/taste/services/writeVignette.js';

const TRACKED_POST_CHECKOUT_HOOK = fileURLToPath(new URL('../../../.githooks/post-checkout', import.meta.url));

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function configureIdentity(cwd) {
  git(cwd, ['config', 'user.email', 'test@cat-cafe.local']);
  git(cwd, ['config', 'user.name', 'Taste Hook Test']);
}

test('tracked post-checkout blocks primary branching but permits disposable Taste publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f221-publication-hook-'));
  const origin = join(root, 'origin.git');
  const primary = join(root, 'primary');
  const runtime = join(root, 'runtime');
  const hookLog = join(root, 'pre-push.log');

  try {
    git(root, ['init', '--bare', '--initial-branch=main', origin]);
    git(root, ['clone', origin, primary]);
    configureIdentity(primary);
    mkdirSync(join(primary, 'docs/taste'), { recursive: true });
    writeFileSync(join(primary, 'README.md'), 'fixture\n');
    writeFileSync(join(primary, 'docs/taste/index.md'), '# Taste Index\n\n### 创作手法\n');
    git(primary, ['add', 'README.md', 'docs/taste/index.md']);
    git(primary, ['commit', '-m', 'seed taste repository']);
    git(primary, ['push', '-u', 'origin', 'main']);

    const hooksDir = join(primary, '.githooks');
    mkdirSync(hooksDir);
    writeFileSync(join(hooksDir, 'pre-push'), `#!/bin/sh\nprintf 'called\\n' >> '${hookLog}'\n`);
    chmodSync(join(hooksDir, 'pre-push'), 0o755);
    writeFileSync(join(hooksDir, 'post-checkout'), readFileSync(TRACKED_POST_CHECKOUT_HOOK, 'utf8'));
    chmodSync(join(hooksDir, 'post-checkout'), 0o755);
    git(primary, ['config', 'core.hooksPath', hooksDir]);
    git(primary, ['worktree', 'add', '-b', 'runtime/main-sync', runtime]);

    assert.throws(
      () => git(primary, ['checkout', '-b', 'forbidden-primary-branch']),
      /primary worktree branch checkout rejected/,
    );
    assert.equal(git(primary, ['branch', '--show-current']), 'main');

    const result = await createVignetteWriter(runtime)({
      id: 'proposal_tracked_hook_abc555',
      userId: 'user-1',
      catId: 'codex-sol',
      threadId: 'thread-1',
      scene: 'operator approved a reusable editing judgment',
      quote: '节奏要服务叙事，不要只是堆转场',
      tags: ['真实 hook'],
      dimension: 'creative-craft',
      privacy: 'public',
      status: 'approving',
      createdAt: 1787620000000,
    });

    assert.match(
      git(root, ['--git-dir', origin, 'show', `main:${result.path}`]),
      /proposalId: proposal_tracked_hook_abc555/,
    );
    assert.equal(readFileSync(hookLog, 'utf8'), 'called\n');
    assert.equal(git(primary, ['branch', '--show-current']), 'main');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
