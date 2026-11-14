// @ts-check

/**
 * Regression: runVerdictPublishContract must resolve the transport script from
 * `implementationRoot` (the full repo), not `repoRoot` (which may be a sparse-
 * checkout worktree that lacks scripts/).
 *
 * Bug: Nov-7 eval:a2a sparse-checkout optimization made worktrees that only
 * materialized docs/harness-feedback/ and generated/. The default contract
 * runner resolved the transport script from repoRoot → MODULE_NOT_FOUND.
 * The evidence script already resolved from implementationRoot (line 66 in
 * verdict-publish-contract-runner.ts); the transport script must match.
 *
 * PR #6770, finding by @kimi31-pro.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const roots = [];

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('runVerdictPublishContract script resolution', () => {
  it('resolves transport script from implementationRoot when repoRoot lacks scripts/', async () => {
    // implementationRoot: full repo — has the script
    const implementationRoot = mkdtempSync(join(tmpdir(), 'contract-impl-'));
    roots.push(implementationRoot);
    mkdirSync(join(implementationRoot, 'scripts'), { recursive: true });
    // Minimal fixture: identity-only exits 0; non-identity also exits 0
    // (the real script does git remote checks, but we only test resolution)
    writeFileSync(
      join(implementationRoot, 'scripts/check-verdict-publish-contract.mjs'),
      [
        'import { parseArgs } from "node:util";',
        'parseArgs({',
        '  options: {',
        '    "repo-root": { type: "string" },',
        '    "expected-repo": { type: "string" },',
        '    "remote": { type: "string" },',
        '    "base-ref": { type: "string" },',
        '    "source-ref": { type: "string" },',
        '    "identity-only": { type: "string" },',
        '  },',
        '});',
        'process.exit(0);',
      ].join('\n'),
    );

    // repoRoot: simulates a sparse-checkout worktree — NO scripts/ directory
    const repoRoot = mkdtempSync(join(tmpdir(), 'contract-sparse-'));
    roots.push(repoRoot);
    git(repoRoot, ['init', '-b', 'main']);
    git(repoRoot, ['config', 'user.email', 'test@example.com']);
    git(repoRoot, ['config', 'user.name', 'Test']);
    writeFileSync(join(repoRoot, 'seed.txt'), 'x');
    git(repoRoot, ['add', '-A']);
    git(repoRoot, ['commit', '-m', 'seed']);
    // scripts/ is deliberately absent — this is the sparse-checkout scenario

    const { runVerdictPublishContract } = await import(
      `../../dist/infrastructure/harness-eval/publish-verdict/publication/verdict-publish-contract-runner.js?t=${Date.now()}`
    );

    // Before fix: rejects with MODULE_NOT_FOUND (script resolved from repoRoot)
    // After fix: resolves from implementationRoot — script found and runs
    await runVerdictPublishContract({
      repoRoot,
      implementationRoot,
      expectedRepoFullName: 'test/repo',
      remoteName: 'origin',
      baseRef: 'HEAD',
      sourceRef: 'HEAD',
      identityOnly: true,
    });
  });

  it('rejects with MODULE_NOT_FOUND when both roots lack scripts/', async () => {
    // Both roots lack scripts/ — verifies the error we prevented
    const implementationRoot = mkdtempSync(join(tmpdir(), 'contract-no-scripts-'));
    roots.push(implementationRoot);

    const repoRoot = mkdtempSync(join(tmpdir(), 'contract-sparse-'));
    roots.push(repoRoot);
    git(repoRoot, ['init', '-b', 'main']);
    git(repoRoot, ['config', 'user.email', 'test@example.com']);
    git(repoRoot, ['config', 'user.name', 'Test']);
    writeFileSync(join(repoRoot, 'seed.txt'), 'x');
    git(repoRoot, ['add', '-A']);
    git(repoRoot, ['commit', '-m', 'seed']);

    const { runVerdictPublishContract } = await import(
      `../../dist/infrastructure/harness-eval/publish-verdict/publication/verdict-publish-contract-runner.js?t=${Date.now()}`
    );

    await assert.rejects(
      runVerdictPublishContract({
        repoRoot,
        implementationRoot,
        expectedRepoFullName: 'test/repo',
        remoteName: 'origin',
        baseRef: 'HEAD',
        sourceRef: 'HEAD',
        identityOnly: true,
      }),
      (/** @type {Error & { cause?: { code?: string } }} */ err) => {
        assert.ok(err.message.includes('MODULE_NOT_FOUND') || err.cause?.code === 'MODULE_NOT_FOUND');
        return true;
      },
    );
  });
});
