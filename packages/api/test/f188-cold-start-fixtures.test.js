/**
 * F188 Phase F Cold-Start Fixture Validation — Regression Fixture
 * `cold-start/only-search-spike` (砚砚 一审 P1-4 derived)
 *
 * Verifies the gold-set fixture file exists with required structure:
 * 3 scenarios + baton event definition + N≥10 sample size guard.
 *
 * Actual eval run is a manual post-merge operation (instrumented dogfood
 * or mock cats). This test only validates the gold-set IS defined and
 * structured correctly so eval runner can consume it.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== '/' && !existsSync(join(dir, '.git'))) {
    dir = dirname(dir);
  }
  return dir;
})();

const FIXTURE_PATH = 'docs/eval/f188-phase-f-cold-start-fixtures.md';

describe('F188 Phase F — cold-start eval fixtures (AC-F8)', () => {
  let content;
  test('fixture file exists and has frontmatter', () => {
    assert.ok(existsSync(join(ROOT, FIXTURE_PATH)), `missing ${FIXTURE_PATH}`);
    content = readFileSync(join(ROOT, FIXTURE_PATH), 'utf-8');
    assert.ok(content.startsWith('---'), 'must have YAML frontmatter (ADR-011)');
    assert.ok(content.includes('feature_id: F188'));
    assert.ok(content.includes('doc_kind: eval-fixture'));
  });

  test('defines 3 cold-start scenarios', () => {
    content = readFileSync(join(ROOT, FIXTURE_PATH), 'utf-8');
    assert.ok(content.includes('## Scenario 1:'), 'Scenario 1 required');
    assert.ok(content.includes('## Scenario 2:'), 'Scenario 2 required');
    assert.ok(content.includes('## Scenario 3:'), 'Scenario 3 required');
  });

  test('each scenario has baseline trace + target with all 3 entries', () => {
    content = readFileSync(join(ROOT, FIXTURE_PATH), 'utf-8');
    // Each scenario should reference baseline OR target language
    for (const idx of [1, 2, 3]) {
      const re = new RegExp(`## Scenario ${idx}:[\\s\\S]+?Target turns-to-baton`);
      assert.ok(re.test(content), `Scenario ${idx} missing baseline→target structure`);
    }
    // All 3 entry tools mentioned somewhere
    assert.ok(content.includes('search_evidence'));
    assert.ok(content.includes('graph_resolve'));
    assert.ok(content.includes('list_recent'));
  });

  test('defines baton event sources (AS-2 baseline reproducibility)', () => {
    content = readFileSync(join(ROOT, FIXTURE_PATH), 'utf-8');
    assert.ok(content.includes('Baton 事件定义') || content.includes('Baton event'));
    assert.ok(content.includes('worklist registry'));
    assert.ok(content.includes('hold_ball') || content.includes('cat_cafe_hold_ball'));
    assert.ok(content.includes('git commit') || content.includes('PR action'));
  });

  test('declares N>=10 sample size guard (AC-F8)', () => {
    content = readFileSync(join(ROOT, FIXTURE_PATH), 'utf-8');
    assert.ok(/N\s*[≥>=]+\s*10/.test(content), 'must declare N≥10 cold-start session minimum');
  });

  test('declares 30% provisional threshold (KD-9)', () => {
    content = readFileSync(join(ROOT, FIXTURE_PATH), 'utf-8');
    assert.ok(content.includes('30%'), 'must reference 30% reduction target');
    assert.ok(content.includes('provisional'), 'must mark threshold as provisional');
  });
});
