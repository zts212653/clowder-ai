#!/usr/bin/env node
/**
 * F212 Phase H R1 P1-3 canary regressions (literal-symbol guard).
 * Split from parent per Sol R8 P1-B (AGENTS.md 350-line hard cap).
 *
 * Cloud codex R1 P1 (2026-07-13) hotfix migration:
 *   The original tests used `withCanary(REPO_ROOT/.../providers/canary-*.ts, ...)`
 *   which wrote canary files to the SHARED production providers directory. When
 *   the sync `finally` cleanup was skipped by SIGKILL/SIGINT/OOM the file
 *   leaked. Because `check-no-provider-canary-residue` runs earlier in the
 *   `pnpm check` chain, same-run residue is NOT caught either. Full migration
 *   to `makeIsolatedFixture()` + `--repo-root` here so nothing ever writes to
 *   the real worktree's providers directory during test execution.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { makeIsolatedFixture, runGuard } from './check-no-codex-provider-exit-suppression/test-scaffold.mjs';

const PROVIDERS_DIR = 'packages/api/src/domains/cats/services/agents/providers';

describe('check-no-codex-provider-exit-suppression: literal-symbol canaries', () => {
  it('clean tree → guard exits 0', () => {
    const fx = makeIsolatedFixture();
    try {
      const { exitCode } = runGuard({ repoRoot: fx.repoRoot });
      assert.equal(exitCode, 0, 'guard must be clean on a fresh fixture (Phase H architecture preserved)');
    } finally {
      fx.cleanup();
    }
  });

  it('canary: sawSubstantiveOutput in a provider-adjacent file → guard exits 1', () => {
    const fx = makeIsolatedFixture();
    try {
      writeFileSync(
        join(fx.repoRoot, PROVIDERS_DIR, 'canary-forbidden-saw.ts'),
        '// Phase H canary — must be rejected by hard-check.\nexport let sawSubstantiveOutput = false;\n',
      );
      const { exitCode, stderr } = runGuard({ repoRoot: fx.repoRoot });
      assert.equal(exitCode, 1, 'guard MUST fail when sawSubstantiveOutput reappears in providers/');
      assert.ok(
        stderr.includes('sawSubstantiveOutput'),
        `stderr must name the offending pattern; got: ${stderr.slice(0, 200)}`,
      );
      assert.ok(stderr.includes('canary-forbidden-saw.ts'), 'stderr must show the offending path');
    } finally {
      fx.cleanup();
    }
  });

  it('canary: hasNonSuppressibleCodexExitOneDiagnostics helper reappears → guard exits 1', () => {
    const fx = makeIsolatedFixture();
    try {
      writeFileSync(
        join(fx.repoRoot, PROVIDERS_DIR, 'canary-forbidden-helper.ts'),
        '// Phase H canary — must be rejected by hard-check.\n' +
          'export function hasNonSuppressibleCodexExitOneDiagnostics(): boolean {\n' +
          '  return false;\n' +
          '}\n',
      );
      const { exitCode, stderr } = runGuard({ repoRoot: fx.repoRoot });
      assert.equal(exitCode, 1, 'guard MUST fail when the helper name reappears in providers/');
      assert.ok(
        stderr.includes('hasNonSuppressibleCodexExitOneDiagnostics'),
        `stderr must name the offending pattern; got: ${stderr.slice(0, 200)}`,
      );
    } finally {
      fx.cleanup();
    }
  });

  it('canary: log message reappears → guard exits 1', () => {
    const fx = makeIsolatedFixture();
    try {
      writeFileSync(
        join(fx.repoRoot, PROVIDERS_DIR, 'canary-forbidden-log.ts'),
        '// Phase H canary — must be rejected by hard-check.\n' +
          'export const MSG = "suppressing as Codex 0.98+ quirk";\n',
      );
      const { exitCode, stderr } = runGuard({ repoRoot: fx.repoRoot });
      assert.equal(exitCode, 1, 'guard MUST fail when the suppress log message reappears');
      assert.ok(
        stderr.includes('suppressing as Codex 0'),
        `stderr must name the offending pattern; got: ${stderr.slice(0, 200)}`,
      );
    } finally {
      fx.cleanup();
    }
  });

  it('R1 P1-3: provider file itself is NOT allowlisted — reintroduction in real path fails', () => {
    const fx = makeIsolatedFixture();
    try {
      writeFileSync(
        join(fx.repoRoot, PROVIDERS_DIR, 'canary-in-provider-tree.ts'),
        '// Phase H R1 canary — placing forbidden identifier alongside real providers must fail.\n' +
          'let sawSubstantiveOutput = true;\n' +
          'void sawSubstantiveOutput;\n',
      );
      const { exitCode } = runGuard({ repoRoot: fx.repoRoot });
      assert.equal(exitCode, 1, 'R1 P1-3 fix contract: providers/ tree must NOT be allowlisted for forbidden tokens');
    } finally {
      fx.cleanup();
    }
  });
});
