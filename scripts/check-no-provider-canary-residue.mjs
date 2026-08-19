#!/usr/bin/env node
/**
 * F212 Phase H post-close hotfix — Ver B independent canary residue guard.
 *
 * Recursively scans the shared provider directory
 * `packages/api/src/domains/cats/services/agents/providers/**` for any file
 * whose basename contains "canary" (case-insensitive). Exits 1 with the
 * offending paths listed if any are present.
 *
 * Fail-CLOSED semantics (Sol R1 P1-C hardening 2026-07-13):
 *   • Missing providers root → fail-CLOSED violation `<guard>` sentinel.
 *     Target discovery is part of the guard; a renamed / deleted providers
 *     directory MUST NOT read as clean. This is analogous to R9 P1's
 *     TargetDiscoveryError path in the AST guard.
 *   • Unreadable providers root / nested subdir → fail-CLOSED violation.
 *   • Recursive scan: previous top-level-only scan let `providers/nested/
 *     Codex-canary-leak.ts` slip; a file dropped into any subdirectory of
 *     providers/ is a residue.
 *   • Carrier-agnostic basename invariant: previous enumerated 4 carrier
 *     prefixes (Codex-canary-*, Gemini-canary-*, OpenCode-canary-*, canary*)
 *     silently skipped new carriers (Qwen, Claude, etc.). Sol's contract:
 *     production provider filenames are named after the carrier (`Codex
 *     AgentService.ts`, `GeminiAgentService.ts`, ...) and NEVER contain
 *     "canary"; so `/canary/i` on the basename is the correct, single,
 *     carrier-agnostic invariant.
 *
 * Wired as the FIRST item in `pnpm check` (before biome, before any TypeScript
 * scan) — Sol R1 P1-D correction. A residue guard that runs after Biome would
 * let a malformed `*.ts` residue file trigger a Biome parse error first,
 * masking the causal cleanup issue.
 */

import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(__dirname, '..');

const PROVIDERS_DIR = 'packages/api/src/domains/cats/services/agents/providers';

/**
 * Sol R1 P1-C hardened contract: production provider filenames never contain
 * the substring "canary". Any file whose basename matches `/canary/i` is a
 * test/dev residue by convention.
 */
const CANARY_INVARIANT = /canary/i;

export function isCanaryFilename(name) {
  return CANARY_INVARIANT.test(name);
}

/** Sentinel error surface so `main()` can produce a fail-CLOSED violation. */
export class ProviderScanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderScanError';
  }
}

/**
 * Recursively enumerate files under `dir`. Throws `ProviderScanError` on any
 * `readdirSync` failure so the caller can fail-CLOSED with an explicit
 * violation record.
 */
function walkFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new ProviderScanError(`cannot read ${dir}: ${err.message.slice(0, 200)}`);
  }
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Return array of residue paths (relative to `repoRoot`). Empty array on
 * clean tree. On fail-CLOSED conditions, returns an array whose FIRST entry
 * begins with `<guard>:` so the orchestrator can detect it as a fail-CLOSED
 * violation, not a normal residue path.
 */
export function findCanaryResidue(repoRoot) {
  const dir = join(repoRoot, PROVIDERS_DIR);
  let providersStat;
  try {
    providersStat = statSync(dir);
  } catch (err) {
    return [
      `<guard>: providers root missing or unreadable at ${PROVIDERS_DIR} (${err.message.slice(0, 120)}) — F212 Phase H target must exist for the guard to be meaningful`,
    ];
  }
  if (!providersStat.isDirectory()) {
    return [`<guard>: providers path is not a directory at ${PROVIDERS_DIR}`];
  }
  let allFiles;
  try {
    allFiles = walkFiles(dir);
  } catch (err) {
    if (err instanceof ProviderScanError) return [`<guard>: ${err.message}`];
    throw err;
  }
  const residues = [];
  for (const full of allFiles) {
    // Sol R2 P1-3: use path.basename() for cross-platform safety. The previous
    // `full.lastIndexOf('/') + 1` slice fell over on Windows where join() emits
    // backslashes; any ancestor directory containing "canary" would then trip
    // every provider file as a residue false-positive on Windows checkouts.
    if (isCanaryFilename(basename(full))) {
      residues.push(`./${relative(repoRoot, full)}`);
    }
  }
  return residues;
}

function parseRepoRoot(argv) {
  const idx = argv.indexOf('--repo-root');
  if (idx === -1) return DEFAULT_REPO_ROOT;
  const value = argv[idx + 1];
  if (!value) {
    console.error('[check-no-provider-canary-residue] --repo-root requires a path argument');
    process.exit(2);
  }
  return value;
}

function main() {
  const repoRoot = parseRepoRoot(process.argv.slice(2));
  const residues = findCanaryResidue(repoRoot);
  if (residues.length === 0) {
    console.log('[check-no-provider-canary-residue] ✅ clean — no canary residue in providers/');
    process.exit(0);
  }
  const failClosed = residues.some((r) => r.startsWith('<guard>:'));
  if (failClosed) {
    console.error('[check-no-provider-canary-residue] ❌ fail-CLOSED — provider directory integrity issue!');
    console.error('');
    console.error('The F212 Phase H provider directory did not pass structural discovery. Missing');
    console.error('target = suspect state (not clean). If Phase H target was renamed / restructured,');
    console.error('update this guard in the SAME change so the check remains meaningful.');
    console.error('');
    for (const path of residues) {
      console.error(`  ${path}`);
    }
    process.exit(1);
  }
  console.error('[check-no-provider-canary-residue] ❌ canary residue detected in providers/!');
  console.error('');
  console.error('These files appear to be test fixture residue that leaked into the shared');
  console.error('production provider directory. That can dirty other worktrees and false-red');
  console.error('the merge-gate on unrelated features (Sol F254 2026-07-13 report).');
  console.error('');
  console.error('Remedy:');
  console.error('  1. rm the offending files listed below (they are untracked test residue).');
  console.error('  2. If they came from a test, migrate that test to makeIsolatedFixture()');
  console.error('     from scripts/check-no-codex-provider-exit-suppression/test-scaffold.mjs');
  console.error('     so fixtures live in os.tmpdir() instead of shared production paths.');
  console.error('');
  for (const path of residues) {
    console.error(`  ▸ ${path}`);
  }
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
