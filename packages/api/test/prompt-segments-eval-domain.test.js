/**
 * F257 Phase A Line B — eval:harness-ledger domain registration tests
 *
 * Verifies: prompt-segments in KNOWN_SOURCE_REFS_KINDS, discriminator,
 * structural validator, inferSourceRefsKind dispatch.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { isKnownSourceRefsKind, isPromptSegmentsSourceRefs, validatePromptSegmentsSelector, inferSourceRefsKind } =
  await import('../dist/infrastructure/harness-eval/publish-verdict/validation.js');

describe('eval:harness-ledger domain registration', () => {
  describe('KNOWN_SOURCE_REFS_KINDS', () => {
    test('includes prompt-segments', () => {
      assert.ok(isKnownSourceRefsKind('prompt-segments'));
    });
  });

  describe('isPromptSegmentsSourceRefs', () => {
    test('returns true for prompt-segments kind', () => {
      assert.ok(
        isPromptSegmentsSourceRefs({
          kind: 'prompt-segments',
          windowStartMs: 0,
          windowEndMs: 1,
          evalRunId: 'hlr-1234567890-abcdef12',
        }),
      );
    });

    test('returns false for undefined', () => {
      assert.ok(!isPromptSegmentsSourceRefs(undefined));
    });

    test('returns false for other kinds', () => {
      assert.ok(
        !isPromptSegmentsSourceRefs({
          kind: 'qc-metrics-rollup',
          windowStartMs: 0,
          windowEndMs: 1,
          evalRunId: 'hlr-1234567890-abcdef12',
        }),
      );
    });

    test('returns false for objects without kind', () => {
      assert.ok(!isPromptSegmentsSourceRefs({ windowStartMs: 0, windowEndMs: 1 }));
    });
  });

  describe('validatePromptSegmentsSelector', () => {
    test('accepts valid selector', () => {
      const result = validatePromptSegmentsSelector({
        kind: 'prompt-segments',
        windowStartMs: 1000,
        windowEndMs: 2000,
        evalRunId: 'hlr-1234567890-abcdef12',
      });
      assert.equal(result, null);
    });

    test('accepts valid selector with guardId', () => {
      const result = validatePromptSegmentsSelector({
        kind: 'prompt-segments',
        windowStartMs: 1000,
        windowEndMs: 2000,
        guardId: 'hold_ball_rate_limit',
        evalRunId: 'hlr-1234567890-abcdef12',
      });
      assert.equal(result, null);
    });

    test('rejects wrong kind', () => {
      const result = validatePromptSegmentsSelector({
        kind: 'wrong-kind',
        windowStartMs: 1000,
        windowEndMs: 2000,
        evalRunId: 'hlr-1234567890-abcdef12',
      });
      assert.ok(result);
      assert.match(result, /expected kind='prompt-segments'/);
    });

    test('rejects non-finite windowStartMs', () => {
      const result = validatePromptSegmentsSelector({
        kind: 'prompt-segments',
        windowStartMs: Number.POSITIVE_INFINITY,
        windowEndMs: 2000,
        evalRunId: 'hlr-1234567890-abcdef12',
      });
      assert.ok(result);
      assert.match(result, /windowStartMs must be a finite number/);
    });

    test('rejects non-finite windowEndMs', () => {
      const result = validatePromptSegmentsSelector({
        kind: 'prompt-segments',
        windowStartMs: 1000,
        windowEndMs: Number.NaN,
        evalRunId: 'hlr-1234567890-abcdef12',
      });
      assert.ok(result);
      assert.match(result, /windowEndMs must be a finite number/);
    });

    test('rejects windowEndMs <= windowStartMs', () => {
      const result = validatePromptSegmentsSelector({
        kind: 'prompt-segments',
        windowStartMs: 2000,
        windowEndMs: 1000,
        evalRunId: 'hlr-1234567890-abcdef12',
      });
      assert.ok(result);
      assert.match(result, /windowEndMs must be greater than windowStartMs/);
    });

    test('rejects empty guardId', () => {
      const result = validatePromptSegmentsSelector({
        kind: 'prompt-segments',
        windowStartMs: 1000,
        windowEndMs: 2000,
        guardId: '',
        evalRunId: 'hlr-1234567890-abcdef12',
      });
      assert.ok(result);
      assert.match(result, /guardId must be a non-empty string/);
    });

    test('rejects guardId with newlines', () => {
      const result = validatePromptSegmentsSelector({
        kind: 'prompt-segments',
        windowStartMs: 1000,
        windowEndMs: 2000,
        guardId: 'guard\ninjection',
        evalRunId: 'hlr-1234567890-abcdef12',
      });
      assert.ok(result);
      assert.match(result, /guardId must not contain newlines/);
    });

    test('rejects missing evalRunId', () => {
      const result = validatePromptSegmentsSelector({
        kind: 'prompt-segments',
        windowStartMs: 1000,
        windowEndMs: 2000,
      });
      assert.ok(result);
      assert.match(result, /evalRunId is required/);
    });

    test('rejects malformed evalRunId', () => {
      const result = validatePromptSegmentsSelector({
        kind: 'prompt-segments',
        windowStartMs: 1000,
        windowEndMs: 2000,
        evalRunId: 'not-a-valid-id',
      });
      assert.ok(result);
      assert.match(result, /evalRunId must match generator format/);
    });
  });

  describe('inferSourceRefsKind', () => {
    test('infers prompt-segments from PromptSegmentsSourceSelector', () => {
      const kind = inferSourceRefsKind({
        kind: 'prompt-segments',
        windowStartMs: 1000,
        windowEndMs: 2000,
        evalRunId: 'hlr-1234567890-abcdef12',
      });
      assert.equal(kind, 'prompt-segments');
    });

    test('does not misclassify prompt-segments as a2a', () => {
      // prompt-segments has explicit kind — must NOT fall through to a2a default
      const kind = inferSourceRefsKind({
        kind: 'prompt-segments',
        windowStartMs: 1000,
        windowEndMs: 2000,
        evalRunId: 'hlr-1234567890-abcdef12',
      });
      assert.notEqual(kind, 'a2a-snapshot-attribution');
    });
  });
});
