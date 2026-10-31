import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { discoverFiles } from '@cat-cafe/shared/scanner-discovery-pure';

export const RESOLVER_VERSION = 'f243-resolver-v1';

export function resolveDocsProfileScope(repoRoot, options = {}) {
  const root = path.resolve(repoRoot);
  const docsRoot = path.join(root, 'docs');
  const rawDocsFiles = discoverFiles(docsRoot).map((file) => ({ path: file.path, kind: file.kind }));
  const rawOverlayFiles = discoverSkillOverlayPaths(root);
  const ignoredAbsolutePaths = detectGitIgnored(
    root,
    [...rawDocsFiles.map((f) => f.path), ...rawOverlayFiles.map((f) => f.path)],
    // Private test hook — forwarded to spawnSync maxBuffer. Not part of public
    // API; only the ENOBUFS defense test uses it (PR #2845 cloud P2).
    options._testHooks ?? {},
  );
  const scannerFiles = rawDocsFiles
    .filter((file) => !ignoredAbsolutePaths.has(file.path))
    .map((file) => makeEntry(root, file.path, { kind: file.kind }));
  const overlayAdded = rawOverlayFiles
    .filter((file) => !ignoredAbsolutePaths.has(file.path))
    .map((file) => makeEntry(root, file.path, { kind: file.kind }));
  const profileEnforced = [];
  const profileExempt = [];

  for (const entry of scannerFiles) {
    const reason = getExemptReason(entry.relativePath);
    if (reason) {
      profileExempt.push({ ...entry, reason });
    } else {
      profileEnforced.push(entry);
    }
  }

  for (const entry of overlayAdded) {
    if (!profileEnforced.some((candidate) => candidate.relativePath === entry.relativePath)) {
      profileEnforced.push(entry);
    }
  }

  return {
    scanner_discovered_files: sortEntries(scannerFiles),
    profile_enforced: sortEntries(profileEnforced),
    profile_exempt: sortEntries(profileExempt),
    overlay_added: sortEntries(overlayAdded),
    resolvedAt: options.resolvedAt ?? new Date().toISOString(),
    resolverVersion: RESOLVER_VERSION,
  };
}

function makeEntry(repoRoot, absolutePath, extra = {}) {
  const normalizedPath = path.resolve(absolutePath);
  return {
    path: normalizedPath,
    relativePath: path.relative(repoRoot, normalizedPath).split(path.sep).join('/'),
    ...extra,
  };
}

function discoverSkillOverlayPaths(repoRoot) {
  const skillsRoot = path.join(repoRoot, 'cat-cafe-skills');
  if (!existsSync(skillsRoot)) return [];

  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsRoot, entry.name, 'SKILL.md'))
    .filter((skillPath) => existsSync(skillPath))
    .map((skillPath) => ({ path: skillPath, kind: 'skill' }));
}

/**
 * Ask git which of `absolutePaths` are gitignored. Returns a Set of ignored
 * absolute paths (Sol validation edge — F243 摩擦: generator was scanning
 * gitignored local folders → phantom index diffs).
 *
 * Semantics:
 * - Excludes the `ignored` set, not "intersect with ls-files": untracked
 *   but not-ignored files (a normal state during index regeneration) stay in.
 * - Uses `-z --stdin`: NUL-separated I/O safe for spaces / non-ASCII paths.
 * - Exit 0 = matches printed; exit 1 = no matches; exit 128 = not a git repo
 *   / other error → fail-safe: return empty set (legacy behavior, no filter).
 */
// Default 128 MiB — comfortably covers 10⁵+ ignored .md paths in one query
// (each path ≤ 4 KiB), well above any realistic docs profile scope.
// Node 24 `spawnSync` defaults to 1 MiB which is easily exceeded on repos with
// large local-only doc drafts (cloud codex P2 finding, PR #2845).
const DEFAULT_CHECK_IGNORE_MAX_BUFFER = 128 * 1024 * 1024;

function detectGitIgnored(repoRoot, absolutePaths, testHooks = {}) {
  if (absolutePaths.length === 0) return new Set();
  // Convert to repo-relative paths (git check-ignore prints the exact paths
  // it received, so a round-trip through relative keeps the mapping stable).
  const relToAbs = new Map();
  const relPaths = [];
  for (const abs of absolutePaths) {
    const rel = path.relative(repoRoot, abs);
    relToAbs.set(rel, abs);
    relPaths.push(rel);
  }
  const maxBuffer = testHooks.maxBuffer ?? DEFAULT_CHECK_IGNORE_MAX_BUFFER;
  // No encoding option → spawnSync returns stdout/stderr as Buffer (safe for NUL bytes).
  const result = spawnSync('git', ['-C', repoRoot, 'check-ignore', '-z', '--stdin'], {
    input: `${relPaths.join('\0')}\0`,
    maxBuffer,
  });
  // Spawn-level failure (`result.error` present, `status === null`):
  //   - ENOBUFS = stdout exceeded maxBuffer → fail-CLOSED. Silently returning an
  //     empty set would reintroduce every ignored file into the index — the
  //     exact regression this whole feature is meant to prevent. Better to abort
  //     loudly than corrupt the generated index.
  //   - Other spawn errors (git missing, permission) → fail-safe empty set
  //     (treat as "cannot determine ignored", keep legacy no-filter behavior).
  if (result.error) {
    if (result.error.code === 'ENOBUFS') {
      throw new Error(
        `F243 gitignore filter: git check-ignore stdout exceeded maxBuffer ` +
          `(${maxBuffer} bytes). Refusing to fail-open (would silently ` +
          `reintroduce ignored files as phantom index diff). Increase ` +
          `DEFAULT_CHECK_IGNORE_MAX_BUFFER or chunk the query.`,
      );
    }
    return new Set();
  }
  // Exit 0 = at least one ignored (stdout has content, NUL-separated).
  // Exit 1 = zero matches (empty stdout). Both are "successful queries".
  // Anything else (128 = not a git repo, etc.) → fail-safe: no filter.
  if (result.status !== 0 && result.status !== 1) return new Set();
  if (!result.stdout || result.stdout.length === 0) return new Set();
  const ignoredRel = result.stdout
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry.length > 0);
  const ignoredAbs = new Set();
  for (const rel of ignoredRel) {
    const abs = relToAbs.get(rel);
    if (abs) ignoredAbs.add(abs);
  }
  return ignoredAbs;
}

function getExemptReason(relativePath) {
  if (!relativePath.endsWith('.md')) return 'asset_file';
  if (relativePath.startsWith('docs/archive/')) return 'archived_artifact';
  if (relativePath.endsWith('/index.md')) return 'generated_artifact';
  if (relativePath === 'docs/lessons-learned.md') return 'generated_source_for_synthetic_LL_entries';
  return null;
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
