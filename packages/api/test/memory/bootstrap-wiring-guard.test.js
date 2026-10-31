/**
 * REGRESSION GUARD: getKindCoverage wiring in index.ts
 *
 * getKindCoverage has been accidentally deleted from index.ts THREE TIMES
 * by intake/merge PRs (#1122, #1147). Each time, the bootstrap service
 * tests still passed because they mock the dep. This source-level guard
 * catches the deletion at test time.
 *
 * If this test fails, someone removed getKindCoverage from the bootstrap
 * service wiring in index.ts. DO NOT delete this test — restore the wiring.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('bootstrap wiring guard (regression)', () => {
  const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf-8');

  it('index.ts wires getKindCoverage to ExpeditionBootstrapService', () => {
    assert.ok(
      source.includes('getKindCoverage'),
      'REGRESSION: getKindCoverage must be wired in index.ts — deleted 3x by intake PRs (#1122, #1147). Restore it.',
    );
  });

  it('index.ts wires isSameRepo for worktree-aware path guards', () => {
    assert.ok(
      source.includes('isSameRepo'),
      'REGRESSION: isSameRepo must be imported in index.ts — reverted by intake PR #1147. Restore it.',
    );
  });
});
