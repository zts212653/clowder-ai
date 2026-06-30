#!/usr/bin/env node
// check-sync-docs-runtime-assets.mjs - F251 sibling sub-task (C4 class).
//
// Why: outbound sync `sync-to-opensource.sh` uses `--exclude='docs/'` then
// re-includes a handful of docs/ paths via allowlist, structured export, or
// generated copy. If a runtime reader (e.g. an API route) reads docs/foo but
// none of those re-include channels covers docs/foo, sync silently drops the
// file and clowder-ai users hit 404 forever. F251 Phase A target-delta gate
// does not catch this because all three trees (base/theirs/ours) lack the
// file — no delta to preserve. This reverse-check fills that gap (C4 class).
//
// Spec: F251 spec, "C4 sync exclude rule misses runtime asset" Note.
// Incident: clowder-ai#1025 (docs/services-offline-install.html).
//
// Pure functions are unit-tested in check-sync-docs-runtime-assets.test.mjs.
// The CLI entry scans the real repo + loads real sync coverage + exits non-zero
// if any orphan is found.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_DEFAULT = resolve(SELF_DIR, '..');

// Files where we look for runtime docs/ references. Intentionally narrow:
// only server-side code that actually reads files at runtime. Frontend code
// (packages/web/src) reaches docs via API routes, so it does not need a
// docs/ asset to be sync-copied — only the server route does.
const SCAN_ROOTS = ['packages/api/src'];

// Source code extensions that may contain a runtime file read of docs/*.
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

// Skip noisy directories under SCAN_ROOTS.
const SCAN_SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '__tests__',
  '__mocks__',
  'test',
  'tests',
  'spec',
  '__snapshots__',
]);

// Skip test files even if they live alongside src.
function isTestFile(filePath) {
  return /\.(test|spec)\.[mc]?[tj]sx?$/.test(filePath);
}

