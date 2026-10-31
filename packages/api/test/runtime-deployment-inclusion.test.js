import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  resolveRuntimeDeploymentCandidate,
  resolveRuntimeDeploymentInclusionProof,
} from '../dist/config/runtime-deployment-inclusion.js';

const roots = [];

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'f323-inclusion-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'F323 Test');
  git(root, 'config', 'user.email', 'f323@example.test');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'first');
  const first = git(root, 'rev-parse', 'HEAD');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'second');
  const second = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', first);
  git(root, 'commit', '-q', '--allow-empty', '-m', 'sibling');
  const sibling = git(root, 'rev-parse', 'HEAD');
  return { root, first, second, sibling };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('F323 running-build inclusion proof', () => {
  it('reads a bounded local origin/main candidate with an observation time instead of fetching', async () => {
    const { root, second } = repo();
    git(root, 'update-ref', 'refs/remotes/origin/main', second);
    assert.deepEqual(await resolveRuntimeDeploymentCandidate(root, 1_234), {
      revision: second,
      observedAt: 1_234,
    });
    const nested = join(root, 'nested');
    mkdirSync(nested);
    assert.equal(await resolveRuntimeDeploymentCandidate(nested, 1_234), null, 'the runtime root must be exact');
  });

  it('proves ancestry of the captured running build, even when the checkout HEAD has since moved', async () => {
    const { root, first, second } = repo();
    assert.deepEqual(
      await resolveRuntimeDeploymentInclusionProof({
        runtimeRoot: root,
        targetRevision: first,
        runningRevision: second,
      }),
      { kind: 'git_ancestry', targetRevision: first, runningRevision: second, included: true },
    );
  });

  it('returns a definite false only when a complete local repository proves non-ancestry', async () => {
    const { root, second, sibling } = repo();
    assert.deepEqual(
      await resolveRuntimeDeploymentInclusionProof({
        runtimeRoot: root,
        targetRevision: sibling,
        runningRevision: second,
      }),
      { kind: 'git_ancestry', targetRevision: sibling, runningRevision: second, included: false },
    );
  });

  it('returns unknown for missing objects, malformed revisions, and Git-less installation roots', async () => {
    const { root, first, second } = repo();
    assert.equal(
      await resolveRuntimeDeploymentInclusionProof({
        runtimeRoot: root,
        targetRevision: 'a'.repeat(40),
        runningRevision: second,
      }),
      null,
    );
    assert.equal(
      await resolveRuntimeDeploymentInclusionProof({
        runtimeRoot: root,
        targetRevision: 'main',
        runningRevision: second,
      }),
      null,
    );
    const gitless = mkdtempSync(join(tmpdir(), 'f323-gitless-'));
    roots.push(gitless);
    assert.equal(
      await resolveRuntimeDeploymentInclusionProof({
        runtimeRoot: gitless,
        targetRevision: first,
        runningRevision: second,
      }),
      null,
    );
  });
});
