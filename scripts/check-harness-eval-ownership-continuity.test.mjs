import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';

import { findOwnershipContinuityViolations } from './lib/ownership-continuity.mjs';

const OWNERSHIP_PATH = 'docs/architecture/ownership/cells/harness-eval.md';
const RETIRED_GIT_PUBLICATION_ANCHORS = [
  'packages/api/src/infrastructure/harness-eval/publish-verdict/git-worktree-publisher.ts',
  'scripts/check-verdict-publish-contract.mjs',
];
const LOCAL_ARTIFACT_PUBLISHER =
  'packages/api/src/infrastructure/harness-eval/publish-verdict/local-artifact-publisher.ts';

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

test('F257 ownership overlay preserves origin/main except the explicit Git-publication sunset', () => {
  const base = parseFrontmatter(execFileSync('git', ['show', `origin/main:${OWNERSHIP_PATH}`], { encoding: 'utf8' }));
  const overlay = parseFrontmatter(readFileSync(OWNERSHIP_PATH, 'utf8'));
  const continuityBase = {
    ...base,
    code_anchors: base.code_anchors.filter((anchor) => !RETIRED_GIT_PUBLICATION_ANCHORS.includes(anchor)),
  };

  assert.deepEqual(findOwnershipContinuityViolations(continuityBase, overlay, { pathExists: existsSync }), []);
  assert.ok(overlay.canonical_features.includes('F257'));
  assert.ok(overlay.code_anchors.includes(LOCAL_ARTIFACT_PUBLISHER));
  for (const retired of RETIRED_GIT_PUBLICATION_ANCHORS) {
    assert.ok(!existsSync(retired), `retired Git-publication anchor must stay absent: ${retired}`);
    assert.ok(!overlay.code_anchors.includes(retired), `retired Git-publication anchor must stay unowned: ${retired}`);
  }
  for (const required of [
    'packages/api/src/infrastructure/harness-eval/evaluation/EvaluationScheduler.ts',
    'packages/api/src/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.ts',
    'packages/api/src/infrastructure/harness-eval/publish-verdict/harness-ledger-generator-adapter.ts',
  ]) {
    assert.ok(overlay.code_anchors.includes(required), `missing F257 ownership anchor: ${required}`);
  }
});
