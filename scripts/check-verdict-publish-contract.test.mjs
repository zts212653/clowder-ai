// @ts-check

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

/**
 * Regression tests for the REAL check-verdict-publish-contract.mjs script.
 *
 * Previous test (git-worktree-publisher-target-contract.test.js) only exercised
 * a fixture-created dummy; these tests run the actual production script to
 * prevent the "script referenced but not committed" class of sync failures.
 */

const SCRIPT = resolve(import.meta.dirname, 'check-verdict-publish-contract.mjs');
const roots = [];

function git(root, args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options }).trim();
}

function createRepoWithGitHubRemote(ownerRepo = 'zts212653/clowder-ai') {
  const repoRoot = mkdtempSync(join(tmpdir(), 'contract-test-repo-'));
  const remoteRoot = mkdtempSync(join(tmpdir(), 'contract-test-remote-'));
  roots.push(repoRoot, remoteRoot);

  // Init bare remote
  execFileSync('git', ['init', '--bare', remoteRoot], { stdio: 'ignore' });

  // Init local repo with origin pointing to a GitHub-like URL
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Contract Test']);

  // Seed with census file
  mkdirSync(join(repoRoot, 'docs/harness-feedback/registry'), { recursive: true });
  writeFileSync(join(repoRoot, 'docs/harness-feedback/registry/measurement-bundles.yaml'), '# census\ninstances: []\n');
  writeFileSync(join(repoRoot, 'README.md'), '# test\n');

  git(repoRoot, ['add', '-A']);
  git(repoRoot, ['commit', '-m', 'seed']);

  // Set up remote pointing to a GitHub-like URL
  git(repoRoot, ['remote', 'add', 'origin', `https://github.com/${ownerRepo}.git`]);
  git(repoRoot, ['config', 'remote.origin.url', `https://github.com/${ownerRepo}.git`]);

  // For actual git operations: add a backup remote
  git(repoRoot, ['remote', 'add', 'bare', remoteRoot]);
  git(repoRoot, ['push', 'bare', 'main']);

  return { repoRoot, remoteRoot, ownerRepo };
}

