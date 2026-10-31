#!/usr/bin/env node
/**
 * F212 Phase H (Sol runtime forensics 2026-07-09) — regression guard.
 *
 * Delete-and-guard pattern: the Codex provider used to have a `sawSubstantiveOutput`
 * boolean + `hasNonSuppressibleCodexExitOneDiagnostics` regex-allowlist helper +
 * `if (exit=1 && sawSubstantiveOutput && !diagnosticsMatch) continue` branch that
 * silently masked Codex CLI 0.98+ `exit=1` errors as "Codex 0.98+ quirk". Sol's
 * runtime forensics found 21 terminal failures across 9 threads (5 silent
 * false-success subset in 4 threads).
 *
 * This is a thin orchestrator that composes two checks (Sol R8 P1-B — split
 * to satisfy AGENTS.md 350-line hard cap):
 *   • `literal-guard.mjs` — grep-based check for the deleted token names.
 *   • `ast-ownership.mjs` — AST-based ownership invariant: no
 *     `IfStatement.condition` inside Codex provider files may mention BOTH
 *     `exitCode === 1` AND `signal === null` (regardless of body shape).
 *
 * Both checks compose here. Any violation → exit 1 with a categorized
 * failure report.
 *
 * Usage:
 *   node scripts/check-no-codex-provider-exit-suppression.mjs
 *   → exit 0 = clean, exit 1 = regression detected
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectSuppressShapeInProviders } from './check-no-codex-provider-exit-suppression/ast-ownership.mjs';
import { scanLiteralViolations } from './check-no-codex-provider-exit-suppression/literal-guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(__dirname, '..');

export {
  collectCodexProviderFiles,
  detectSuppressShapeInProviders,
  isCodexProviderFile,
} from './check-no-codex-provider-exit-suppression/ast-ownership.mjs';
// Re-export for backwards compatibility with existing tests.
export {
  FORBIDDEN_PATTERNS,
  grepPattern,
  pathFromGrepLine,
  scanLiteralViolations,
} from './check-no-codex-provider-exit-suppression/literal-guard.mjs';

/**
 * Parse the `--repo-root <path>` CLI arg (Sol Bug 2 hotfix contract:
 * injectable repoRoot so isolated fixtures never touch the real worktree).
 * Falls back to the default (real worktree) when absent.
 */
function parseRepoRoot(argv) {
  const idx = argv.indexOf('--repo-root');
  if (idx === -1) return DEFAULT_REPO_ROOT;
  const value = argv[idx + 1];
  if (!value) {
    console.error('[check-no-codex-provider-exit-suppression] --repo-root requires a path argument');
    process.exit(2);
  }
  return value;
}

function main() {
  const repoRoot = parseRepoRoot(process.argv.slice(2));
  if (!existsSync(join(repoRoot, 'packages'))) {
    console.error(`[check-no-codex-provider-exit-suppression] repo root not found: ${repoRoot}`);
    process.exit(2);
  }

  const failures = scanLiteralViolations(repoRoot);

  // Sol R7 P1 + R8 P1-A: AST-based ownership shape check (Codex provider scope).
  const shape = detectSuppressShapeInProviders(repoRoot);
  if (shape.violations.length > 0) {
    failures.push({
      pattern: 'Codex provider IfStatement.condition owns exit-1/signal-null decision (Sol R7/R8 ownership rule)',
      regex: '<AST condition ownership check>',
      violations: shape.violations.map(
        (v) =>
          `./${v.file}:${v.line}: ${v.error ?? '<exitCode === 1 && signal === null in IfStatement.condition — Codex provider must not own this decision>'}`,
      ),
    });
  }

  if (failures.length === 0) {
    console.log('[check-no-codex-provider-exit-suppression] ✅ clean — Phase H architecture preserved');
    process.exit(0);
  }

  console.error('[check-no-codex-provider-exit-suppression] ❌ Phase H regression detected!');
  console.error('');
  console.error('The Codex provider layer must NOT re-introduce exit-1 suppress bookkeeping');
  console.error('under any name — canonical truth source is the spawn-layer `finalSemanticDone`');
  console.error('predicate (localFinalTerminal + sticky signal fallback). Guard checks BOTH literal');
  console.error('old symbol names AND the AST ownership rule (Codex provider IfStatement.condition).');
  console.error('');
  for (const { pattern, regex, violations } of failures) {
    console.error(`▸ ${pattern}  (regex: ${regex})`);
    for (const line of violations) {
      console.error(`    ${line}`);
    }
    console.error('');
  }
  console.error('If this is intentional (some future Codex quirk that cannot be modeled via');
  console.error('semanticCompletionSignal), update FORBIDDEN_PATTERNS.allowFiles in this script AND');
  console.error('capture the quirk in F212 Phase H spec + a Sol-style archive fixture regression test.');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
