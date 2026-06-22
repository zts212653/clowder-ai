import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveTriageConfidence } from '../dist/types/community-issue.js';

/**
 * F168 Phase F — deriveTriageConfidence pure function tests
 *
 * INV-F1: deriveTriageConfidence is a pure function, no side effects, no store reads.
 *
 * High confidence requires ALL of:
 *   1. routeRecommendation.kind === 'existing-thread' (knows where to go)
 *   2. verdict === 'WELCOME' (direction confirmed)
 *   3. All questions are PASS or WARN (no FAIL/UNKNOWN)
 *
 * Everything else → low.
 */

/** Helper: build a minimal TriageEntry with defaults for high confidence */
function makeEntry(overrides = {}) {
  return {
    catId: 'codex',
    verdict: 'WELCOME',
    questions: [
      { id: 'Q1', result: 'PASS' },
      { id: 'Q2', result: 'PASS' },
      { id: 'Q3', result: 'PASS' },
      { id: 'Q4', result: 'PASS' },
      { id: 'Q5', result: 'PASS' },
    ],
    timestamp: Date.now(),
    routeRecommendation: { kind: 'existing-thread', threadId: 'thread_abc123' },
    ...overrides,
  };
}

describe('deriveTriageConfidence', () => {
  // --- HIGH confidence cases ---

  it('returns high when all conditions met (5Q PASS + WELCOME + existing-thread)', () => {
    const entry = makeEntry();
    assert.equal(deriveTriageConfidence(entry), 'high');
  });

  it('returns high when questions mix PASS and WARN (no FAIL/UNKNOWN)', () => {
    const entry = makeEntry({
      questions: [
        { id: 'Q1', result: 'PASS' },
        { id: 'Q2', result: 'WARN' },
        { id: 'Q3', result: 'PASS' },
        { id: 'Q4', result: 'WARN' },
        { id: 'Q5', result: 'PASS' },
      ],
    });
    assert.equal(deriveTriageConfidence(entry), 'high');
  });

  it('returns high when all questions are WARN', () => {
    const entry = makeEntry({
      questions: [
        { id: 'Q1', result: 'WARN' },
        { id: 'Q2', result: 'WARN' },
        { id: 'Q3', result: 'WARN' },
        { id: 'Q4', result: 'WARN' },
        { id: 'Q5', result: 'WARN' },
      ],
    });
    assert.equal(deriveTriageConfidence(entry), 'high');
  });

  // --- LOW confidence cases ---

  it('returns low when any question is FAIL', () => {
    const entry = makeEntry({
      questions: [
        { id: 'Q1', result: 'PASS' },
        { id: 'Q2', result: 'FAIL' },
        { id: 'Q3', result: 'PASS' },
        { id: 'Q4', result: 'PASS' },
        { id: 'Q5', result: 'PASS' },
      ],
    });
    assert.equal(deriveTriageConfidence(entry), 'low');
  });

  it('returns low when any question is UNKNOWN', () => {
    const entry = makeEntry({
      questions: [
        { id: 'Q1', result: 'PASS' },
        { id: 'Q2', result: 'PASS' },
        { id: 'Q3', result: 'UNKNOWN' },
        { id: 'Q4', result: 'PASS' },
        { id: 'Q5', result: 'PASS' },
      ],
    });
    assert.equal(deriveTriageConfidence(entry), 'low');
  });

  it('returns low when verdict is NEEDS-DISCUSSION', () => {
    const entry = makeEntry({ verdict: 'NEEDS-DISCUSSION' });
    assert.equal(deriveTriageConfidence(entry), 'low');
  });

  it('returns low when verdict is POLITELY-DECLINE', () => {
    const entry = makeEntry({ verdict: 'POLITELY-DECLINE' });
    assert.equal(deriveTriageConfidence(entry), 'low');
  });

  it('returns low when routeRecommendation is new-thread', () => {
    const entry = makeEntry({
      routeRecommendation: { kind: 'new-thread' },
    });
    assert.equal(deriveTriageConfidence(entry), 'low');
  });

  it('returns low when routeRecommendation is decline', () => {
    const entry = makeEntry({
      routeRecommendation: { kind: 'decline' },
    });
    assert.equal(deriveTriageConfidence(entry), 'low');
  });

  // --- Edge cases ---

  it('returns low when routeRecommendation is undefined', () => {
    const entry = makeEntry({ routeRecommendation: undefined });
    assert.equal(deriveTriageConfidence(entry), 'low');
  });

  it('returns low when questions array is empty', () => {
    const entry = makeEntry({ questions: [] });
    assert.equal(deriveTriageConfidence(entry), 'low');
  });

  it('returns low when questions is undefined', () => {
    const { questions, ...rest } = makeEntry();
    assert.equal(deriveTriageConfidence(rest), 'low');
  });
});