// Matches ANY string literal that points at docs/*. Strict mode (R2) — the
// previous "must be on the same line as readFile/resolve/join" constraint
// missed dynamic readers like `PerspectivePlanLoader.loadById()` which builds
// `docs/perspectives/${id}.md` then hands it off to readFile in a later
// function. We now flag any source-file literal docs/* path and let the
// IGNORE_PATHS / sync coverage / human reviewer triage it.
//
// Cloud Codex R0 P1 (2026-06-26): "Cover dynamic runtime docs paths".
const READ_PATH_RE = /["'`](docs\/[a-zA-Z0-9_/\-.${}]+)["'`]/g;

// Comment line prefixes to ignore.
const COMMENT_LINE_RE = /^\s*(?:\/\/|\*|\/\*)/;

// Paths that match a docs/* literal in source but are NOT outbound-sync
// candidates. Each entry must explain WHY it is ignored. Maintainer extends
// when a new non-sync runtime touchpoint shows up.
//
// Match modes (one per entry):
//   - `exact`: full-path equality
//   - `prefix`: startsWith match (caller responsible for trailing-slash precision)
//   - `pathOrPrefix`: equals `pathOrPrefix` OR startsWith `pathOrPrefix + '/'`
//      (use for IGNORE entries where the literal sometimes appears with and
//      sometimes without a trailing slash)
export const IGNORE_PATHS = [
  {
    pathOrPrefix: 'docs/markers',
    reason:
      'MarkerQueue user runtime state (YAML files generated per-install by MarkerQueue). ' +
      'Each clowder-ai install has its own local marker queue — not a source asset to sync.',
  },
  {
    exact: 'docs/team/cat-dossier.md',
    reason:
      'DossierDraftApplier write target (Hub flow applies distillations and `git add`s the file). ' +
      'Each install builds its own dossier — sync would clobber downstream user state.',
  },
  // R2 additions — discovered by strict-mode scan after R1 P1 fix.
  {
    exact: 'docs/decisions/.gitkeep',
    reason:
      'methodology-templates scaffolds new external projects (not cat-cafe). The .gitkeep is created in the target project, not read from cat-cafe.',
  },
  {
    exact: 'docs/discussions/.gitkeep',
    reason: 'Same as docs/decisions/.gitkeep — methodology-templates scaffolds external project structure.',
  },
  {
    pathOrPrefix: 'docs/plans',
    reason:
      'artifact-tracking.ts classifies internal plan/discussion artifacts; docs/plans/ is cat-cafe internal (spec/discussion), never sync-exported. The literal is a path classifier prefix, not a runtime read.',
  },
  {
    exact: 'docs/',
    reason:
      'bare `docs/` literal is an alias key prefix or path-segment transform in IndexBuilder/SqliteEvidenceStore/evidence-helpers — not a file read target.',
  },
  {
    pathOrPrefix: 'docs/harness-feedback',
    reason:
      'F192 harness-eval verdict/bundle write target (publish-verdict.ts). Local per-install eval output, never sync-exported.',
  },
  {
    pathOrPrefix: 'docs/runtime',
    reason:
      'debug-invocation-export.ts write target for runtime invocation debug bundles. Local per-install debug output, never sync-exported.',
  },
  // R5 (cloud R3 P1 privacy leak + 砚砚 R5 narrative correction):
  // docs/BACKLOG.md is a transform-mapped source-only literal. Pipeline:
  //   - Guard scans the pre-sanitize source tree → sees 'docs/BACKLOG.md'
  //     literal in default-arg readers (git-doc-reader.ts:139 default,
  //     backlog-doc-import.ts:344 caller, external-project-store.ts:25 default)
  //   - sync-to-opensource.sh _sanitize-rules.pl:204
  //     `s#docs/BACKLOG\.md#docs/ROADMAP.md#g` rewrites every public-side
  //     literal to docs/ROADMAP.md before export
  //   - sync also generates a filtered docs/ROADMAP.md (RED-tier rows
  //     stripped, sync-to-opensource.sh:1671 "Strip rows for features not
  //     in exported index") so public readers find ROADMAP.md, not BACKLOG.md
  //   - Raw docs/BACKLOG.md is intentionally NOT in the public target
  //     (would leak RED-tier rows — cloud R3 P1)
  // No source-side env-aware fix needed; sanitizer + ROADMAP generator
  // already form the env-aware bridge. IGNORE here just tells the guard
  // "the sanitizer handles this literal at sync time, no outbound sync
  // asset needs to be added".
  {
    exact: 'docs/BACKLOG.md',
    reason:
      'Transform-mapped source-only literal — sync _sanitize-rules.pl:204 rewrites every public docs/BACKLOG.md literal to docs/ROADMAP.md, and sync-to-opensource.sh generates a filtered ROADMAP.md (RED-tier stripped) on the public target. Raw BACKLOG.md must NOT be in public (privacy: would expose RED-tier roadmap rows; cloud R3 P1). Guard sees the pre-sanitize literal, but the sanitizer + ROADMAP transform already cover the public side — no allowlist entry needed.',
  },
];

/**
 * Pure: does this docs/* path match an entry in IGNORE_PATHS?
 */
export function isIgnored(path) {
  for (const entry of IGNORE_PATHS) {
    if (entry.exact && path === entry.exact) return true;
    if (entry.prefix && path.startsWith(entry.prefix)) return true;
    if (entry.pathOrPrefix) {
      if (path === entry.pathOrPrefix) return true;
      if (path.startsWith(`${entry.pathOrPrefix}/`)) return true;
    }
  }
  return false;
}

/**
 * Pure: normalize a captured docs/* path. Template-string placeholders
 * (`docs/foo/${id}.md`) get truncated to the longest static prefix that ends
 * in `/` so coverage matching can use directory-prefix entries.
 */
export function normalizeCapturedPath(rawPath) {
  const dollarIdx = rawPath.indexOf('${');
  if (dollarIdx === -1) return rawPath;
  const beforeDollar = rawPath.slice(0, dollarIdx);
  const lastSlash = beforeDollar.lastIndexOf('/');
  if (lastSlash === -1) return rawPath;
  return beforeDollar.slice(0, lastSlash + 1);
}

/**
 * Pure: parse a single source-file content string and return all docs/*
 * references found in non-comment lines. Each reference is normalized so
 * template placeholders collapse to a coverage-matchable prefix.
 *
 * Test-friendly: takes raw content + file label, no IO.
 */
export function parseDocsReferences(content, file) {
  const references = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE_RE.test(line)) continue;
    READ_PATH_RE.lastIndex = 0;
    let match;
    while ((match = READ_PATH_RE.exec(line)) !== null) {
      const path = normalizeCapturedPath(match[1]);
      references.push({ file, line: i + 1, path });
    }
  }
  return references;
}

