/**
 * K-1 / F288 — contract/validate fail-closed tests (plan Task 1)
 * INV-2 (draft cannot express system audience) structural half + D-6 bounds.
 */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

/** @type {typeof import('../dist/domains/messaging/contract/validate.js')} */
let validate;
before(async () => {
  validate = await import('../dist/domains/messaging/contract/validate.js');
});

function validDraft(overrides = {}) {
  return {
    address: { kind: 'thread_handle', handle: 'th_abc123' },
    idempotencyKey: 'idem-1',
    payload: {
      provenance: { epistemicStatus: 'inference' },
      elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'hello' } }],
    },
    ...overrides,
  };
}

function expectValidationError(fn, detailSnippet) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'MessagingError', `expected MessagingError, got ${err.name}: ${err.message}`);
    assert.equal(err.code, 'VALIDATION');
    if (detailSnippet) {
      assert.match(err.message, new RegExp(detailSnippet), `message should mention ${detailSnippet}`);
    }
    return;
  }
  assert.fail('expected VALIDATION error, but call succeeded');
}

describe('validateDraft — happy path', () => {
  test('accepts a minimal valid draft and returns it typed', () => {
    const draft = validate.validateDraft(validDraft());
    assert.equal(draft.idempotencyKey, 'idem-1');
    assert.equal(draft.address.kind, 'thread_handle');
    assert.equal(draft.payload.elements.length, 1);
  });

  test('accepts whisper audience with targets', () => {
    const draft = validate.validateDraft(
      validDraft({ draftAudience: { kind: 'whisper', targets: ['cat-a', 'cat-b'] } }),
    );
    assert.equal(draft.draftAudience?.kind, 'whisper');
  });

  test('rejects duplicate whisper targets (C-1 uniqueItems)', () => {
    expectValidationError(
      () => validate.validateDraft(validDraft({ draftAudience: { kind: 'whisper', targets: ['cat-a', 'cat-a'] } })),
      'duplicate',
    );
  });

  test('accepts external origin declaration (binding match checked at send)', () => {
    const draft = validate.validateDraft(
      validDraft({
        address: { kind: 'connector_binding', handle: 'cb_xyz' },
        payload: {
          provenance: {
            epistemicStatus: 'user_intent',
            origin: {
              kind: 'external',
              connectorId: 'telegram',
              sourceAddress: { connectorId: 'telegram', chatId: 'chat-9', messageId: 'm-1' },
            },
          },
          elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'relayed' } }],
        },
      }),
    );
    assert.equal(draft.payload.provenance.origin?.kind, 'external');
  });
});

