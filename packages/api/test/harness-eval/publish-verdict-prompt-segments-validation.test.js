import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * F257 — prompt-segments sourceRefs validation: discriminator + handler dispatch.
 *
 * Bug: source-ref-handler-validation.ts never imports/calls isPromptSegmentsSourceRefs
 * or validatePromptSegmentsSelector, so publish_verdict returns 400 for valid
 * prompt-segments selectors. This test exercises:
 *   - isPromptSegmentsSourceRefs discriminator
 *   - validatePromptSegmentsSelector accept/reject
 *   - validateSourceRefsForPublish dispatch (the missing branch)
 *
 * TDD: written RED before source-ref-handler-validation.ts is fixed.
 */

const VALIDATION_PATH = '../../dist/infrastructure/harness-eval/publish-verdict/validation.js';
const HANDLER_PATH = '../../dist/infrastructure/harness-eval/publish-verdict/source-ref-handler-validation.js';

function validPromptSegmentsRefs(overrides = {}) {
  return {
    kind: 'prompt-segments',
    windowStartMs: 1_786_698_665_681,
    windowEndMs: 1_787_303_465_681,
    evalRunId: 'hlr-1787303465681-a640cc92',
    ...overrides,
  };
}

describe('isPromptSegmentsSourceRefs', () => {
  it('returns true for prompt-segments kind', async () => {
    const { isPromptSegmentsSourceRefs } = await import(VALIDATION_PATH);
    assert.equal(isPromptSegmentsSourceRefs(validPromptSegmentsRefs()), true);
  });

  it('returns false for other kinds and undefined', async () => {
    const { isPromptSegmentsSourceRefs } = await import(VALIDATION_PATH);
    assert.equal(isPromptSegmentsSourceRefs({ kind: 'a2a-snapshot-attribution' }), false);
    assert.equal(isPromptSegmentsSourceRefs({ kind: 'capability-wakeup-trial-window' }), false);
    assert.equal(isPromptSegmentsSourceRefs(undefined), false);
    assert.equal(isPromptSegmentsSourceRefs({}), false);
  });
});

describe('validatePromptSegmentsSelector', () => {
  it('accepts a well-formed selector', async () => {
    const { validatePromptSegmentsSelector } = await import(VALIDATION_PATH);
    assert.equal(validatePromptSegmentsSelector(validPromptSegmentsRefs()), null);
  });

  it('rejects wrong kind', async () => {
    const { validatePromptSegmentsSelector } = await import(VALIDATION_PATH);
    const result = validatePromptSegmentsSelector(validPromptSegmentsRefs({ kind: 'sop-trace-eval' }));
    assert.match(result, /expected kind='prompt-segments'/);
  });

  it('rejects non-finite windowStartMs', async () => {
    const { validatePromptSegmentsSelector } = await import(VALIDATION_PATH);
    assert.ok(validatePromptSegmentsSelector(validPromptSegmentsRefs({ windowStartMs: NaN })));
    assert.ok(validatePromptSegmentsSelector(validPromptSegmentsRefs({ windowStartMs: 'hello' })));
  });

  it('rejects non-finite windowEndMs', async () => {
    const { validatePromptSegmentsSelector } = await import(VALIDATION_PATH);
    assert.ok(validatePromptSegmentsSelector(validPromptSegmentsRefs({ windowEndMs: Infinity })));
  });

  it('rejects windowEndMs <= windowStartMs', async () => {
    const { validatePromptSegmentsSelector } = await import(VALIDATION_PATH);
    assert.ok(validatePromptSegmentsSelector(validPromptSegmentsRefs({ windowEndMs: 1_786_698_665_681 })));
  });

  it('rejects missing evalRunId', async () => {
    const { validatePromptSegmentsSelector } = await import(VALIDATION_PATH);
    assert.match(validatePromptSegmentsSelector(validPromptSegmentsRefs({ evalRunId: '' })), /evalRunId/);
    assert.match(validatePromptSegmentsSelector(validPromptSegmentsRefs({ evalRunId: undefined })), /evalRunId/);
  });

  it('rejects evalRunId with wrong format (path traversal defense)', async () => {
    const { validatePromptSegmentsSelector } = await import(VALIDATION_PATH);
    assert.match(
      validatePromptSegmentsSelector(validPromptSegmentsRefs({ evalRunId: '../etc/passwd' })),
      /generator format/,
    );
    assert.match(
      validatePromptSegmentsSelector(validPromptSegmentsRefs({ evalRunId: 'hlr-abc-zzzzzzzz' })),
      /generator format/,
    );
  });
});

describe('validateSourceRefsForPublish dispatches prompt-segments', () => {
  it('returns null for a valid prompt-segments selector (the bug: was returning 400)', async () => {
    const { validateSourceRefsForPublish } = await import(HANDLER_PATH);
    const result = validateSourceRefsForPublish(validPromptSegmentsRefs());
    assert.equal(
      result,
      null,
      'handler must dispatch prompt-segments to its validator, not fall through to capability-wakeup',
    );
  });

  it('returns 400 for an invalid prompt-segments selector', async () => {
    const { validateSourceRefsForPublish } = await import(HANDLER_PATH);
    const result = validateSourceRefsForPublish(validPromptSegmentsRefs({ evalRunId: 'INVALID' }));
    assert.ok(result, 'malformed prompt-segments must be rejected');
    assert.equal(result.status, 400);
    assert.equal(result.error, 'invalid_source_ref');
  });
});
