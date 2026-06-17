/**
 * F200 HW-5: F209 Fixture Recall@k Wrapper
 *
 * Validates that F209 Phase A/B/C fixture files exist, are parseable,
 * and can be consumed by a recall@k evaluation runner.
 *
 * The runner itself is a typed utility that:
 * 1. Parses fixture markdown → structured RecallFixture[]
 * 2. Given a search function, runs each fixture query
 * 3. Computes recall@k (expected anchor in top-k?)
 * 4. Outputs summary per fixture
 *
 * [宪宪/Opus-46🐾]
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== '/' && !existsSync(join(dir, '.git'))) {
    dir = dirname(dir);
  }
  return dir;
})();

const FIXTURE_PATHS = [
  'docs/eval/f209-phase-a-raw-retrieval-fixtures.md',
  'docs/eval/f209-phase-b-entity-anchor-fixtures.md',
  'docs/eval/f209-phase-c-drilldown-fixtures.md',
];

describe('F200 HW-5: F209 fixture recall@k wrapper', () => {
  // --- Structural validation ---

  describe('fixture files exist and have correct frontmatter', () => {
    for (const path of FIXTURE_PATHS) {
      it(`${path} exists with eval-fixture frontmatter`, async () => {
        const fullPath = join(ROOT, path);
        assert.ok(existsSync(fullPath), `missing ${path}`);

        const { readFileSync } = await import('node:fs');
        const content = readFileSync(fullPath, 'utf-8');
        assert.ok(content.startsWith('---'), 'must have YAML frontmatter');
        assert.ok(content.includes('doc_kind: eval-fixture'), 'must be eval-fixture');
        assert.ok(content.includes('F209'), 'must reference F209');
        assert.ok(content.includes('F200'), 'must reference F200 as related');
      });
    }
  });

  // --- Parser validation ---

  describe('fixture parser extracts structured data', () => {
    it('parses Phase A fixtures into RecallFixture[]', async () => {
      const { parseF209Fixtures } = await import('../../dist/domains/memory/F209FixtureParser.js');
      const fixtures = parseF209Fixtures(join(ROOT, FIXTURE_PATHS[0]));

      assert.ok(Array.isArray(fixtures), 'must return array');
      assert.equal(fixtures.length, 2, 'Phase A has 2 fixtures');

      // Fixture 1: semantic raw
      const f1 = fixtures[0];
      assert.equal(f1.query, 'care logistics');
      assert.equal(f1.scope, 'threads');
      assert.equal(f1.mode, 'semantic');
      assert.equal(f1.depth, 'raw');
      // P1-1 fix: must extract glob pattern, not keep full sentence
      assert.equal(f1.expectedAnchorPattern, 'thread-*', 'must extract first backtick glob');
      assert.ok(f1.negativeGuard, 'must have negative guard');
      assert.equal(f1.phase, 'A');
      assert.ok(f1.name, 'must have fixture name');
      // P1-2 fix: recall fixtures have kind='recall'
      assert.equal(f1.kind, 'recall', 'fixture with explicit query is recall');

      // Fixture 2: hybrid raw
      const f2 = fixtures[1];
      assert.equal(f2.query, 'appointment');
      assert.equal(f2.mode, 'hybrid');
      assert.equal(f2.kind, 'recall', 'fixture with explicit query is recall');
    });

    it('parses Phase B fixtures into RecallFixture[]', async () => {
      const { parseF209Fixtures } = await import('../../dist/domains/memory/F209FixtureParser.js');
      const fixtures = parseF209Fixtures(join(ROOT, FIXTURE_PATHS[1]));

      assert.ok(Array.isArray(fixtures), 'must return array');
      assert.equal(fixtures.length, 3, 'Phase B has 3 fixtures');

      // Fixture 1: operator alias — has query but anchor has no glob → drilldown
      assert.equal(fixtures[0].query, 'operator');
      assert.equal(fixtures[0].mode, 'lexical');
      assert.equal(fixtures[0].kind, 'drilldown', 'F1 has query but non-glob anchor');

      // Fixture 2: raw entity hit — has query AND thread-* glob anchor → recall
      assert.equal(fixtures[1].kind, 'recall', 'F2 has query + glob anchor thread-*');

      // Fixture 3: private collection — has query but non-glob anchor → drilldown
      assert.equal(fixtures[2].kind, 'drilldown', 'F3 has query but non-glob anchor');
    });

    it('parses Phase C fixtures into RecallFixture[]', async () => {
      const { parseF209Fixtures } = await import('../../dist/domains/memory/F209FixtureParser.js');
      const fixtures = parseF209Fixtures(join(ROOT, FIXTURE_PATHS[2]));

      assert.ok(Array.isArray(fixtures), 'must return array');
      assert.equal(fixtures.length, 3, 'Phase C has 3 fixtures');

      // P1-2 Round 2 fix: fixture 1 has Search query but anchor has no glob → drilldown
      assert.equal(fixtures[0].kind, 'drilldown', 'fixture 1 has query but non-glob anchor');
      assert.equal(fixtures[0].query, 'care logistics');
      // Cloud review P2: multi-backtick anchor field must extract the glob, not first span
      assert.equal(fixtures[1].kind, 'drilldown', 'fixture 2 has no Search query');
      assert.equal(fixtures[1].expectedAnchorPattern, 'session-*', 'must extract glob from multi-backtick field');
      assert.equal(fixtures[2].kind, 'drilldown', 'fixture 3 has no Search query');
    });

    it('all fixtures have required fields', async () => {
      const { parseF209Fixtures } = await import('../../dist/domains/memory/F209FixtureParser.js');

      for (const path of FIXTURE_PATHS) {
        const fixtures = parseF209Fixtures(join(ROOT, path));
        for (const f of fixtures) {
          assert.ok(f.name, `fixture in ${path} missing name`);
          assert.ok(f.phase, `fixture ${f.name} missing phase`);
          assert.ok(f.expectedAnchorPattern, `fixture ${f.name} missing expectedAnchorPattern`);
          assert.ok(f.kind === 'recall' || f.kind === 'drilldown', `fixture ${f.name} must have kind`);
          // recall fixtures must have query; drilldown fixtures use name as fallback
          if (f.kind === 'recall') {
            assert.ok(f.query, `recall fixture ${f.name} missing query`);
          }
        }
      }
    });
  });

  // --- Recall@k runner validation ---

  describe('recall@k runner computes metrics from mock search', () => {
    it('reports hit when expected anchor appears in top-k', async () => {
      const { RecallFixtureRunner } = await import('../../dist/domains/memory/RecallFixtureRunner.js');

      // P2 fix: minimal contract — only anchor required per result
      const mockSearch = async (_query, opts) => ({
        results: [{ anchor: 'thread-abc' }, { anchor: 'F042' }],
        effectiveMode: opts.mode,
        degraded: false,
      });

      const fixture = {
        name: 'test-fixture',
        query: 'care logistics',
        scope: 'threads',
        mode: 'semantic',
        depth: 'raw',
        phase: 'A',
        kind: 'recall',
        expectedAnchorPattern: 'thread-*',
        negativeGuard: null,
      };

      const runner = new RecallFixtureRunner(mockSearch);
      const result = await runner.evaluateFixture(fixture, { k: 5 });

      assert.equal(result.hit, true, 'should hit — thread-abc matches thread-*');
      assert.equal(result.rank, 1, 'rank is 1-indexed position');
      assert.equal(result.query, 'care logistics');
      assert.equal(result.mode, 'semantic');
      assert.equal(result.depth, 'raw');
      assert.equal(result.degraded, false);
      assert.equal(result.effectiveMode, 'semantic');
    });

    it('reports miss when expected anchor not in top-k', async () => {
      const { RecallFixtureRunner } = await import('../../dist/domains/memory/RecallFixtureRunner.js');

      const mockSearch = async () => ({
        results: [{ anchor: 'F042' }, { anchor: 'F043' }],
        effectiveMode: 'lexical',
        degraded: false,
      });

      const fixture = {
        name: 'miss-fixture',
        query: 'operator',
        scope: 'docs',
        mode: 'lexical',
        depth: 'summary',
        phase: 'B',
        kind: 'recall',
        expectedAnchorPattern: 'thread-*',
        negativeGuard: null,
      };

      const runner = new RecallFixtureRunner(mockSearch);
      const result = await runner.evaluateFixture(fixture, { k: 5 });

      assert.equal(result.hit, false, 'no thread-* anchor in results');
      assert.equal(result.rank, null, 'rank is null on miss');
    });

    it('evaluateAll runs recall fixtures and excludes drilldown from recall@k', async () => {
      const { RecallFixtureRunner } = await import('../../dist/domains/memory/RecallFixtureRunner.js');

      const mockSearch = async () => ({
        results: [{ anchor: 'thread-123' }],
        effectiveMode: 'hybrid',
        degraded: false,
      });

      const fixtures = [
        {
          name: 'fix-1',
          query: 'q1',
          scope: 'threads',
          mode: 'hybrid',
          depth: 'raw',
          phase: 'A',
          kind: 'recall',
          expectedAnchorPattern: 'thread-*',
          negativeGuard: null,
        },
        {
          name: 'fix-2',
          query: 'q2',
          scope: 'docs',
          mode: 'lexical',
          depth: 'summary',
          phase: 'B',
          kind: 'recall',
          expectedAnchorPattern: 'F*',
          negativeGuard: null,
        },
        {
          name: 'drill-1',
          query: 'Session Result Points To Invocation Detail Chain',
          scope: null,
          mode: null,
          depth: null,
          phase: 'C',
          kind: 'drilldown',
          expectedAnchorPattern: 'session-*',
          negativeGuard: null,
        },
      ];

      const runner = new RecallFixtureRunner(mockSearch);
      const summary = await runner.evaluateAll(fixtures, { k: 5 });

      // Drilldown fixture excluded from recall@k denominator
      assert.equal(summary.total, 2, 'only recall fixtures count');
      assert.equal(summary.hits, 1, 'only fix-1 hits (thread-*)');
      assert.equal(summary.misses, 1, 'fix-2 misses (no F* match)');
      assert.ok(summary.recallAtK >= 0 && summary.recallAtK <= 1);
      assert.equal(summary.recallAtK, 0.5, 'recall@k = 1/2');
      assert.equal(summary.results.length, 2, 'drilldown excluded from results');
      assert.equal(summary.skippedDrilldown, 1, 'reports skipped drilldown count');
      // Each result has the required fields from HW-5 spec
      for (const r of summary.results) {
        assert.ok('query' in r);
        assert.ok('expectedAnchorPattern' in r);
        assert.ok('hit' in r);
        assert.ok('rank' in r);
        assert.ok('mode' in r);
        assert.ok('depth' in r);
        assert.ok('degraded' in r);
        assert.ok('effectiveMode' in r);
      }
    });
  });
});
