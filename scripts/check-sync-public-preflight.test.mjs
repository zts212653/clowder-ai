import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  checkCapabilityTipExportCoverage,
  checkCapabilityTipReferenceRegressions,
  checkPublicPackageScriptClosure,
  checkSyncPublicPreflight,
} from './check-sync-public-preflight.mjs';
import { isCoveredByPublicExport, loadPublicExportCoverage } from './lib/sync-public-export-coverage.mjs';

const tempRoots = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'cc-sync-public-preflight-'));
  tempRoots.push(root);
  return root;
}

function write(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function commitAll(root, message) {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'preflight@test.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Preflight Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', message], { cwd: root });
}

function tip(bodyPath) {
  return {
    id: 'feature-export-contract',
    kind: 'status_help',
    sourceRef: { path: 'docs/source.md', anchor: 'Source anchor' },
    structureSource: { path: 'docs/source.md', anchor: 'Source anchor' },
    bodySource: { path: bodyPath, anchor: 'Body anchor' },
    contexts: ['feature_dev'],
    audience: ['developer'],
    body: 'Explain the exported contract truthfully.',
    owner: 'sync',
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('public package script closure', () => {
  it('rejects a declared workspace dependency missing from the uninstalled export', () => {
    const root = makeRoot();
    write(root, 'package.json', JSON.stringify({ scripts: {} }));
    write(root, 'packages/web/src/lib/capability-tips.seed.json', '[]');
    write(root, 'packages/shared/package.json', JSON.stringify({ name: '@cat-cafe/shared' }));
    write(
      root,
      'packages/collective-client/package.json',
      readFileSync(new URL('../packages/collective-client/package.json', import.meta.url), 'utf8'),
    );
    commitAll(root, 'export missing the Collective client UI dependency');
    const missing = checkSyncPublicPreflight(root, { baseRef: 'HEAD' });
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.errors, [
      'packages/collective-client/package.json:dependencies -> missing workspace package @cat-cafe/ui',
    ]);
    write(root, 'packages/ui/package.json', JSON.stringify({ name: '@cat-cafe/ui' }));
    assert.equal(checkSyncPublicPreflight(root, { baseRef: 'HEAD' }).ok, true);
  });

  it('exports the UI package consumed by the real Collective client', () => {
    const repoRoot = join(import.meta.dirname, '..');
    const coverage = loadPublicExportCoverage(repoRoot);
    for (const path of ['packages/ui/package.json', 'packages/ui/src/index.ts']) {
      assert.ok(existsSync(join(repoRoot, path)), `UI entrypoint is present: ${path}`);
      // The source allowlist is private; a public checkout checks delivered files.
      if (coverage !== null) assert.ok(isCoveredByPublicExport(path, coverage));
    }
  });

  it('rejects the actual exported pre-commit hook when its Node companion is missing', () => {
    const root = makeRoot();
    write(root, 'package.json', JSON.stringify({ scripts: {} }));
    write(root, 'packages/web/src/lib/capability-tips.seed.json', '[]');
    const hook = readFileSync(new URL('../.githooks/pre-commit', import.meta.url), 'utf8');
    write(root, '.githooks/pre-commit', hook);
    write(root, 'scripts/intake-from-opensource.sh', '#!/bin/bash\n');
    write(root, 'scripts/brand-dictionary-helper.mjs', 'export {};\n');
    commitAll(root, 'hook without companion');
    const missing = checkSyncPublicPreflight(root, { baseRef: 'HEAD' });
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.errors, ['.githooks/pre-commit -> missing scripts/materialize-biome-index-snapshot.mjs']);
    write(root, 'scripts/materialize-biome-index-snapshot.mjs', 'export {};\n');
    assert.equal(checkSyncPublicPreflight(root, { baseRef: 'HEAD' }).ok, true);
  });

  it('runs the actual preflight CLI before dependency installation and still rejects missing companions', () => {
    const root = makeRoot();
    for (const file of [
      'check-sync-public-preflight.mjs',
      'project-public-dead-links.mjs',
      'check-capability-tips.mjs',
      'lib/sync-public-export-coverage.mjs',
      'lib/sync-public-workspace-closure.mjs',
    ]) {
      write(root, `scripts/${file}`, readFileSync(new URL(file, import.meta.url), 'utf8'));
    }
    write(root, 'package.json', JSON.stringify({ scripts: {} }));
    write(root, 'packages/web/src/lib/capability-tips.seed.json', '[]');
    write(
      root,
      '.github/workflows/ci.yml',
      '# Retired: .github/scripts/old.mjs\njobs:\n  test:\n    steps:\n      - run: |\n          node .github/scripts/proof.mjs\n',
    );
    commitAll(root, 'uninstalled candidate');
    const run = () =>
      spawnSync(process.execPath, ['scripts/check-sync-public-preflight.mjs', '--repo-root', root], {
        cwd: root,
        env: { ...process.env, NODE_PATH: '' },
        encoding: 'utf8',
      });
    const missing = run();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /ci\.yml -> missing \.github\/scripts\/proof\.mjs/);
    write(root, '.github/scripts/proof.mjs', 'export {};\n');
    const present = run();
    assert.equal(present.status, 0, present.stderr);
    assert.match(present.stdout, /PASS sync public preflight/);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell input, not JavaScript interpolation
    write(root, '.githooks/pre-commit', 'node "$(dirname "${BASH_SOURCE[0]}")/../scripts/hook-proof.mjs"\n');
    const missingHook = run();
    assert.equal(missingHook.status, 1);
    assert.match(missingHook.stderr, /pre-commit -> missing scripts\/hook-proof\.mjs/);
    write(root, 'scripts/hook-proof.mjs', 'export {};\n');
    assert.equal(run().status, 0);
  });

  it('checks literal hook companions without treating comment-only or dynamic paths as closure', () => {
    const root = makeRoot();
    write(root, 'package.json', JSON.stringify({ scripts: {} }));
    write(root, 'packages/web/src/lib/capability-tips.seed.json', '[]');
    write(
      root,
      '.githooks/pre-commit',
      ['# retired: node scripts/old.mjs', 'node "$REPO_ROOT/scripts/helper.mjs"', 'node "$DYNAMIC_HELPER"'].join('\n'),
    );
    commitAll(root, 'hook literal companion');
    assert.deepEqual(checkSyncPublicPreflight(root, { baseRef: 'HEAD' }).errors, [
      '.githooks/pre-commit -> missing scripts/helper.mjs',
    ]);
    write(root, 'scripts/helper.mjs', 'export {};\n');
    assert.equal(checkSyncPublicPreflight(root, { baseRef: 'HEAD' }).ok, true);
    write(root, '.githooks/pre-commit', 'node "../../scripts/helper.mjs"\n');
    assert.deepEqual(checkSyncPublicPreflight(root, { baseRef: 'HEAD' }).errors, [
      '.githooks/pre-commit -> outside export root ../../scripts/helper.mjs',
    ]);
    write(root, '.githooks/pre-commit', 'node scripts/../../outside.mjs\n');
    assert.deepEqual(checkSyncPublicPreflight(root, { baseRef: 'HEAD' }).errors, [
      '.githooks/pre-commit -> outside export root scripts/../../outside.mjs',
    ]);
  });

  it('rejects a preserved CI workflow whose companion script was lost during export', () => {
    const root = makeRoot();
    write(root, 'package.json', JSON.stringify({ scripts: {} }));
    write(root, 'packages/web/src/lib/capability-tips.seed.json', '[]');
    write(
      root,
      '.github/workflows/ci.yml',
      'jobs:\n  test:\n    steps:\n      - run: node .github/scripts/proof.test.mjs\n',
    );
    commitAll(root, 'preserved workflow');
    const result = checkSyncPublicPreflight(root, { baseRef: 'HEAD' });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, ['.github/workflows/ci.yml -> missing .github/scripts/proof.test.mjs']);
    write(root, '.github/scripts/proof.test.mjs', 'export {};\n');
    assert.equal(checkSyncPublicPreflight(root, { baseRef: 'HEAD' }).ok, true);
  });

  it('rejects a root package command whose local script target is absent', () => {
    const root = makeRoot();
    write(root, 'package.json', JSON.stringify({ scripts: { check: 'node scripts/missing-check.mjs' } }));

    const result = checkPublicPackageScriptClosure(root);

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, ['package.json:check -> missing scripts/missing-check.mjs']);
  });

  it('accepts exact local targets and ignores glob expressions delegated to their command', () => {
    const root = makeRoot();
    write(root, 'package.json', JSON.stringify({ scripts: { check: 'node scripts/check.mjs scripts/**/*.test.mjs' } }));
    write(root, 'scripts/check.mjs', 'export {};\n');

    const result = checkPublicPackageScriptClosure(root);

    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('rejects a script path that escapes the exported repository root', () => {
    const root = makeRoot();
    const outsideRoot = makeRoot();
    const escapedPath = `scripts/../../${basename(outsideRoot)}/outside.mjs`;
    write(outsideRoot, 'outside.mjs', 'export {};\n');
    write(root, 'package.json', JSON.stringify({ scripts: { check: `node ${escapedPath}` } }));

    const result = checkPublicPackageScriptClosure(root);

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, [`package.json:check -> outside export root ${escapedPath}`]);
  });
});

