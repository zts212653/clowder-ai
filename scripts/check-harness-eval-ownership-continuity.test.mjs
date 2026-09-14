import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';

import { findOwnershipContinuityViolations } from './lib/ownership-continuity.mjs';

const OWNERSHIP_PATH = 'docs/architecture/ownership/cells/harness-eval.md';
// co-creator chose the upstream owner for verdict publication (A): the fork's local
// artifact publisher is sunset and the git worktree publisher is the live one.
// This list is the inverse of the pre-refresh fork overlay on purpose.
const RETIRED_ANCHORS = [
  'packages/api/src/infrastructure/harness-eval/publish-verdict/local-artifact-publisher.ts',
  'scripts/check-verdict-publish-contract.mjs',
  // Retired by F257's own objective-driven redesign; absent on both lineages.
  'packages/api/src/infrastructure/harness-eval/evaluation/EvaluationScheduler.ts',
  'packages/api/src/infrastructure/harness-eval/evaluation/EvaluationSnapshotStore.ts',
  'packages/api/src/infrastructure/harness-eval/evaluation/MetricResultStore.ts',
  'packages/api/src/infrastructure/harness-eval/evaluation/evaluator-runner.ts',
];
const LIVE_GIT_PUBLISHER = 'packages/api/src/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.ts';
// Upstream flattened the source-ref validator out of its subdirectory; the refreshed
// overlay follows that layout, so base and overlay agree and nothing is relocated here.
const RELOCATED_CODE_ANCHORS = new Map([]);

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, 'ownership cell must have YAML frontmatter');
  return YAML.parse(match[1]);
}

test('detects dropped base ownership and dangling overlay anchors', () => {
  const base = {
    canonical_features: ['F192', 'F266'],
    code_anchors: ['base.ts'],
    doc_anchors: ['base.md'],
  };
  const overlay = {
    canonical_features: ['F192', 'F257'],
    code_anchors: ['overlay.ts', 'missing.ts'],
    doc_anchors: ['overlay.md'],
  };

  assert.deepEqual(
    findOwnershipContinuityViolations(base, overlay, {
      pathExists: (path) => path === 'overlay.ts',
    }),
    [
      'canonical_features dropped from base: F266',
      'code_anchors dropped from base: base.ts',
      'doc_anchors dropped from base: base.md',
      'code_anchors point to missing paths: missing.ts',
    ],
  );
});

test('F257 ownership overlay preserves origin/main except the explicit local-publisher sunset', () => {
  const base = parseFrontmatter(execFileSync('git', ['show', `origin/main:${OWNERSHIP_PATH}`], { encoding: 'utf8' }));
  const overlay = parseFrontmatter(readFileSync(OWNERSHIP_PATH, 'utf8'));
  const continuityBase = {
    ...base,
    code_anchors: base.code_anchors.filter(
      (anchor) => !RETIRED_ANCHORS.includes(anchor) && !RELOCATED_CODE_ANCHORS.has(anchor),
    ),
  };

  assert.deepEqual(findOwnershipContinuityViolations(continuityBase, overlay, { pathExists: existsSync }), []);
  assert.ok(overlay.canonical_features.includes('F257'));
  assert.ok(existsSync(LIVE_GIT_PUBLISHER), 'the chosen upstream publisher must exist');
  assert.ok(overlay.code_anchors.includes(LIVE_GIT_PUBLISHER), 'the chosen upstream publisher must stay owned');
  for (const retired of RETIRED_ANCHORS) {
    assert.ok(!existsSync(retired), `retired anchor must stay absent: ${retired}`);
    assert.ok(!overlay.code_anchors.includes(retired), `retired anchor must stay unowned: ${retired}`);
  }
  for (const relocated of RELOCATED_CODE_ANCHORS.values()) {
    assert.ok(existsSync(relocated), `relocated ownership anchor must exist: ${relocated}`);
    assert.ok(overlay.code_anchors.includes(relocated), `relocated ownership anchor must remain owned: ${relocated}`);
  }
  for (const required of [
    'packages/api/src/infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.ts',
    'packages/api/src/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.ts',
    'packages/api/src/infrastructure/harness-eval/publish-verdict/harness-ledger/harness-ledger-generator-adapter.ts',
  ]) {
    assert.ok(overlay.code_anchors.includes(required), `missing F257 ownership anchor: ${required}`);
  }
});