describe('validateDraft — fail-closed', () => {
  test('rejects non-object input', () => {
    expectValidationError(() => validate.validateDraft(null));
    expectValidationError(() => validate.validateDraft('draft'));
  });

  test('rejects properties outside C-1 closed input objects', () => {
    const cases = [
      validDraft({ injected: true }),
      validDraft({ address: { kind: 'thread_handle', handle: 'th_abc123', injected: true } }),
      validDraft({ draftAudience: { kind: 'public', injected: true } }),
      validDraft({
        payload: {
          provenance: { epistemicStatus: 'inference' },
          elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'hello' } }],
          injected: true,
        },
      }),
      validDraft({
        payload: {
          provenance: { epistemicStatus: 'inference', injected: true },
          elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'hello' } }],
        },
      }),
      validDraft({
        payload: {
          provenance: { epistemicStatus: 'inference' },
          elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'hello' }, injected: true }],
        },
      }),
      validDraft({
        payload: {
          provenance: { epistemicStatus: 'inference' },
          elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'hello', injected: true } }],
        },
      }),
    ];
    for (const input of cases) {
      expectValidationError(() => validate.validateDraft(input), 'unknown');
    }
  });

  test('rejects missing idempotencyKey', () => {
    expectValidationError(() => validate.validateDraft(validDraft({ idempotencyKey: undefined })), 'idempotencyKey');
    expectValidationError(() => validate.validateDraft(validDraft({ idempotencyKey: '' })), 'idempotencyKey');
  });

  test('rejects over-long idempotencyKey', () => {
    expectValidationError(
      () => validate.validateDraft(validDraft({ idempotencyKey: 'x'.repeat(201) })),
      'idempotencyKey',
    );
  });

  test('rejects bare-threadId style address (no handle envelope)', () => {
    expectValidationError(() => validate.validateDraft(validDraft({ address: { kind: 'thread_id', handle: 't1' } })));
    expectValidationError(() => validate.validateDraft(validDraft({ address: 'thread-123' })));
    expectValidationError(() => validate.validateDraft(validDraft({ address: { kind: 'thread_handle', handle: '' } })));
  });

  test('INV-2: rejects system draftAudience (schema half of the double block)', () => {
    expectValidationError(() => validate.validateDraft(validDraft({ draftAudience: { kind: 'system' } })), 'host-only');
  });

  test('rejects whisper with empty or oversized target set', () => {
    expectValidationError(() =>
      validate.validateDraft(validDraft({ draftAudience: { kind: 'whisper', targets: [] } })),
    );
    const many = Array.from({ length: 17 }, (_, i) => `cat-${i}`);
    expectValidationError(
      () => validate.validateDraft(validDraft({ draftAudience: { kind: 'whisper', targets: many } })),
      'whisper',
    );
  });

  test('rejects empty elements', () => {
    expectValidationError(
      () =>
        validate.validateDraft(validDraft({ payload: { provenance: { epistemicStatus: 'inference' }, elements: [] } })),
      'elements',
    );
  });

  test('rejects duplicate elementIds', () => {
    expectValidationError(
      () =>
        validate.validateDraft(
          validDraft({
            payload: {
              provenance: { epistemicStatus: 'inference' },
              elements: [
                { elementId: 'dup', kind: 'text', payload: { text: 'a' } },
                { elementId: 'dup', kind: 'text', payload: { text: 'b' } },
              ],
            },
          }),
        ),
      'elementId',
    );
  });

  test('draft derivation must reference an earlier element in the same message', () => {
    const payload = {
      provenance: { epistemicStatus: 'inference' },
      elements: [
        { elementId: 'source', kind: 'text', payload: { text: 'source' } },
        {
          elementId: 'derived',
          kind: 'text',
          payload: { text: 'derived' },
          derivedFromElementId: 'source',
        },
      ],
    };
    assert.equal(validate.validateDraft(validDraft({ payload })).payload.elements.length, 2);

    expectValidationError(
      () =>
        validate.validateDraft(
          validDraft({
            payload: {
              ...payload,
              elements: [payload.elements[1], payload.elements[0]],
            },
          }),
        ),
      'derivedFromElementId',
    );
    expectValidationError(
      () =>
        validate.validateDraft(
          validDraft({
            payload: {
              ...payload,
              elements: [{ ...payload.elements[1], derivedFromElementId: 'missing' }],
            },
          }),
        ),
      'derivedFromElementId',
    );
  });

  test('rejects unknown element kind', () => {
    expectValidationError(
      () =>
        validate.validateDraft(
          validDraft({
            payload: {
              provenance: { epistemicStatus: 'inference' },
              elements: [{ elementId: 'el-1', kind: 'script', payload: { src: 'evil' } }],
            },
          }),
        ),
      'kind',
    );
  });

  test('rejects text element without string text payload', () => {
    expectValidationError(
      () =>
        validate.validateDraft(
          validDraft({
            payload: {
              provenance: { epistemicStatus: 'inference' },
              elements: [{ elementId: 'el-1', kind: 'text', payload: { body: 'x' } }],
            },
          }),
        ),
      'text',
    );
  });

  test('D-6: rejects more than maxElementsPerOperation elements', () => {
    const many = Array.from({ length: 33 }, (_, i) => ({
      elementId: `el-${i}`,
      kind: 'text',
      payload: { text: `t${i}` },
    }));
    expectValidationError(
      () =>
        validate.validateDraft(
          validDraft({ payload: { provenance: { epistemicStatus: 'inference' }, elements: many } }),
        ),
      'elements',
    );
  });

  test('D-6: rejects oversized single element payload', () => {
    const big = 'x'.repeat(64 * 1024 + 1);
    expectValidationError(
      () =>
        validate.validateDraft(
          validDraft({
            payload: {
              provenance: { epistemicStatus: 'inference' },
              elements: [{ elementId: 'el-1', kind: 'text', payload: { text: big } }],
            },
          }),
        ),
      'payload',
    );
  });

  test('rejects invalid epistemicStatus', () => {
    expectValidationError(
      () =>
        validate.validateDraft(
          validDraft({
            payload: {
              provenance: { epistemicStatus: 'gospel' },
              elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'x' } }],
            },
          }),
        ),
      'epistemicStatus',
    );
  });

  test('D-4: rejects host origin declaration in any draft', () => {
    expectValidationError(
      () =>
        validate.validateDraft(
          validDraft({
            payload: {
              provenance: { epistemicStatus: 'inference', origin: { kind: 'host' } },
              elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'x' } }],
            },
          }),
        ),
      'origin',
    );
  });
});
