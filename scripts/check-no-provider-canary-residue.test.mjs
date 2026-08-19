#!/usr/bin/env node
/**
 * F212 Phase H post-close hotfix — Ver B independent canary residue guard tests.
 * Split from `check-no-codex-provider-exit-suppression-isolation.test.mjs` per
 * Sol R2 P1-2 (AGENTS.md 350-line hard cap).
 *
 * Covers:
 *   • Ver B guard baseline: clean fixture → exit 0
 *   • Ver B guard baseline: seeded canary → exit 1 with file named
 *   • Sol R1 P1-C #1: missing providers root → fail-CLOSED
 *   • Sol R1 P1-C #2: nested canary → recursive scan catches it
 *   • Sol R1 P1-C #3: unknown carrier prefix → carrier-agnostic invariant
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { makeIsolatedFixture, REAL_REPO_ROOT } from './check-no-codex-provider-exit-suppression/test-scaffold.mjs';

const PROVIDERS_DIR = 'packages/api/src/domains/cats/services/agents/providers';
const GUARD_SCRIPT = join(REAL_REPO_ROOT, 'scripts', 'check-no-provider-canary-residue.mjs');

/** Run Ver B guard against an injected root; return `{ exitCode, stderr }`. */
function runVerBGuard(repoRoot) {
  let exitCode = 0;
  let stderr = '';
  try {
    execFileSync('node', [GUARD_SCRIPT, '--repo-root', repoRoot], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    exitCode = err.status ?? -1;
    stderr = err.stderr?.toString() ?? '';
  }
  return { exitCode, stderr };
}

describe('check-no-provider-canary-residue: Ver B independent guard', () => {
  it('exits 0 when providers/ has no canary residue (isolated fixture)', () => {
    assert.ok(existsSync(GUARD_SCRIPT), `Ver B guard script must exist at ${GUARD_SCRIPT}`);
    const fx = makeIsolatedFixture();
    try {
      const { exitCode } = runVerBGuard(fx.repoRoot);
      assert.equal(exitCode, 0, 'clean fixture must exit 0');
    } finally {
      fx.cleanup();
    }
  });

  it('exits 1 when a canary residue is present in providers/ (isolated fixture)', () => {
    const fx = makeIsolatedFixture();
    try {
      writeFileSync(
        join(fx.repoRoot, PROVIDERS_DIR, 'canary-verb-residue-test.ts'),
        '// Ver B residue test — must be caught.\n',
      );
      const { exitCode, stderr } = runVerBGuard(fx.repoRoot);
      assert.equal(exitCode, 1, 'Ver B guard must exit 1 when residue is present');
      assert.ok(
        stderr.includes('canary-verb-residue-test.ts'),
        `Ver B stderr must name the offending file; got: ${stderr.slice(0, 300)}`,
      );
    } finally {
      fx.cleanup();
    }
  });

  // Sol R1 P1-C hardening — Ver B fail-CLOSED + recursive + carrier-agnostic.

  it('Sol R1 P1-C #1: missing providers root → Ver B fails CLOSED', () => {
    const nonProvidersRoot = mkdtempSync(join(tmpdir(), 'verb-no-providers-'));
    try {
      const { exitCode, stderr } = runVerBGuard(nonProvidersRoot);
      assert.equal(exitCode, 1, 'Ver B MUST fail-CLOSED when providers root is missing (R9-class contract)');
      assert.ok(
        stderr.includes('providers root missing') || stderr.includes('fail-CLOSED'),
        `Ver B stderr must mention fail-CLOSED / missing target; got: ${stderr.slice(0, 300)}`,
      );
    } finally {
      rmSync(nonProvidersRoot, { recursive: true, force: true });
    }
  });

  it('Sol R1 P1-C #2: canary in a NESTED subdir of providers/ → Ver B fires (recursive scan)', () => {
    const fx = makeIsolatedFixture();
    try {
      mkdirSync(join(fx.repoRoot, PROVIDERS_DIR, 'nested'), { recursive: true });
      writeFileSync(
        join(fx.repoRoot, PROVIDERS_DIR, 'nested', 'Codex-canary-leak.ts'),
        '// nested residue must be caught\n',
      );
      const { exitCode, stderr } = runVerBGuard(fx.repoRoot);
      assert.equal(exitCode, 1, 'Ver B must catch canary in providers/nested/');
      assert.ok(
        stderr.includes('nested') && stderr.includes('Codex-canary-leak.ts'),
        `Ver B stderr must show nested path; got: ${stderr.slice(0, 300)}`,
      );
    } finally {
      fx.cleanup();
    }
  });

  it('Sol R1 P1-C #3: canary with UNKNOWN carrier prefix (Qwen) → Ver B fires (carrier-agnostic invariant)', () => {
    const fx = makeIsolatedFixture();
    try {
      writeFileSync(
        join(fx.repoRoot, PROVIDERS_DIR, 'Qwen-canary-leak.ts'),
        '// carrier not in Codex/Gemini/OpenCode enumerated set — but /canary/i still fires\n',
      );
      const { exitCode, stderr } = runVerBGuard(fx.repoRoot);
      assert.equal(exitCode, 1, 'Ver B must be carrier-agnostic (Sol R1 P1-C /canary/i invariant)');
      assert.ok(
        stderr.includes('Qwen-canary-leak.ts'),
        `Ver B stderr must show the Qwen carrier canary; got: ${stderr.slice(0, 300)}`,
      );
    } finally {
      fx.cleanup();
    }
  });
});
