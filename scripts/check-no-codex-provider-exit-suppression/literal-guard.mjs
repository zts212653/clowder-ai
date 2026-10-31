/**
 * F212 Phase H — literal-symbol guard (Sol R8 P1-B split + Sol post-close
 * hotfix 2026-07-13 git-grep migration).
 *
 * Grep-based check for known deleted Phase H tokens
 * (`sawSubstantiveOutput`, `hasNonSuppressibleCodexExitOneDiagnostics`,
 * `suppressing as Codex 0.98+ quirk`). Sibling `ast-ownership.mjs` module
 * enforces the AST condition-ownership rule that catches renamed suppress.
 *
 * Sol Bug 1 hotfix contract (paired flags — non-negotiable):
 *   git grep -EIn --no-color --no-recurse-submodules \
 *                 --untracked --exclude-standard \
 *                 -e <regex> -- <pathspecs...>
 *
 *   • `--no-color` — avoid user Git color config leaking ANSI escape codes
 *     into the `path:line:content` parser.
 *   • `--no-recurse-submodules` — F212 guard scope is Codex provider files
 *     inside THIS repo. Any future submodule adoption must renegotiate scope
 *     explicitly; the guard must not silently drift.
 *   • `--untracked` — see runtime canaries + un-added violation-source files
 *     that a developer has not yet `git add`-ed. Without this, guard is
 *     false-green when the offending code is untracked.
 *   • `--exclude-standard` — honour `.gitignore` so `.review-worktrees/`,
 *     `.cat-cafe/thread-exports/`, etc. do NOT trip the guard on their
 *     historical narrative content. Without this, `--untracked` alone
 *     resurrects the original Bug 1 false-red.
 *
 * The pair is intentional. Removing either flag re-introduces a defect.
 *
 * Fail-CLOSED semantics:
 *   • `git grep` exit 0 = matches found (guard reports violations).
 *   • `git grep` exit 1 = clean (no matches, guard reports empty).
 *   • `git grep` exit >= 2 OR non-git-repo = fail-CLOSED violation
 *     `<guard>` sentinel, so an orchestrator that sees a broken git-grep
 *     invocation cannot silently pass.
 */

import { execFileSync } from 'node:child_process';

/**
 * Forbidden literal patterns. `regex` is a POSIX-ERE fragment; `allowFiles`
 * lists tracked source paths legitimately allowed to mention this token
 * (documentation, historical narrative, this guard's own test canaries).
 * Everything else is a regression.
 *
 * Sol hotfix P3: allowlist stale entries `check-no-codex-provider-exit-
 * suppression.test.mjs` were carried over from Sol R8 P1-B split when the
 * parent test file was decomposed into `-literal.test.mjs` + `-ast.test.mjs`
 * — the parent no longer exists. Removed here.
 */
export const FORBIDDEN_PATTERNS = [
  {
    name: 'sawSubstantiveOutput variable/field',
    regex: 'sawSubstantiveOutput',
    allowFiles: [
      'docs/features/F212-cli-error-diagnostics.md',
      'docs/lessons-learned.md',
      'packages/api/test/codex-agent-service.test.js',
      'scripts/check-no-codex-provider-exit-suppression.mjs',
      'scripts/check-no-codex-provider-exit-suppression/literal-guard.mjs',
      'scripts/check-no-codex-provider-exit-suppression-literal.test.mjs',
      'scripts/check-no-codex-provider-exit-suppression-ast.test.mjs',
      'scripts/check-no-codex-provider-exit-suppression-isolation.test.mjs',
    ],
  },
  {
    name: 'hasNonSuppressibleCodexExitOneDiagnostics helper',
    regex: 'hasNonSuppressibleCodexExitOneDiagnostics',
    allowFiles: [
      'docs/features/F212-cli-error-diagnostics.md',
      'docs/lessons-learned.md',
      'scripts/check-no-codex-provider-exit-suppression.mjs',
      'scripts/check-no-codex-provider-exit-suppression/literal-guard.mjs',
      'scripts/check-no-codex-provider-exit-suppression-literal.test.mjs',
      'scripts/check-no-codex-provider-exit-suppression-isolation.test.mjs',
    ],
  },
  {
    name: 'suppressing as Codex 0.98+ quirk log message',
    regex: 'suppressing as Codex 0\\.98',
    allowFiles: [
      'docs/features/F212-cli-error-diagnostics.md',
      'docs/lessons-learned.md',
      'scripts/check-no-codex-provider-exit-suppression.mjs',
      'scripts/check-no-codex-provider-exit-suppression/literal-guard.mjs',
      'scripts/check-no-codex-provider-exit-suppression-literal.test.mjs',
      'scripts/check-no-codex-provider-exit-suppression-isolation.test.mjs',
    ],
  },
];

