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

// F332 F2 (2026-11-16): graph_resolve and list_recent became groups of the one find entry; the canonical
// sources now teach one entry plus the read entry, and must not route cats to the retired names.
const FULL_REQUIRED_PHRASES = ['cat_cafe_search_evidence', 'cat_cafe_read_memory', 'memory-routing-partial'];

const BRIEF_REQUIRED_PHRASES = ['search_evidence', 'read_memory', 'memory-routing-partial'];

const PARTIAL_PATH = 'cat-cafe-skills/refs/memory-routing-partial.md';

describe('F188 Phase F — harness-mismatch-canonical-sources fixture', () => {
  test('partial source-of-truth exists and teaches one find entry', () => {
    const full = join(ROOT, PARTIAL_PATH);
    assert.ok(existsSync(full), `partial missing: ${PARTIAL_PATH}`);
    const content = readFileSync(full, 'utf-8');
    assert.ok(content.includes('cat_cafe_search_evidence'));
    assert.ok(content.includes('cat_cafe_read_memory'));
    assert.ok(content.includes('not_covered'), 'partial keeps the coverage judgement');
    assert.equal(content.includes('cat_cafe_graph_resolve'), false); // mcp-cutover-negative-reference: absence
    assert.equal(content.includes('cat_cafe_list_recent'), false); // mcp-cutover-negative-reference: absence
  });

  for (const file of [...FULL_CANONICAL_SOURCES, ...BRIEF_CANONICAL_SOURCES]) {
    const phrases = FULL_CANONICAL_SOURCES.includes(file) ? FULL_REQUIRED_PHRASES : BRIEF_REQUIRED_PHRASES;
    test(`${file} teaches the one find entry, the read entry and the partial reference`, () => {
      const content = readFileSync(join(ROOT, file), 'utf-8');
      for (const phrase of phrases) {
        assert.ok(content.includes(phrase), `${file} missing required phrase: "${phrase}"`);
      }
      assert.equal(content.includes('三入口'), false, `${file} still routes by the retired three entries`);
    });
  }

  test('memory-navigation retired: its useful noise control lives in memory-search-best-practices', () => {
    const manifest = readFileSync(join(ROOT, 'cat-cafe-skills/manifest.yaml'), 'utf-8');
    assert.equal(manifest.includes('memory-navigation:'), false);
    assert.equal(existsSync(join(ROOT, 'cat-cafe-skills/memory-navigation/SKILL.md')), false);
    const search = readFileSync(join(ROOT, 'cat-cafe-skills/memory-search-best-practices/SKILL.md'), 'utf-8');
    assert.ok(search.includes('graphDepth'));
    assert.ok(search.includes('since='));
  });
});