describe('public provenance-only contribution coverage', () => {
  const file = 'docs/features/F999-provenance.md';
  const sourceId = '0001700000000000-000042-deadbeef';
  function setup(exemption = '') {
    const root = makeRoot();
    write(root, 'package.json', JSON.stringify({ scripts: {} }));
    write(root, 'packages/web/src/lib/capability-tips.seed.json', '[]');
    const baseline = `---\nfeature_ids: [F999]\n${exemption}---\n# Existing capability\nSource: ${sourceId}\n`;
    write(root, file, baseline);
    commitAll(root, 'baseline provenance');
    return { root, baseline };
  }

  it('does not ask for a new tip or renewed exemption for exact outbound redaction alone', () => {
    for (const exemption of ['', 'tips_exempt: internal maintenance\n']) {
      const { root, baseline } = setup(exemption);
      write(root, file, baseline.replace(sourceId, 'private-source-id'));
      const result = checkSyncPublicPreflight(root, { baseRef: 'HEAD', changedFiles: [file] });
      assert.equal(result.ok, true, result.errors.join('\n'));
      assert.deepEqual(result.provenanceOnlyChanges, [file]);
    }
  });

  it('still requires coverage for a real contribution beside redaction or a newly added document', () => {
    const { root, baseline } = setup('tips_exempt: internal maintenance\n');
    write(root, file, baseline.replace(sourceId, 'private-source-id') + 'New user action: publish a report.\n');
    let result = checkSyncPublicPreflight(root, { baseRef: 'HEAD', changedFiles: [file] });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /unchanged tips_exempt/);
    assert.deepEqual(result.provenanceOnlyChanges, []);
    const added = 'docs/features/F998-new.md';
    write(root, added, '# New capability\nSource: private-source-id\n');
    result = checkSyncPublicPreflight(root, { baseRef: 'HEAD', changedFiles: [added] });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /missing capability tip/);
  });

  it('does not exempt raw ID substitutions, unrelated formatting or unresolvable baselines', () => {
    const { root, baseline } = setup('tips_exempt: internal maintenance\n');
    for (const candidate of [
      baseline.replace(sourceId, '0001700000000001-000043-cafebabe'),
      baseline.replace(sourceId, 'private-source-id') + '\n',
    ]) {
      write(root, file, candidate);
      assert.equal(checkSyncPublicPreflight(root, { baseRef: 'HEAD', changedFiles: [file] }).ok, false);
    }
    write(root, file, baseline.replace(sourceId, 'private-source-id'));
    assert.equal(checkSyncPublicPreflight(root, { baseRef: 'missing-base', changedFiles: [file] }).ok, false);
  });
});

