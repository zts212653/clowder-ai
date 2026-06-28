import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// ---------------------------------------------------------------------------
// D0.5 — DirectionCard route schema: shared runtime parse seam
//
// routeRecommendation shape must be validated in ONE shared place.
// API and web must NOT maintain divergent schemas.
// ---------------------------------------------------------------------------

const { parseRouteRecommendation } = await import('../dist/domains/community/community-route-recommendation.js');

describe('parseRouteRecommendation (D0.5)', () => {
  test('accepts valid existing-thread recommendation', () => {
    const result = parseRouteRecommendation({
      kind: 'existing-thread',
      threadId: 'thread-abc123',
    });
    assert.deepStrictEqual(result, {
      ok: true,
      value: { kind: 'existing-thread', threadId: 'thread-abc123' },
    });
  });

  test('accepts valid new-thread recommendation', () => {
    const result = parseRouteRecommendation({ kind: 'new-thread' });
    assert.deepStrictEqual(result, {
      ok: true,
      value: { kind: 'new-thread' },
    });
  });

  test('accepts valid decline recommendation', () => {
    const result = parseRouteRecommendation({ kind: 'decline' });
    assert.deepStrictEqual(result, {
      ok: true,
      value: { kind: 'decline' },
    });
  });

  test('rejects existing-thread without threadId', () => {
    const result = parseRouteRecommendation({ kind: 'existing-thread' });
    assert.equal(result.ok, false);
  });

  test('rejects existing-thread with empty threadId', () => {
    const result = parseRouteRecommendation({
      kind: 'existing-thread',
      threadId: '',
    });
    assert.equal(result.ok, false);
  });

  test('rejects unknown kind', () => {
    const result = parseRouteRecommendation({ kind: 'teleport' });
    assert.equal(result.ok, false);
  });

  test('rejects null input', () => {
    const result = parseRouteRecommendation(null);
    assert.equal(result.ok, false);
  });

  test('rejects undefined input', () => {
    const result = parseRouteRecommendation(undefined);
    assert.equal(result.ok, false);
  });

  test('rejects non-object input', () => {
    const result = parseRouteRecommendation('existing-thread');
    assert.equal(result.ok, false);
  });

  test('strips extra properties from valid input (no passthrough)', () => {
    const result = parseRouteRecommendation({
      kind: 'new-thread',
      extraField: 'should-be-ignored',
    });
    assert.equal(result.ok, true);
    assert.ok(!('extraField' in result.value), 'should strip unknown fields');
  });
});
