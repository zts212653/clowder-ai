/**
 * Shared fixtures for F221 taste publication tests.
 *
 * Extracted to keep test files under the 350-line hard cap while sharing
 * the process-group-aware Git runner across publication + hook suites.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anchorApproval } from './approval-hub/helpers.js';

/**
 * Process-group-aware fixture Git runner.
 *
 * Spawns git as its own process group leader (`detached: true`) so that on
 * timeout (or normal completion) we can `kill(-pid, SIGKILL)` the entire
 * group — including orphan hook children that Node's built-in timeout
 * cannot reach (it only kills the direct child).
 *
 * 30 s per operation prevents unbounded stalls under concurrent gate I/O.
 */
export function git(cwd, args, { timeout: timeoutMs = 30_000 } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Always attempt to reap the entire process group — ESRCH (already dead) is fine.
  if (result.pid) {
    try {
      process.kill(-result.pid, 'SIGKILL');
    } catch {}
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw Object.assign(new Error(`git ${args[0] ?? ''} exited ${result.status}: ${result.stderr}`), {
      status: result.status,
      stderr: result.stderr,
    });
  }
  return result.stdout.trim();
}

export function configureIdentity(cwd) {
  git(cwd, ['config', 'user.email', 'test@cat-cafe.local']);
  git(cwd, ['config', 'user.name', 'Taste Publication Test']);
}

export function makeProposal(overrides = {}) {
  return {
    id: 'proposal_publication_abc123',
    userId: 'user-1',
    catId: 'codex-sol',
    threadId: 'thread-1',
    scene: 'operator approved a reusable editing judgment',
    quote: '节奏要服务叙事，不要只是堆转场',
    tags: ['视频剪辑', '叙事节奏'],
    dimension: 'creative-craft',
    privacy: 'public',
    status: 'approving',
    createdAt: 1787620000000,
    ...overrides,
  };
}

export function createRemoteFixture() {
  const root = mkdtempSync(join(tmpdir(), 'f221-publication-'));
  const origin = join(root, 'origin.git');
  const primary = join(root, 'primary');
  const runtime = join(root, 'runtime');
  const hookLog = join(root, 'pre-push.log');
  git(root, ['init', '--bare', '--initial-branch=main', origin]);
  git(root, ['clone', origin, primary]);
  configureIdentity(primary);
  mkdirSync(join(primary, 'docs/taste'), { recursive: true });
  writeFileSync(join(primary, 'README.md'), 'fixture\n');
  writeFileSync(join(primary, 'docs/taste/index.md'), '# Taste Index\n\n### 创作手法\n', 'utf8');
  git(primary, ['add', 'README.md', 'docs/taste/index.md']);
  git(primary, ['commit', '-m', 'seed taste repository']);
  git(primary, ['push', '-u', 'origin', 'main']);
  const hooksDir = join(primary, '.githooks');
  mkdirSync(hooksDir);
  writeFileSync(join(hooksDir, 'pre-push'), `#!/bin/sh\nprintf 'called\\n' >> '${hookLog}'\n`);
  chmodSync(join(hooksDir, 'pre-push'), 0o755);
  git(primary, ['config', 'core.hooksPath', hooksDir]);
  git(primary, ['worktree', 'add', '-b', 'runtime/main-sync', runtime]);
  return { root, origin, primary, runtime, hookLog };
}

export function advanceRemote(fixture, filename = 'remote-only.md') {
  const remoteWriter = join(fixture.root, `remote-writer-${Date.now()}-${Math.random()}`);
  git(fixture.root, ['clone', fixture.origin, remoteWriter]);
  configureIdentity(remoteWriter);
  writeFileSync(join(remoteWriter, filename), `${filename}\n`);
  git(remoteWriter, ['add', filename]);
  git(remoteWriter, ['commit', '-m', `advance remote with ${filename}`]);
  git(remoteWriter, ['push', 'origin', 'main']);
  return git(remoteWriter, ['rev-parse', 'HEAD']);
}

export function divergeAndStagePrimary(fixture) {
  writeFileSync(join(fixture.primary, 'local-only.md'), 'local ahead commit\n');
  git(fixture.primary, ['add', 'local-only.md']);
  git(fixture.primary, ['commit', '-m', 'local operator commit']);
  advanceRemote(fixture);
  writeFileSync(join(fixture.primary, 'concurrent-wip.md'), 'staged human work\n');
  git(fixture.primary, ['add', 'concurrent-wip.md']);
}

export function remoteFile(fixture, path) {
  return git(fixture.root, ['--git-dir', fixture.origin, 'show', `main:${path}`]);
}

export function remoteHead(fixture) {
  return git(fixture.root, ['--git-dir', fixture.origin, 'rev-parse', 'main']);
}

export async function createStoredProposal(store) {
  const proposal = store.create({
    userId: 'user-1',
    catId: 'codex-sol',
    threadId: 'thread-1',
    scene: 'operator approved a reusable editing judgment',
    quote: '节奏要服务叙事，不要只是堆转场',
    tags: ['视频剪辑'],
    dimension: 'creative-craft',
    privacy: 'public',
  });
  await anchorApproval(store, {
    proposalId: proposal.id,
    sourceFeatureId: 'F221',
    ownerUserId: proposal.userId,
    requesterCatId: proposal.catId,
    threadId: proposal.threadId,
    createdAt: proposal.createdAt,
  });
  return proposal;
}