describe('capability-tip export reference regressions', () => {
  it('uses the explicit aggregate baseRef for export coverage comparisons', () => {
    const root = makeRoot();
    write(root, 'package.json', JSON.stringify({ scripts: {} }));
    write(
      root,
      'sync-manifest.yaml',
      [
        'managed_roots:',
        'managed_files:',
        '  - packages/web/src/lib/capability-tips.seed.json',
        'managed_scripts:',
        'docs_generated:',
        'excluded:',
        '',
      ].join('\n'),
    );
    write(root, 'packages/web/src/lib/capability-tips.seed.json', '[]');
    commitAll(root, 'baseline without origin/main');

    const result = checkSyncPublicPreflight(root, { baseRef: 'HEAD' });

    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('requires every source of a newly introduced tip to be covered by the candidate export contract', () => {
    const root = makeRoot();
    write(
      root,
      'sync-manifest.yaml',
      [
        'managed_roots:',
        '  - packages/api',
        'managed_files:',
        '  - packages/web/src/lib/capability-tips.seed.json',
        'managed_scripts:',
        'docs_generated:',
        '  - target: docs/features/',
        '    type: script',
        'excluded:',
        '  - docs/taste/',
        '',
      ].join('\n'),
    );
    write(root, 'packages/web/src/lib/capability-tips.seed.json', '[]');
    write(root, 'docs/internal-source.md', '# Source anchor\n');
    write(root, 'docs/internal-structure.md', '# Source anchor\n');
    write(root, 'docs/taste/vignettes/internal-body.md', '# Body anchor\n');
    commitAll(root, 'baseline');

    const candidate = tip('docs/taste/vignettes/internal-body.md');
    candidate.sourceRef.path = 'docs/internal-source.md';
    candidate.structureSource.path = 'docs/internal-structure.md';
    write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify([candidate]));

    const result = checkCapabilityTipExportCoverage(root, { baseRef: 'HEAD' });

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, [
      'feature-export-contract: bodySource newly points outside public export coverage docs/taste/vignettes/internal-body.md',
      'feature-export-contract: sourceRef newly points outside public export coverage docs/internal-source.md',
      'feature-export-contract: structureSource newly points outside public export coverage docs/internal-structure.md',
    ]);
  });

  it('accepts every source of a newly introduced tip when the export contract covers them', () => {
    const root = makeRoot();
    write(
      root,
      'sync-manifest.yaml',
      [
        'managed_roots:',
        '  - packages/api',
        'managed_files:',
        '  - packages/web/src/lib/capability-tips.seed.json',
        'managed_scripts:',
        'docs_generated:',
        '  - target: docs/features/',
        '    type: script',
        'excluded:',
        '  - docs/taste/',
        '',
      ].join('\n'),
    );
    write(root, 'packages/web/src/lib/capability-tips.seed.json', '[]');
    write(root, 'docs/features/F999.md', '# Source anchor\n# Body anchor\n');
    write(root, 'packages/api/src/feature.ts', 'export const Source = true;\n');
    commitAll(root, 'baseline');

    const candidate = tip('docs/features/F999.md');
    candidate.sourceRef.path = 'docs/features/F999.md';
    candidate.structureSource = { path: 'packages/api/src/feature.ts', anchor: 'Source' };
    write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify([candidate]));

    const result = checkCapabilityTipExportCoverage(root, { baseRef: 'HEAD' });

    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('fails closed when a source checkout has no public-export comparison baseline', () => {
    const root = makeRoot();
    write(
      root,
      'sync-manifest.yaml',
      [
        'managed_roots:',
        '  - packages/api',
        'managed_files:',
        'managed_scripts:',
        'docs_generated:',
        'excluded:',
        '',
      ].join('\n'),
    );
    write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify([tip('docs/internal-body.md')]));
    commitAll(root, 'candidate without origin/main');

    const result = checkCapabilityTipExportCoverage(root);

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /unavailable at baseline origin\/main/);
  });

  it('blocks a newly changed bodySource that is absent from the candidate export', () => {
    const root = makeRoot();
    write(root, 'docs/source.md', '# Source anchor\n');
    write(root, 'docs/body.md', '# Body anchor\n');
    write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify([tip('docs/body.md')]));
    commitAll(root, 'baseline');

    const candidate = JSON.parse(readFileSync(join(root, 'packages/web/src/lib/capability-tips.seed.json'), 'utf8'));
    candidate[0].bodySource = { path: 'docs/internal-only.md', anchor: 'Body anchor' };
    write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify(candidate));

    const result = checkCapabilityTipReferenceRegressions(root);

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /feature-export-contract: bodySource newly points to missing path/);
  });

  it('does not turn an unchanged baseline warning into a new release blocker', () => {
    const root = makeRoot();
    write(root, 'docs/source.md', '# Source anchor\n');
    write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify([tip('docs/legacy-internal.md')]));
    commitAll(root, 'baseline');

    const result = checkCapabilityTipReferenceRegressions(root);

    assert.equal(result.ok, true, result.errors.join('\n'));
  });
});
