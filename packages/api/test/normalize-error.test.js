/**
 * normalizeErrorMessage unit tests
 * Issue #24: ensure all thrown value types produce useful messages
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { normalizeErrorMessage } = await import('../dist/utils/normalize-error.js');

test('Error instance → .message', () => {
  assert.equal(normalizeErrorMessage(new Error('boom')), 'boom');
});

test('string → passed through', () => {
  assert.equal(normalizeErrorMessage('something broke'), 'something broke');
});

test('object with .message → .message', () => {
  assert.equal(normalizeErrorMessage({ message: 'from object' }), 'from object');
});

test('number → String()', () => {
  assert.equal(normalizeErrorMessage(42), '42');
});

test('null → String(null)', () => {
  assert.equal(normalizeErrorMessage(null), 'null');
});

test('undefined → String(undefined)', () => {
  assert.equal(normalizeErrorMessage(undefined), 'undefined');
});

test('plain object without message → JSON.stringify', () => {
  const result = normalizeErrorMessage({ code: 500 });
  assert.ok(result.includes('500'), 'should contain the value from the object');
});

test('throwing message getter → string fallback without throw', () => {
  const err = {
    get message() {
      throw new Error('getter boom');
    },
  };
  assert.equal(normalizeErrorMessage(err), 'Unknown error');
});
