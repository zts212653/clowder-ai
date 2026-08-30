#!/usr/bin/env node
// @ts-check

/**
 * F192 verdict publish contract — shared executable guard for git-worktree-publisher
 * and git-verdict-pr-refresher.
 *
 * Called by the publisher at three points:
 *   1. Identity-only: before `git fetch` — verifies remote owner/repo matches expected
 *   2. Full: after fetch — identity + census continuity on freshly-fetched source ref
 *   3. Full: after commit — identity + census in the committed worktree HEAD
 *
 * Also called by scripts/guarded-bin/gh as the transport-boundary guard.
 *
 * Usage:
 *   node check-verdict-publish-contract.mjs \
 *     --repo-root <path> \
 *     --expected-repo <owner/repo> \
 *     --remote <name> \
 *     --base-ref <ref>              (or --fresh-base-branch <branch>) \
 *     --source-ref <ref> \
 *     [--identity-only true]
 *
 * Exits 0 on pass; exits 1 with descriptive message on contract violation.
 *
 * Why a separate script (not inline in the TS module):
 *   - The guarded-bin/gh pre-push hook also calls this for transport-boundary
 *     identity verification; sharing the logic prevents drift.
 *   - The contract runner in git-worktree-publisher.ts shells out via execFile
 *     so the check runs in a clean process with no in-memory state leakage.
 */

import { execFileSync } from 'node:child_process';
import { argv, exit } from 'node:process';

// ── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      const key = args[i].slice(2);
      parsed[key] = args[i + 1];
      i++;
    }
  }
  return parsed;
}

const args = parseArgs(argv.slice(2));

const repoRoot = args['repo-root'];
const expectedRepo = args['expected-repo'];
const remoteName = args['remote'] ?? 'origin';
// Accept both --base-ref (publisher) and --fresh-base-branch (guarded-bin/gh)
const baseRef = args['base-ref'] ?? args['fresh-base-branch'];
const sourceRef = args['source-ref'];
const identityOnly = args['identity-only'] === 'true';

if (!repoRoot || !expectedRepo) {
  console.error('verdict-publish-contract: --repo-root and --expected-repo are required');
  exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function git(cwd, gitArgs) {
  return execFileSync('git', gitArgs, { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
}

/**
 * Extract `owner/repo` from a GitHub remote URL.
 *
 * Anchored patterns only — never matches substring hosts like
 * `not-github.com` or `github.com.evil.com`.
 *
 * Handles:
 *   - https://github.com/owner/repo.git
 *   - https://github.com/owner/repo
 *   - git@github.com:owner/repo.git
 *   - ssh://git@github.com/owner/repo.git
 */
function extractOwnerRepo(remoteUrl) {
  // HTTPS: anchored https://github.com/owner/repo(.git)?
  const httpsMatch = remoteUrl.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  // SSH shorthand: anchored git@github.com:owner/repo(.git)?
  const sshMatch = remoteUrl.match(/^[^@]+@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  // SSH URL: anchored ssh://...@github.com/owner/repo(.git)?
  const sshUrlMatch = remoteUrl.match(/^ssh:\/\/[^@]*@github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshUrlMatch) return sshUrlMatch[1];

  return null;
}

/**
 * Verify a single remote URL resolves to the expected owner/repo.
 * Returns null on success, or { code, detail } on failure.
 *
 * code distinction:
 *   IDENTITY_FAILED   — URL is not a recognized github.com URL at all
 *                        (parse failure, non-GitHub host, spoofed domain)
 *   IDENTITY_MISMATCH — URL is a valid github.com URL but points to a
 *                        different owner/repo than expected
 */
function verifyUrl(url, label) {
  const repo = extractOwnerRepo(url);
  if (!repo) {
    return {
      code: 'IDENTITY_FAILED',
      detail:
        `cannot parse owner/repo from ${label} URL '${url}'. ` + `Expected anchored github.com URL (HTTPS or SSH).`,
    };
  }
  if (repo !== expectedRepo) {
    return {
      code: 'IDENTITY_MISMATCH',
      detail:
        `${label} resolves to '${repo}', expected '${expectedRepo}'. ` +
        `Publication target must match the canonical repository. ` +
        `Set CAT_CAFE_VERDICT_REPO_FULL_NAME or CAT_CAFE_REPO_FULL_NAME to override.`,
    };
  }
  return null;
}

// ── Identity check (fetch URL) ───────────────────────────────────────────────

let fetchUrl;
try {
  fetchUrl = git(repoRoot, ['remote', 'get-url', remoteName]);
} catch (err) {
  console.error(
    `verdict-publish-contract: IDENTITY_FAILED — cannot resolve remote '${remoteName}' in ${repoRoot}: ${err.message}`,
  );
  exit(1);
}

const fetchResult = verifyUrl(fetchUrl, `remote '${remoteName}' fetch URL`);
if (fetchResult) {
  console.error(`verdict-publish-contract: ${fetchResult.code} — ${fetchResult.detail}`);
  exit(1);
}

// ── Identity check (push URL) ────────────────────────────────────────────────
// Git allows separate push/fetch URLs via remote.<name>.pushurl. If pushurl
// differs from fetchurl, evidence could be pushed to a non-canonical remote.

let pushUrl;
try {
  pushUrl = git(repoRoot, ['remote', 'get-url', '--push', remoteName]);
} catch {
  // Fallback: if --push fails (older git), push URL = fetch URL (already verified)
  pushUrl = fetchUrl;
}

if (pushUrl !== fetchUrl) {
  const pushResult = verifyUrl(pushUrl, `remote '${remoteName}' push URL`);
  if (pushResult) {
    console.error(`verdict-publish-contract: ${pushResult.code} — ${pushResult.detail}`);
    exit(1);
  }
}

if (identityOnly) {
  // Identity-only mode: we're done.
  exit(0);
}

// ── Full contract checks (census continuity) ─────────────────────────────────

if (!sourceRef) {
  console.error('verdict-publish-contract: --source-ref is required for full (non-identity-only) checks');
  exit(1);
}

// Census file must exist at the source ref. This prevents publishing a verdict
// onto a branch that predates the census infrastructure.
const censusPath = 'docs/harness-feedback/registry/measurement-bundles.yaml';
try {
  git(repoRoot, ['cat-file', '-e', `${sourceRef}:${censusPath}`]);
} catch {
  console.error(
    `verdict-publish-contract: CENSUS_MISSING — '${censusPath}' does not exist at '${sourceRef}'. ` +
      `The measurement bundle census is required for verdict collision detection and derived counts. ` +
      `Ensure the source ref includes the census infrastructure commit.`,
  );
  exit(1);
}

// If baseRef is provided and differs from sourceRef, verify census also exists at base.
// This catches the edge case where a rebase drops the census file.
if (baseRef && baseRef !== sourceRef) {
  try {
    git(repoRoot, ['cat-file', '-e', `${baseRef}:${censusPath}`]);
  } catch {
    // Base lacking census is acceptable (bootstrap scenario) — warn but don't fail.
    console.error(
      `verdict-publish-contract: WARNING — census file missing at base ref '${baseRef}'. ` +
        `This is acceptable during census bootstrap but should not persist.`,
    );
  }
}

exit(0);
