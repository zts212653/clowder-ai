import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkCapabilityTipExportCoverage,
  checkCapabilityTipReferenceRegressions,
} from './check-sync-public-preflight.mjs';

const tempRoots = [];
const sourceRepoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC_OPENSOURCE_OPS_SKILL_FIXTURE = [
  '# Open Source Ops',
  '',
  '## Step 3: Maintainer 五问（仓库中立版）',
  '',
  'This fixture represents the transformed public SKILL.md, not the private transform source.',
  '',
].join('\n');

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'cc-sync-public-transform-'));
  tempRoots.push(root);
  return root;
}

function write(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeExporterTarget(root, target, source = 'source') {
  write(root, 'scripts/sync-to-opensource.sh', `cp "$STAGING_DIR/${source}" "$FILTERED_DIR/${target}"\n`);
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

function sourceTip(target) {
  const source = { path: target, anchor: 'Body anchor' };
  return { ...tip(target), sourceRef: source, structureSource: source };
}

function readWorkflowDecisionQueueTip() {
  const tips = JSON.parse(readFileSync(join(sourceRepoRoot, 'packages/web/src/lib/capability-tips.seed.json'), 'utf8'));
  const workflowTip = tips.find((entry) => entry?.id === 'workflow-community-decision-queue');
  assert.ok(workflowTip, 'expected workflow-community-decision-queue tip fixture');
  return JSON.parse(JSON.stringify(workflowTip));
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('capability-tip transform export coverage', () => {
  it('treats materialized transform targets as covered public export paths', () => {
    const root = makeRoot();
    const target = 'cat-cafe-skills/opensource-ops/SKILL.md';
    write(
      root,
      'sync-manifest.yaml',
      [
        'managed_roots:',
        'managed_files:',
        '  - packages/web/src/lib/capability-tips.seed.json',
        'managed_scripts:',
        'docs_generated:',
        'transforms:',
        `  - target: ${target}`,
        '    type: generate',
        'excluded:',
        '',
      ].join('\n'),
    );
    writeExporterTarget(root, target);
    write(root, 'packages/web/src/lib/capability-tips.seed.json', '[]');
    write(root, target, '# Body anchor\n');
    commitAll(root, 'baseline');

    write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify([sourceTip(target)]));

    const result = checkCapabilityTipExportCoverage(root, { baseRef: 'HEAD' });

    assert.equal(result.ok, true, result.errors.join('\n'));
  });

  it('rejects exact transform targets that the exporter does not materialize', () => {
    const root = makeRoot();
    const target = 'generated/public-only.md';
    write(
      root,
      'sync-manifest.yaml',
      [
        'managed_roots:',
        'managed_files:',
        '  - packages/web/src/lib/capability-tips.seed.json',
        'managed_scripts:',
        'docs_generated:',
        'transforms:',
        `  - target: ${target}`,
        '    type: generate',
        'excluded:',
        '',
      ].join('\n'),
    );
    write(root, 'packages/web/src/lib/capability-tips.seed.json', '[]');
    write(root, target, '# Body anchor\n');
    commitAll(root, 'baseline');

    write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify([sourceTip(target)]));

    const result = checkCapabilityTipExportCoverage(root, { baseRef: 'HEAD' });

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, [
      `feature-export-contract: bodySource newly points outside public export coverage ${target}`,
      `feature-export-contract: sourceRef newly points outside public export coverage ${target}`,
      `feature-export-contract: structureSource newly points outside public export coverage ${target}`,
    ]);
  });

  it('rejects transform targets only mentioned by comments or non-writing commands', () => {
    for (const syncScriptText of [
      '# generated/not-produced.md is intentionally not produced\n',
      'printf "%s\\n" "$FILTERED_DIR/generated/not-produced.md"\n',
      [
        'node - "$FILTERED_DIR/generated/not-produced.md" <<\'NODE\'',
        'const fs = require("node:fs");',
        'fs.readFileSync(process.argv[2], "utf8");',
        'NODE',
        '',
      ].join('\n'),
    ]) {
      const root = makeRoot();
      const target = 'generated/not-produced.md';
      write(
        root,
        'sync-manifest.yaml',
        [
          'managed_roots:',
          'managed_files:',
          '  - packages/web/src/lib/capability-tips.seed.json',
          'managed_scripts:',
          'docs_generated:',
          'transforms:',
          `  - target: ${target}`,
          '    type: generate',
          'excluded:',
          '',
        ].join('\n'),
      );
      write(root, 'scripts/sync-to-opensource.sh', syncScriptText);
      write(root, 'packages/web/src/lib/capability-tips.seed.json', '[]');
      write(root, target, '# Body anchor\n');
      commitAll(root, 'baseline');

      write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify([sourceTip(target)]));

      const result = checkCapabilityTipExportCoverage(root, { baseRef: 'HEAD' });

      assert.equal(result.ok, false);
      assert.deepEqual(result.errors, [
        `feature-export-contract: bodySource newly points outside public export coverage ${target}`,
        `feature-export-contract: sourceRef newly points outside public export coverage ${target}`,
        `feature-export-contract: structureSource newly points outside public export coverage ${target}`,
      ]);
    }
  });

  it('rejects exact transform targets under excluded directories', () => {
    const root = makeRoot();
    const target = 'private/generated/public.md';
    write(
      root,
      'sync-manifest.yaml',
      [
        'managed_roots:',
        'managed_files:',
        '  - packages/web/src/lib/capability-tips.seed.json',
        'managed_scripts:',
        'docs_generated:',
        'transforms:',
        `  - target: ${target}`,
        '    type: generate',
        'excluded:',
        '  - private/',
        '',
      ].join('\n'),
    );
    writeExporterTarget(root, target);
    write(root, 'packages/web/src/lib/capability-tips.seed.json', '[]');
    write(root, target, '# Body anchor\n');
    commitAll(root, 'baseline');

    write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify([sourceTip(target)]));

    const result = checkCapabilityTipExportCoverage(root, { baseRef: 'HEAD' });

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, [
      `feature-export-contract: bodySource newly points outside public export coverage ${target}`,
      `feature-export-contract: sourceRef newly points outside public export coverage ${target}`,
      `feature-export-contract: structureSource newly points outside public export coverage ${target}`,
    ]);
  });

  it('checks exact transform target anchors against the transformed public bytes', () => {
    const root = makeRoot();
    const target = 'cat-cafe-skills/opensource-ops/SKILL.md';
    write(
      root,
      'sync-manifest.yaml',
      [
        'managed_roots:',
        'managed_files:',
        '  - packages/web/src/lib/capability-tips.seed.json',
        'managed_scripts:',
        'docs_generated:',
        'transforms:',
        `  - target: ${target}`,
        '    type: generate',
        '    source: cat-cafe-skills/opensource-ops/SKILL.opensource.md',
        'excluded:',
        '  - cat-cafe-skills/opensource-ops/SKILL.opensource.md',
        '',
      ].join('\n'),
    );
    writeExporterTarget(root, target, 'cat-cafe-skills/opensource-ops/SKILL.opensource.md');
    write(root, 'docs/source.md', '# Source anchor\n');
    write(root, target, '# Baseline public body anchor\n');
    write(root, 'cat-cafe-skills/opensource-ops/SKILL.opensource.md', '# Baseline public body anchor\n');
    write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify([tip(target)]));
    commitAll(root, 'baseline public body source');

    const candidate = tip(target);
    candidate.bodySource = { path: target, anchor: 'Private-only body anchor' };
    write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify([candidate]));
    write(root, target, '# Private-only body anchor\n');
    write(root, 'cat-cafe-skills/opensource-ops/SKILL.opensource.md', '# Public portable body anchor\n');

    const result = checkCapabilityTipReferenceRegressions(root, { baseRef: 'HEAD' });

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, [
      `feature-export-contract: bodySource newly points to missing anchor ${target}#Private-only body anchor`,
    ]);
  });

  it('does not treat directory transform targets as blanket public export coverage', () => {
    const root = makeRoot();
    write(
      root,
      'sync-manifest.yaml',
      [
        'managed_roots:',
        'managed_files:',
        '  - packages/web/src/lib/capability-tips.seed.json',
        'managed_scripts:',
        'docs_generated:',
        'docs_decisions_allowlist:',
        '  - docs/decisions/001-public.md',
        'transforms:',
        '  - target: docs/decisions/',
        '    type: sanitize',
        'excluded:',
        '',
      ].join('\n'),
    );
    write(root, 'packages/web/src/lib/capability-tips.seed.json', '[]');
    write(root, 'docs/decisions/999-private.md', '# Body anchor\n');
    commitAll(root, 'baseline');

    const candidate = tip('docs/decisions/999-private.md');
    candidate.sourceRef.path = 'docs/decisions/999-private.md';
    candidate.structureSource.path = 'docs/decisions/999-private.md';
    write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify([candidate]));

    const result = checkCapabilityTipExportCoverage(root, { baseRef: 'HEAD' });

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, [
      'feature-export-contract: bodySource newly points outside public export coverage docs/decisions/999-private.md',
      'feature-export-contract: sourceRef newly points outside public export coverage docs/decisions/999-private.md',
      'feature-export-contract: structureSource newly points outside public export coverage docs/decisions/999-private.md',
    ]);
  });

  it('keeps workflow-community-decision-queue bodySource valid after opensource-ops public transform', () => {
    const root = makeRoot();
    const workflowTip = readWorkflowDecisionQueueTip();
    const baselineTip = {
      ...workflowTip,
      bodySource: { path: 'cat-cafe-skills/opensource-ops/SKILL.md', anchor: 'Baseline public body anchor' },
    };
    write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify([baselineTip]));
    write(root, 'cat-cafe-skills/opensource-ops/SKILL.md', '# Baseline public body anchor\n');
    commitAll(root, 'baseline public body source');

    write(root, 'packages/web/src/lib/capability-tips.seed.json', JSON.stringify([workflowTip]));
    write(root, 'cat-cafe-skills/opensource-ops/SKILL.md', PUBLIC_OPENSOURCE_OPS_SKILL_FIXTURE);

    const result = checkCapabilityTipReferenceRegressions(root, { baseRef: 'HEAD' });

    assert.equal(result.ok, true, result.errors.join('\n'));
  });
});