/**
 * Pure: does this docs/* path have sync coverage?
 *
 * Coverage entries:
 *   - exact file path: must equal full reference path
 *   - directory prefix ending in '/' ('docs/features/'): covers both
 *     references that include the trailing slash (`docs/features/F213.md`)
 *     and references that omit it (`docs/features` — git-doc-reader default
 *     parameter style). Without this dual coverage, both forms would have
 *     to be listed in the manifest.
 */
export function isCoveredBySync(path, coveragePaths) {
  for (const cov of coveragePaths) {
    if (cov.endsWith('/')) {
      const dir = cov.slice(0, -1);
      if (path === dir) return true;
      if (path.startsWith(cov)) return true;
    } else {
      if (path === cov) return true;
    }
  }
  return false;
}

/**
 * Pure: from a list of runtime references and a list of sync coverage paths,
 * return the references whose docs/* path is not covered AND not on the
 * IGNORE_PATHS list. Order preserved.
 */
export function findOrphanRuntimeDocsAssets({ runtimeReferences, syncCoveragePaths }) {
  return runtimeReferences.filter((ref) => !isIgnored(ref.path) && !isCoveredBySync(ref.path, syncCoveragePaths));
}

/**
 * Walk a directory tree and yield code file paths (relative to repoRoot).
 */
function* walkCodeFiles(repoRoot, dir) {
  const abs = resolve(repoRoot, dir);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      yield* walkCodeFiles(repoRoot, rel);
      continue;
    }
    if (!entry.isFile()) continue;
    const dotIdx = entry.name.lastIndexOf('.');
    if (dotIdx === -1) continue;
    const ext = entry.name.slice(dotIdx);
    if (!CODE_EXT.has(ext)) continue;
    if (isTestFile(rel)) continue;
    yield rel;
  }
}

/**
 * Scan repo for runtime `docs/*` references. Returns `[{ file, line, path }]`.
 * Thin IO wrapper around `parseDocsReferences`.
 */
export function scanRuntimeDocsReferences(repoRoot, scanRoots = SCAN_ROOTS) {
  const references = [];
  for (const root of scanRoots) {
    for (const rel of walkCodeFiles(repoRoot, root)) {
      const content = readFileSync(resolve(repoRoot, rel), 'utf8');
      references.push(...parseDocsReferences(content, rel));
    }
  }
  return references;
}

/**
 * Parse `<key>: ...` YAML list entries from sync-manifest.yaml.
 * Returns string[] of paths. Designed for the small, flat manifest sections
 * we touch (docs_*_allowlist) — not a general YAML parser.
 */
