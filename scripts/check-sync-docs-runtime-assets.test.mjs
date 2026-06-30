// check-sync-docs-runtime-assets.test.mjs - F251 sibling sub-task (C4 class).
//
// Reverse-check that every runtime-referenced docs/* path has a sync
// coverage entry (manifest allowlist, structured export, or generated copy).
// If a runtime reader points at docs/foo but sync never copies docs/foo to
// the public target, clowder-ai users hit 404 (issue clowder-ai#1025 root
// cause: outbound sync `--exclude='docs/'` silently swallowed
// docs/services-offline-install.html while route + frontend still linked).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findOrphanRuntimeDocsAssets,
  IGNORE_PATHS,
  isCoveredBySync,
  isIgnored,
  normalizeCapturedPath,
  parseDocsReferences,
} from './check-sync-docs-runtime-assets.mjs';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const SYNC_SCRIPT_PATH = resolve(SELF_DIR, 'sync-to-opensource.sh');

describe('isCoveredBySync', () => {
  it('matches exact file paths', () => {
    assert.equal(isCoveredBySync('docs/SOP.md', ['docs/SOP.md']), true);
  });

  it('matches directory prefix coverage', () => {
    assert.equal(isCoveredBySync('docs/decisions/ADR-031.md', ['docs/decisions/']), true);
  });

  it('matches features/ structured export prefix', () => {
    assert.equal(isCoveredBySync('docs/features/F251-public-delta-preservation-gate.md', ['docs/features/']), true);
  });

  it('does not match siblings outside prefix', () => {
    assert.equal(isCoveredBySync('docs/orphan.html', ['docs/decisions/']), false);
  });

  it('does not match partial filename overlap', () => {
    // 'docs/foo.md' must not match 'docs/foo.md.backup'
    assert.equal(isCoveredBySync('docs/foo.md.backup', ['docs/foo.md']), false);
  });

  it('empty coverage list matches nothing', () => {
    assert.equal(isCoveredBySync('docs/anything.html', []), false);
  });
});

describe('findOrphanRuntimeDocsAssets', () => {
  it('flags a referenced docs path with no sync coverage', () => {
    const orphans = findOrphanRuntimeDocsAssets({
      runtimeReferences: [{ file: 'packages/api/src/foo.ts', line: 10, path: 'docs/orphan.html' }],
      syncCoveragePaths: ['docs/SOP.md', 'docs/BACKLOG.md'],
    });

    assert.deepEqual(orphans, [{ file: 'packages/api/src/foo.ts', line: 10, path: 'docs/orphan.html' }]);
  });

  it('passes references when sync coverage includes the exact path', () => {
    const orphans = findOrphanRuntimeDocsAssets({
      runtimeReferences: [
        {
          file: 'packages/api/src/routes/services.ts',
          line: 98,
          path: 'docs/services-offline-install.html',
        },
      ],
      syncCoveragePaths: ['docs/services-offline-install.html'],
    });

    assert.deepEqual(orphans, []);
  });

  it('passes references covered by a directory prefix', () => {
    const orphans = findOrphanRuntimeDocsAssets({
      runtimeReferences: [{ file: 'a.ts', line: 1, path: 'docs/decisions/ADR-031.md' }],
      syncCoveragePaths: ['docs/decisions/'],
    });

    assert.deepEqual(orphans, []);
  });

  it('flags multiple orphans independently and preserves order', () => {
    const orphans = findOrphanRuntimeDocsAssets({
      runtimeReferences: [
        { file: 'a.ts', line: 1, path: 'docs/a.html' },
        { file: 'b.ts', line: 2, path: 'docs/covered.md' },
        { file: 'c.ts', line: 3, path: 'docs/b.html' },
      ],
      syncCoveragePaths: ['docs/covered.md'],
    });

    assert.deepEqual(orphans, [
      { file: 'a.ts', line: 1, path: 'docs/a.html' },
      { file: 'c.ts', line: 3, path: 'docs/b.html' },
    ]);
  });

  it('returns empty list when all references are covered', () => {
    const orphans = findOrphanRuntimeDocsAssets({
      runtimeReferences: [
        { file: 'a.ts', line: 1, path: 'docs/SOP.md' },
        { file: 'b.ts', line: 2, path: 'docs/features/F251.md' },
      ],
      syncCoveragePaths: ['docs/SOP.md', 'docs/features/'],
    });

    assert.deepEqual(orphans, []);
  });

  it('returns empty list when no runtime references exist', () => {
    const orphans = findOrphanRuntimeDocsAssets({
      runtimeReferences: [],
      syncCoveragePaths: ['docs/SOP.md'],
    });

    assert.deepEqual(orphans, []);
  });
});

