/**
 * F188 Phase F harness consistency — Regression Fixture
 * `harness-mismatch-canonical-sources` (砚砚 review P1-2)
 *
 * Verifies all canonical sources (CLAUDE.md / AGENTS.md / GEMINI.md /
 * OPENCODE.md) contain the three-entry routing partial. Prevents the
 * pre-Phase F state where only CLAUDE.md was updated and other cats'
 * canonical sources still pointed to search_evidence one-trick.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = (() => {
  // Walk up until we find a directory with .git
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== '/' && !existsSync(join(dir, '.git'))) {
    dir = dirname(dir);
  }
  return dir;
})();

const FULL_CANONICAL_SOURCES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];
const BRIEF_CANONICAL_SOURCES = ['OPENCODE.md'];

const FULL_REQUIRED_PHRASES = [
  '三入口',
  'cat_cafe_graph_resolve',
  'cat_cafe_list_recent',
  'cat_cafe_search_evidence',
  'memory-routing-partial',
];

const BRIEF_REQUIRED_PHRASES = ['graph_resolve', 'list_recent', 'search_evidence', 'memory-routing-partial'];

const PARTIAL_PATH = 'cat-cafe-skills/refs/memory-routing-partial.md';

describe('F188 Phase F — harness-mismatch-canonical-sources fixture', () => {
  test('partial source-of-truth exists', () => {
    const full = join(ROOT, PARTIAL_PATH);
    assert.ok(existsSync(full), `partial missing: ${PARTIAL_PATH}`);
    const content = readFileSync(full, 'utf-8');
    assert.ok(content.includes('cat_cafe_graph_resolve'));
    assert.ok(content.includes('cat_cafe_list_recent'));
    assert.ok(content.includes('cat_cafe_search_evidence'));
  });

  for (const file of FULL_CANONICAL_SOURCES) {
    test(`${file} contains 三入口路由 + all 3 entry tool names + partial reference`, () => {
      const content = readFileSync(join(ROOT, file), 'utf-8');
      for (const phrase of FULL_REQUIRED_PHRASES) {
        assert.ok(content.includes(phrase), `${file} missing required phrase: "${phrase}"`);
      }
    });
  }

  for (const file of BRIEF_CANONICAL_SOURCES) {
    test(`${file} (brief reference style) contains all 3 entry tool names + partial reference`, () => {
      const content = readFileSync(join(ROOT, file), 'utf-8');
      for (const phrase of BRIEF_REQUIRED_PHRASES) {
        assert.ok(content.includes(phrase), `${file} missing required phrase: "${phrase}"`);
      }
    });
  }

  test('memory-navigation skill registered in manifest', () => {
    const manifest = readFileSync(join(ROOT, 'cat-cafe-skills/manifest.yaml'), 'utf-8');
    assert.ok(manifest.includes('memory-navigation:'), 'manifest missing memory-navigation entry');
    assert.ok(manifest.includes('F188 Phase F'), 'manifest entry should reference F188 Phase F');
  });

  test('memory-navigation SKILL.md exists with key sections', () => {
    const skill = readFileSync(join(ROOT, 'cat-cafe-skills/memory-navigation/SKILL.md'), 'utf-8');
    assert.ok(skill.includes('When to load'));
    assert.ok(skill.includes('三入口决策树'));
    assert.ok(skill.includes('噪音控制'));
    assert.ok(skill.includes('KD-8') || skill.includes('隐私'));
  });
});