/**
 * File-type pathspecs. Kept narrow to avoid inflating false-positive surface
 * (Sol tradeoff段: don't扩大 file types beyond current scope).
 */
const PATHSPECS = ['*.ts', '*.tsx', '*.js', '*.mjs', '*.md'];

// Cloud R2 + R3 P2 (2026-07-13): `--exclude-standard` only honours `.gitignore`
// / `.git/info/exclude` / core.excludesFile. Generated-cache directories that a
// developer or CI workspace may have UNTRACKED but NOT in `.gitignore` would
// otherwise be swept by `--untracked` and false-red the guard. The previous
// `grep -EIrn --exclude-dir=…` list explicitly skipped these three at any depth.
//
// `:(exclude,glob)` is git's canonical exclude-pathspec magic-prefix. Cloud R3
// P2 catch: git pathspec `glob` wildcards do NOT match `/`, so `build/**` only
// excludes ROOT `build/`; nested paths like `packages/api/build/leak.ts` still
// leak. Fix: use any-depth `<STARSTAR>/PATH/<STARSTAR>` — leading `<STARSTAR>/`
// matches `PATH/` at ANY depth (including root, verified). This preserves the
// previous any-depth `--exclude-dir` scope.
//
// (Note: line comments, not JSDoc block comments — a literal `<STARSTAR>/`
// inside `/** ... */` is parsed as `*/` and terminates the block early.)
//
// Note: `node_modules/`, `dist/`, `.next/` are already covered by `.gitignore`
// + `--exclude-standard`; only the un-ignored generated-cache dirs need
// explicit exclusion.
const EXCLUDE_PATHSPECS = [':(exclude,glob)**/.cache/**', ':(exclude,glob)**/.turbo/**', ':(exclude,glob)**/build/**'];

/**
 * Run a single `git grep` sweep against the repo, return matching
 * `path:line:content` lines. Fail-CLOSED on git failure.
 */
export function grepPattern(regex, repoRoot) {
  const args = [
    'grep',
    '-EIn',
    '--no-color',
    '--no-recurse-submodules',
    '--untracked',
    '--exclude-standard',
    '-e',
    regex,
    '--',
    ...PATHSPECS,
    ...EXCLUDE_PATHSPECS,
  ];
  let result;
  try {
    result = execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // git grep exit 1 = no matches (clean). Anything else = something is
    // structurally wrong (not a git repo, unreadable, git binary missing).
    if (err.status === 1) return [];
    const stderr = err.stderr?.toString?.() ?? '';
    throw new GitGrepError(`git grep failed (status=${err.status ?? 'unknown'}): ${stderr.slice(0, 300)}`);
  }
  return result
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Sentinel error surface so orchestrator can produce a fail-CLOSED violation. */
export class GitGrepError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitGrepError';
  }
}

export function pathFromGrepLine(line) {
  const withoutPrefix = line.startsWith('./') ? line.slice(2) : line;
  const firstColon = withoutPrefix.indexOf(':');
  return firstColon === -1 ? withoutPrefix : withoutPrefix.slice(0, firstColon);
}

/**
 * Sweep all literal FORBIDDEN_PATTERNS and return an array of failure records
 * (grouped by pattern) — empty array on clean tree.
 *
 * Fail-CLOSED: any `GitGrepError` bubbles up as a synthetic violation
 * record with `<guard>` file so the orchestrator sees non-empty violations
 * and exits non-zero. This is the analogue of the AST module's
 * TargetDiscoveryError → fail-CLOSED path (Sol R9 P1).
 */
export function scanLiteralViolations(repoRoot) {
  const failures = [];
  for (const pattern of FORBIDDEN_PATTERNS) {
    let hits;
    try {
      hits = grepPattern(pattern.regex, repoRoot);
    } catch (err) {
      if (err instanceof GitGrepError) {
        failures.push({
          pattern: `${pattern.name} (fail-CLOSED)`,
          regex: pattern.regex,
          violations: [`<guard>: ${err.message}`],
        });
        continue;
      }
      throw err;
    }
    const violations = hits.filter((line) => {
      const file = pathFromGrepLine(line);
      return !pattern.allowFiles.includes(file);
    });
    if (violations.length > 0) {
      failures.push({ pattern: pattern.name, regex: pattern.regex, violations });
    }
  }
  return failures;
}