describe('normalizeCapturedPath', () => {
  it('returns static literal paths unchanged', () => {
    assert.equal(normalizeCapturedPath('docs/services-offline-install.html'), 'docs/services-offline-install.html');
  });

  it('collapses template-string placeholder to directory prefix', () => {
    // PerspectivePlanLoader.loadById builds `docs/perspectives/${id}.md`
    assert.equal(normalizeCapturedPath('docs/perspectives/${id}.md'), 'docs/perspectives/');
  });

  it('keeps multi-segment static prefix when placeholder is deep', () => {
    assert.equal(normalizeCapturedPath('docs/team/sub/${id}/dossier.md'), 'docs/team/sub/');
  });

  it('returns original when placeholder appears before any slash', () => {
    // Edge case: `${root}/foo` — no static prefix to keep
    assert.equal(normalizeCapturedPath('docs${suffix}'), 'docs${suffix}');
  });
});

describe('isIgnored', () => {
  it('matches exact entries', () => {
    assert.equal(isIgnored('docs/team/cat-dossier.md'), true);
  });

  it('matches prefix entries', () => {
    assert.equal(isIgnored('docs/markers/foo-bar.yaml'), true);
    assert.equal(isIgnored('docs/markers/'), true);
  });

  it('returns false for paths not on the ignore list', () => {
    assert.equal(isIgnored('docs/services-offline-install.html'), false);
    assert.equal(isIgnored('docs/perspectives/'), false);
  });

  it('every IGNORE_PATHS entry has a reason and a match mode', () => {
    for (const entry of IGNORE_PATHS) {
      assert.ok(
        typeof entry.reason === 'string' && entry.reason.length > 10,
        `IGNORE entry ${JSON.stringify(entry)} must have a reason`,
      );
      assert.ok(
        entry.exact || entry.prefix || entry.pathOrPrefix,
        `IGNORE entry ${JSON.stringify(entry)} must have one of: exact, prefix, pathOrPrefix`,
      );
    }
  });
});

describe('parseDocsReferences', () => {
  it('catches plain literal in source', () => {
    const refs = parseDocsReferences("const x = 'docs/foo.md';", 'a.ts');
    assert.deepEqual(refs, [{ file: 'a.ts', line: 1, path: 'docs/foo.md' }]);
  });

  it('catches default-argument literal (R0 P3 — readBacklogContent style)', () => {
    const refs = parseDocsReferences(
      "export async function readBacklog(backlogRelPath = 'docs/BACKLOG.md') {}",
      'b.ts',
    );
    assert.deepEqual(refs, [{ file: 'b.ts', line: 1, path: 'docs/BACKLOG.md' }]);
  });

  it('catches template-string and normalizes the placeholder (R0 P1 — PerspectivePlanLoader.loadById)', () => {
    const refs = parseDocsReferences('return this.loadByPath(`docs/perspectives/${id}.md`);', 'c.ts');
    assert.deepEqual(refs, [{ file: 'c.ts', line: 1, path: 'docs/perspectives/' }]);
  });

  it('catches const-assignment literal (DossierDraftApplier style)', () => {
    const refs = parseDocsReferences("export const DOSSIER_RELATIVE_PATH = 'docs/team/cat-dossier.md';", 'd.ts');
    assert.deepEqual(refs, [{ file: 'd.ts', line: 1, path: 'docs/team/cat-dossier.md' }]);
  });

  it('catches array-literal entries', () => {
    const refs = parseDocsReferences("const PATHS = ['docs/SOP.md', 'docs/lessons-learned.md'];", 'e.ts');
    assert.deepEqual(refs, [
      { file: 'e.ts', line: 1, path: 'docs/SOP.md' },
      { file: 'e.ts', line: 1, path: 'docs/lessons-learned.md' },
    ]);
  });

  it('skips full-line comments', () => {
    const refs = parseDocsReferences("// See 'docs/features/F213.md' for context\nconst x = 1;", 'f.ts');
    assert.deepEqual(refs, []);
  });

  it('skips JSDoc-style asterisk lines', () => {
    const refs = parseDocsReferences(' * Spec: `docs/features/F188.md`', 'g.ts');
    assert.deepEqual(refs, []);
  });

  it('returns separate entries with correct line numbers across a multi-line file', () => {
    const content = "const A = 'docs/foo.md';\nconst B = 'docs/bar.md';\nconst C = 'docs/baz.md';";
    const refs = parseDocsReferences(content, 'h.ts');
    assert.deepEqual(refs, [
      { file: 'h.ts', line: 1, path: 'docs/foo.md' },
      { file: 'h.ts', line: 2, path: 'docs/bar.md' },
      { file: 'h.ts', line: 3, path: 'docs/baz.md' },
    ]);
  });
});

