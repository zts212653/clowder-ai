import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Will be created — expect import to fail until implementation exists
import { decodeFieldValue, encodeFieldValue } from '../dist/types/config-field-codec.js';

describe('config-field-codec', () => {
  // ── input ──────────────────────────────────────────────────────────

  describe('input', () => {
    const field = { type: 'input', envName: 'X', label: 'X', required: true, sensitive: false };

    it('round-trips a plain string', () => {
      const encoded = encodeFieldValue(field, 'hello');
      assert.equal(encoded, 'hello');
      assert.equal(decodeFieldValue(field, encoded), 'hello');
    });

    it('encodes empty string as empty string', () => {
      assert.equal(encodeFieldValue(field, ''), '');
    });
  });

  // ── toggle ─────────────────────────────────────────────────────────

  describe('toggle', () => {
    const field = { type: 'toggle', envName: 'T', label: 'T', required: false };

    it('encodes true as "true"', () => {
      assert.equal(encodeFieldValue(field, true), 'true');
    });

    it('encodes false as "false"', () => {
      assert.equal(encodeFieldValue(field, false), 'false');
    });

    it('decodes "true" to true', () => {
      assert.equal(decodeFieldValue(field, 'true'), true);
    });

    it('decodes "false" to false', () => {
      assert.equal(decodeFieldValue(field, 'false'), false);
    });

    it('decodes invalid string to false (graceful)', () => {
      assert.equal(decodeFieldValue(field, 'yes'), false);
      assert.equal(decodeFieldValue(field, ''), false);
      assert.equal(decodeFieldValue(field, 'TRUE'), false);
    });
  });

  // ── select ─────────────────────────────────────────────────────────

  describe('select', () => {
    const field = {
      type: 'select',
      envName: 'S',
      label: 'S',
      required: true,
      options: [
        { value: 'webhook', label: 'Webhook' },
        { value: 'websocket', label: 'WebSocket' },
      ],
    };

    it('encodes a valid option value as-is', () => {
      assert.equal(encodeFieldValue(field, 'webhook'), 'webhook');
    });

    it('decodes a valid option value', () => {
      assert.equal(decodeFieldValue(field, 'websocket'), 'websocket');
    });

    it('decodes invalid option to undefined', () => {
      assert.equal(decodeFieldValue(field, 'ftp'), undefined);
    });
  });

  // ── list ───────────────────────────────────────────────────────────

  describe('list', () => {
    const field = { type: 'list', envName: 'L', label: 'L', required: false };

    it('encodes string array to JSON', () => {
      assert.equal(encodeFieldValue(field, ['a', 'b']), '["a","b"]');
    });

    it('encodes empty array', () => {
      assert.equal(encodeFieldValue(field, []), '[]');
    });

    it('decodes JSON string array', () => {
      assert.deepEqual(decodeFieldValue(field, '["x","y"]'), ['x', 'y']);
    });

    it('decodes invalid JSON to empty array (graceful)', () => {
      assert.deepEqual(decodeFieldValue(field, 'not-json'), []);
    });

    it('decodes non-string-array JSON to empty array (graceful)', () => {
      assert.deepEqual(decodeFieldValue(field, '{"a":1}'), []);
      assert.deepEqual(decodeFieldValue(field, '[1,2]'), []);
    });
  });

  // ── operation (should not encode/decode) ───────────────────────────

  describe('operation', () => {
    const field = { type: 'operation', name: 'op', label: 'Op', required: false, actions: [] };

    it('encode returns undefined for operation', () => {
      assert.equal(encodeFieldValue(field, 'anything'), undefined);
    });

    it('decode returns undefined for operation', () => {
      assert.equal(decodeFieldValue(field, 'anything'), undefined);
    });
  });

  // ── YAML default encoding ──────────────────────────────────────────

  describe('encodeDefaultValue', () => {
    // Import the default encoder — converts YAML native values to stored strings
    // toggle: false → "false", list: [] → "[]", etc.

    it('toggle default false → "false"', () => {
      const field = { type: 'toggle', envName: 'T', label: 'T', required: false, default: false };
      assert.equal(encodeFieldValue(field, field.default), 'false');
    });

    it('toggle default true → "true"', () => {
      const field = { type: 'toggle', envName: 'T', label: 'T', required: false, default: true };
      assert.equal(encodeFieldValue(field, field.default), 'true');
    });

    it('list default [] → "[]"', () => {
      const field = { type: 'list', envName: 'L', label: 'L', required: false, default: [] };
      assert.equal(encodeFieldValue(field, field.default), '[]');
    });

    it('select default → string as-is', () => {
      const field = {
        type: 'select',
        envName: 'S',
        label: 'S',
        required: false,
        options: [{ value: 'a', label: 'A' }],
        default: 'a',
      };
      assert.equal(encodeFieldValue(field, field.default), 'a');
    });
  });
});