export function parseManifestList(manifestText, key) {
  const lines = manifestText.split('\n');
  const list = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!inSection) {
      if (line.startsWith(`${key}:`)) {
        inSection = true;
      }
      continue;
    }
    // End of section: next top-level key (no leading whitespace, no '-', not blank, not comment).
    if (/^[^\s#-]/.test(line)) break;
    const m = line.match(/^\s*-\s*(.+?)\s*$/);
    if (m) {
      const value = m[1].replace(/^["']|["']$/g, '');
      list.push(value);
    }
  }
  return list;
}

/**
 * Compute the docs/* paths that outbound sync actually copies into the public
 * target. Sources:
 *   - sync-manifest.yaml `docs_decisions_allowlist`
 *   - sync-manifest.yaml `docs_runtime_assets_allowlist` (new, F251 sibling)
 *   - structured export prefix `docs/features/`
 *   - generated copies: docs/BACKLOG.md → docs/ROADMAP.md (BACKLOG is read,
 *     so ROADMAP is irrelevant to runtime; we only model what runtime can ask
 *     to read). docs/lessons-learned.md → docs/public-lessons.md (same).
 *   - inline files: docs/SOP.md (sync-managed via manifest sync_managed_paths)
 *
 * We do NOT recurse the manifest's full sync_managed_paths because most of
 * those are non-docs paths. Instead this returns the docs/* slice.
 */
export function loadSyncCoveragePaths(repoRoot) {
  const manifestText = readFileSync(resolve(repoRoot, 'sync-manifest.yaml'), 'utf8');
  const decisionsAllowlist = parseManifestList(manifestText, 'docs_decisions_allowlist');
  const runtimeAssetsAllowlist = parseManifestList(manifestText, 'docs_runtime_assets_allowlist');
  return [
    // Structured exports (prefix).
    'docs/features/',
    // Single-file always-synced sources (mirrored verbatim by sync script).
    // NOTE: 'docs/BACKLOG.md' is NOT listed here — and is also NOT in
    // docs_runtime_assets_allowlist (would leak RED-tier rows on public,
    // cloud R3 P1). The public side is covered indirectly: sync sanitizer
    // (_sanitize-rules.pl:204) rewrites every 'docs/BACKLOG.md' literal in
    // public-side source to 'docs/ROADMAP.md', and sync generates a filtered
    // docs/ROADMAP.md. So readers that default to 'docs/BACKLOG.md' on the
    // source side end up reading docs/ROADMAP.md on the public side, and
    // ROADMAP.md is what actually exists there. The guard IGNORE entry for
    // docs/BACKLOG.md documents this transform-mapped semantics (see
    // IGNORE_PATHS).
    'docs/SOP.md',
    'docs/lessons-learned.md',
    // Generated copies that exist in the public target (renames preserved
    // because some runtime callers reference the public name):
    //   docs/BACKLOG.md -> docs/ROADMAP.md (sync-to-opensource.sh:1627)
    //   docs/lessons-learned.md -> docs/public-lessons.md (line 1652)
    'docs/ROADMAP.md',
    'docs/public-lessons.md',
    // Manifest-driven allowlists (single source of truth for what really
    // lands in the public target — see docs_runtime_assets_allowlist).
    ...decisionsAllowlist,
    ...runtimeAssetsAllowlist,
  ];
}

function formatOrphanReport(orphans, repoRoot) {
  const lines = [];
  lines.push(`Found ${orphans.length} runtime-referenced docs/* path(s) with no sync coverage:`);
  lines.push('');
  for (const orphan of orphans) {
    const display = relative(repoRoot, resolve(repoRoot, orphan.file));
    lines.push(`  ${display}:${orphan.line}  ->  ${orphan.path}`);
  }
  lines.push('');
  lines.push('To fix: add the path to sync-manifest.yaml under');
  lines.push('  docs_runtime_assets_allowlist:');
  lines.push('    - docs/<path>');
  lines.push('and ensure sync-to-opensource.sh copies that allowlist into the');
  lines.push('filtered export (mirror docs_decisions_allowlist).');
  lines.push('');
  lines.push('Spec: F251 spec, "C4 sync exclude rule misses runtime asset" Note.');
  lines.push('Incident: clowder-ai#1025 (services-offline-install.html).');
  return lines.join('\n');
}

function main() {
  const repoRoot = process.env.REPO_ROOT ? resolve(process.env.REPO_ROOT) : REPO_ROOT_DEFAULT;
  try {
    statSync(resolve(repoRoot, 'sync-manifest.yaml'));
  } catch {
    console.error(`check-sync-docs-runtime-assets: sync-manifest.yaml not found under ${repoRoot}`);
    process.exit(2);
  }
  const runtimeReferences = scanRuntimeDocsReferences(repoRoot);
  const syncCoveragePaths = loadSyncCoveragePaths(repoRoot);
  const orphans = findOrphanRuntimeDocsAssets({
    runtimeReferences,
    syncCoveragePaths,
  });
  if (orphans.length === 0) {
    console.log(
      `check-sync-docs-runtime-assets: OK (${runtimeReferences.length} runtime docs/* references, all covered by sync).`,
    );
    process.exit(0);
  }
  console.error(formatOrphanReport(orphans, repoRoot));
  process.exit(1);
}

// Run when invoked directly (not when imported by the test file).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