function runContract(repoRoot, expectedRepo, opts = {}) {
  const args = [SCRIPT, '--repo-root', repoRoot, '--expected-repo', expectedRepo, '--remote', opts.remote ?? 'origin'];
  if (opts.baseRef) args.push('--base-ref', opts.baseRef);
  if (opts.freshBaseBranch) args.push('--fresh-base-branch', opts.freshBaseBranch);
  if (opts.sourceRef) args.push('--source-ref', opts.sourceRef);
  if (opts.identityOnly) args.push('--identity-only', 'true');
  return execFileSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
    ...opts.execOpts,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('check-verdict-publish-contract.mjs', () => {
  describe('identity check (fetch URL)', () => {
    it('passes when remote owner/repo matches expected (HTTPS)', () => {
      const { repoRoot, ownerRepo } = createRepoWithGitHubRemote('zts212653/clowder-ai');
      assert.doesNotThrow(() => runContract(repoRoot, ownerRepo, { identityOnly: true }));
    });

    it('fails when remote owner/repo does not match expected', () => {
      const { repoRoot } = createRepoWithGitHubRemote('zts212653/clowder-ai');
      assert.throws(() => runContract(repoRoot, 'zts212653/cat-cafe', { identityOnly: true }), /IDENTITY_MISMATCH/);
    });

    it('handles SSH-style remote URLs', () => {
      const { repoRoot } = createRepoWithGitHubRemote();
      git(repoRoot, ['remote', 'set-url', 'origin', 'git@github.com:zts212653/clowder-ai.git']);
      assert.doesNotThrow(() => runContract(repoRoot, 'zts212653/clowder-ai', { identityOnly: true }));
    });

    it('fails when remote does not exist', () => {
      const { repoRoot } = createRepoWithGitHubRemote();
      assert.throws(
        () => runContract(repoRoot, 'zts212653/clowder-ai', { identityOnly: true, remote: 'nonexistent' }),
        /IDENTITY_FAILED/,
      );
    });
  });

  describe('identity check (push URL)', () => {
    it('fails when pushurl points to a different repo', () => {
      const { repoRoot } = createRepoWithGitHubRemote('zts212653/clowder-ai');
      git(repoRoot, ['config', 'remote.origin.pushurl', 'https://github.com/evil/exfiltrate.git']);
      assert.throws(() => runContract(repoRoot, 'zts212653/clowder-ai', { identityOnly: true }), /IDENTITY_MISMATCH/);
    });

    it('passes when pushurl matches expected repo', () => {
      const { repoRoot } = createRepoWithGitHubRemote('zts212653/clowder-ai');
      git(repoRoot, ['config', 'remote.origin.pushurl', 'git@github.com:zts212653/clowder-ai.git']);
      assert.doesNotThrow(() => runContract(repoRoot, 'zts212653/clowder-ai', { identityOnly: true }));
    });
  });

  describe('host anchoring (anti-spoofing)', () => {
    it('rejects URL with github.com as substring of different host', () => {
      const { repoRoot } = createRepoWithGitHubRemote();
      git(repoRoot, ['remote', 'set-url', 'origin', 'https://not-github.com/zts212653/clowder-ai.git']);
      assert.throws(() => runContract(repoRoot, 'zts212653/clowder-ai', { identityOnly: true }), /IDENTITY_FAILED/);
    });

    it('rejects URL with github.com.evil.com host', () => {
      const { repoRoot } = createRepoWithGitHubRemote();
      git(repoRoot, ['remote', 'set-url', 'origin', 'https://github.com.evil.com/zts212653/clowder-ai.git']);
      assert.throws(() => runContract(repoRoot, 'zts212653/clowder-ai', { identityOnly: true }), /IDENTITY_FAILED/);
    });
  });

  describe('full contract (census)', () => {
    it('passes when identity matches and census exists at source ref', () => {
      const { repoRoot, ownerRepo } = createRepoWithGitHubRemote();
      assert.doesNotThrow(() => runContract(repoRoot, ownerRepo, { sourceRef: 'HEAD', baseRef: 'HEAD' }));
    });

    it('fails when census file is missing at source ref', () => {
      const { repoRoot, ownerRepo } = createRepoWithGitHubRemote();
      git(repoRoot, ['rm', 'docs/harness-feedback/registry/measurement-bundles.yaml']);
      git(repoRoot, ['commit', '-m', 'remove census']);
      assert.throws(() => runContract(repoRoot, ownerRepo, { sourceRef: 'HEAD', baseRef: 'HEAD' }), /CENSUS_MISSING/);
    });

    it('requires --source-ref for full checks', () => {
      const { repoRoot, ownerRepo } = createRepoWithGitHubRemote();
      assert.throws(() => runContract(repoRoot, ownerRepo, { identityOnly: false }), /--source-ref is required/);
    });

    it('accepts --fresh-base-branch as alias for --base-ref (guarded-bin/gh compat)', () => {
      const { repoRoot, ownerRepo } = createRepoWithGitHubRemote();
      assert.doesNotThrow(() => runContract(repoRoot, ownerRepo, { sourceRef: 'HEAD', freshBaseBranch: 'main' }));
    });
  });

  describe('repo name extraction', () => {
    it('handles HTTPS URLs without .git suffix', () => {
      const { repoRoot } = createRepoWithGitHubRemote();
      git(repoRoot, ['remote', 'set-url', 'origin', 'https://github.com/org/repo-name']);
      assert.doesNotThrow(() => runContract(repoRoot, 'org/repo-name', { identityOnly: true }));
    });

    it('handles HTTPS URLs with .git suffix', () => {
      const { repoRoot } = createRepoWithGitHubRemote();
      git(repoRoot, ['remote', 'set-url', 'origin', 'https://github.com/org/repo-name.git']);
      assert.doesNotThrow(() => runContract(repoRoot, 'org/repo-name', { identityOnly: true }));
    });

    it('handles SSH shorthand URLs', () => {
      const { repoRoot } = createRepoWithGitHubRemote();
      git(repoRoot, ['remote', 'set-url', 'origin', 'git@github.com:org/my-repo.git']);
      assert.doesNotThrow(() => runContract(repoRoot, 'org/my-repo', { identityOnly: true }));
    });
  });
});
