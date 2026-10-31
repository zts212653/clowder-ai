/**
 * F200 HW-5: Recall@k fixture evaluation runner.
 *
 * Given a search function and a set of RecallFixture[], runs each query
 * and reports whether the expected anchor appears in the top-k results.
 *
 * [宪宪/Opus-46🐾]
 */

import type { RecallFixture } from './F209FixtureParser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  anchor: string;
  // P2 fix: score/rank/degraded are optional — runner only needs anchor
  score?: number;
  rank?: number;
  degraded?: boolean;
}

export interface SearchResponse {
  results: SearchResult[];
  effectiveMode: string;
  degraded: boolean;
}

export interface SearchOptions {
  mode?: string | null;
  scope?: string | null;
  depth?: string | null;
}

export type SearchFunction = (query: string, opts: SearchOptions) => Promise<SearchResponse>;

export interface FixtureResult {
  /** Fixture name */
  name: string;
  /** The query that was run */
  query: string;
  /** The expected anchor glob pattern */
  expectedAnchorPattern: string;
  /** Whether the expected anchor appeared in top-k */
  hit: boolean;
  /** 1-indexed rank of the first matching result, null on miss */
  rank: number | null;
  /** Search mode from fixture */
  mode: string | null;
  /** Search depth from fixture */
  depth: string | null;
  /** Whether the search degraded */
  degraded: boolean;
  /** Effective mode after potential degradation */
  effectiveMode: string;
}

export interface EvalSummary {
  total: number;
  hits: number;
  misses: number;
  /** hits / total, in [0, 1] */
  recallAtK: number;
  results: FixtureResult[];
  /** Number of drilldown fixtures excluded from recall@k */
  skippedDrilldown: number;
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Match an anchor string against a glob-like pattern.
 *
 * Supports `*` (match any characters). The pattern is matched against
 * the full anchor string (not substring). Non-glob patterns do an
 * exact prefix or full match.
 */
function matchesAnchorPattern(anchor: string, pattern: string): boolean {
  if (!pattern || !anchor) return false;

  // If pattern contains `*`, treat as glob
  if (pattern.includes('*')) {
    const regexStr = '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
    return new RegExp(regexStr).test(anchor);
  }

  // No glob — exact match
  return anchor === pattern;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class RecallFixtureRunner {
  private readonly searchFn: SearchFunction;

  constructor(searchFn: SearchFunction) {
    this.searchFn = searchFn;
  }

  /**
   * Evaluate a single fixture: run the query and check if the expected
   * anchor appears in the top-k results.
   */
  async evaluateFixture(fixture: RecallFixture, opts: { k: number }): Promise<FixtureResult> {
    const response = await this.searchFn(fixture.query, {
      mode: fixture.mode,
      scope: fixture.scope,
      depth: fixture.depth,
    });

    const topK = response.results.slice(0, opts.k);
    let hit = false;
    let rank: number | null = null;

    for (let i = 0; i < topK.length; i++) {
      if (matchesAnchorPattern(topK[i].anchor, fixture.expectedAnchorPattern)) {
        hit = true;
        rank = i + 1; // 1-indexed
        break;
      }
    }

    return {
      name: fixture.name,
      query: fixture.query,
      expectedAnchorPattern: fixture.expectedAnchorPattern,
      hit,
      rank,
      mode: fixture.mode,
      depth: fixture.depth,
      degraded: response.degraded,
      effectiveMode: response.effectiveMode,
    };
  }

  /**
   * Evaluate all fixtures and produce an aggregate summary.
   * Drilldown fixtures (kind='drilldown') are excluded from recall@k calculation.
   */
  async evaluateAll(fixtures: RecallFixture[], opts: { k: number }): Promise<EvalSummary> {
    const recallFixtures = fixtures.filter((f) => f.kind !== 'drilldown');
    const skippedDrilldown = fixtures.length - recallFixtures.length;

    const results: FixtureResult[] = [];
    for (const fixture of recallFixtures) {
      results.push(await this.evaluateFixture(fixture, opts));
    }

    const hits = results.filter((r) => r.hit).length;
    const misses = results.length - hits;

    return {
      total: results.length,
      hits,
      misses,
      recallAtK: results.length > 0 ? hits / results.length : 0,
      results,
      skippedDrilldown,
    };
  }
}