describe('findOrphanRuntimeDocsAssets with IGNORE filter', () => {
  it('pathOrPrefix entries match both bare path and dir-prefix forms', () => {
    // R2: factory.ts has the literal 'docs/markers' (no trailing slash),
    // MarkerQueue uses 'docs/markers/{id}.yaml'. Both must be ignored under one entry.
    const orphans = findOrphanRuntimeDocsAssets({
      runtimeReferences: [
        { file: 'factory.ts', line: 131, path: 'docs/markers' },
        { file: 'MarkerQueue.ts', line: 53, path: 'docs/markers/abc.yaml' },
        { file: 'a.ts', line: 1, path: 'docs/perspectives/' },
      ],
      syncCoveragePaths: [],
    });
    assert.deepEqual(orphans, [{ file: 'a.ts', line: 1, path: 'docs/perspectives/' }]);
  });

  it('filters out IGNORE_PATHS trailing-slash directory entries', () => {
    const orphans = findOrphanRuntimeDocsAssets({
      runtimeReferences: [
        { file: 'MarkerQueue.ts', line: 53, path: 'docs/markers/abc.yaml' },
        { file: 'a.ts', line: 1, path: 'docs/perspectives/' },
      ],
      syncCoveragePaths: [],
    });
    assert.deepEqual(orphans, [{ file: 'a.ts', line: 1, path: 'docs/perspectives/' }]);
  });

  it('filters out exact-match IGNORE entries (cat-dossier write target)', () => {
    const orphans = findOrphanRuntimeDocsAssets({
      runtimeReferences: [
        { file: 'DossierDraftApplier.ts', line: 46, path: 'docs/team/cat-dossier.md' },
        { file: 'PerspectivePlanLoader.ts', line: 79, path: 'docs/perspectives/' },
      ],
      syncCoveragePaths: [],
    });
    assert.deepEqual(orphans, [{ file: 'PerspectivePlanLoader.ts', line: 79, path: 'docs/perspectives/' }]);
  });
});

// Source-only guard contract — must be stripped from public package.json
// during outbound sync.
//
// Why: this guard hard-deps `sync-manifest.yaml`. The manifest is NOT
// exported to the public target. If the guard reference leaks into the
// public `pnpm check` chain, the public repo's `pnpm check` exits 2 on
// missing manifest (砚砚 R1 P1, dry-run reproduced 2026-06-25). The guard
// is part of our outbound sync harness, not clowder-ai runtime — it has
// no business running in the public target.
describe('sync-to-opensource.sh source-only guard contract', () => {
  it('lists check:sync-docs-runtime-assets in internalScripts (stripped from public)', () => {
    const syncScript = readFileSync(SYNC_SCRIPT_PATH, 'utf8');
    const match = syncScript.match(/const internalScripts = \[([\s\S]*?)\];/);
    assert.ok(match, 'internalScripts array not found in sync-to-opensource.sh');
    const arrayBody = match[1];
    assert.match(
      arrayBody,
      /["']check:sync-docs-runtime-assets["']/,
      'check:sync-docs-runtime-assets must be listed in internalScripts so the public package.json transform strips both the script definition and the pnpm check chain reference',
    );
  });
});
