/** K-1 / F288 — append input contract validation. */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

/** @type {typeof import('../dist/domains/messaging/contract/validate.js')} */
let validate;
/** @type {typeof import('../dist/domains/messaging/contract/host-types.js')} */
let hostTypes;

before(async () => {
  validate = await import('../dist/domains/messaging/contract/validate.js');
  hostTypes = await import('../dist/domains/messaging/contract/host-types.js');
});

function validAppend(overrides = {}) {
  return {
    handle: { kind: 'message', token: 'msg-1' },
    operationId: 'op-1',
    elements: [{ elementId: 'el-2', kind: 'text', payload: { text: 'more' } }],
    ...overrides,
  };
}

function expectValidationError(fn, detailSnippet) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.name, 'MessagingError', `expected MessagingError, got ${err.name}: ${err.message}`);
    assert.equal(err.code, 'VALIDATION');
    if (detailSnippet) assert.match(err.message, new RegExp(detailSnippet));
    return;
  }
  assert.fail('expected VALIDATION error, but call succeeded');
}

describe('validateAppendInput', () => {
  test('accepts minimal valid append input', () => {
    const input = validate.validateAppendInput(validAppend());
    assert.equal(input.handle.token, 'msg-1');
    assert.equal(input.operationId, 'op-1');
  });

  test('rejects raw messageId, malformed handle, and missing operationId', () => {
    expectValidationError(() =>
      validate.validateAppendInput({ ...validAppend(), handle: undefined, messageId: 'raw-msg-1' }),
    );
    expectValidationError(
      () => validate.validateAppendInput(validAppend({ handle: { kind: 'message', token: '' } })),
      'handle.token',
    );
    expectValidationError(
      () => validate.validateAppendInput(validAppend({ handle: { kind: 'thread', token: 'msg-1' } })),
      'handle.kind',
    );
    expectValidationError(() => validate.validateAppendInput(validAppend({ operationId: undefined })));
  });

  test('rejects unknown append and message-handle properties', () => {
    expectValidationError(() => validate.validateAppendInput(validAppend({ injected: true })), 'unknown');
    expectValidationError(
      () => validate.validateAppendInput(validAppend({ handle: { kind: 'message', token: 'msg-1', injected: true } })),
      'unknown',
    );
  });

  test('rejects negative or non-integer baseRevision', () => {
    expectValidationError(() => validate.validateAppendInput(validAppend({ baseRevision: -1 })), 'baseRevision');
    expectValidationError(() => validate.validateAppendInput(validAppend({ baseRevision: 1.5 })), 'baseRevision');
  });

  test('rejects empty elements and duplicate elementIds (shared rules)', () => {
    expectValidationError(() => validate.validateAppendInput(validAppend({ elements: [] })), 'elements');
    expectValidationError(
      () =>
        validate.validateAppendInput(
          validAppend({
            elements: [
              { elementId: 'dup', kind: 'text', payload: { text: 'a' } },
              { elementId: 'dup', kind: 'text', payload: { text: 'b' } },
            ],
          }),
        ),
      'elementId',
    );
  });

  test('MessagingError carries code and name', () => {
    const err = new hostTypes.MessagingError('VALIDATION', 'boom');
    assert.equal(err.name, 'MessagingError');
    assert.equal(err.code, 'VALIDATION');
  });
});
