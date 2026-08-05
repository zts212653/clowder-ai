/**
 * #1200 — v2 cursor token format (§8.3) + graded issuance (§8.7).
 *
 * Pins:
 *   - parseCursor strict validation (reject malformed, accept v1+v2)
 *   - cursorFor graded issuance (v2 with seq, v1 degraded without)
 *   - v2 lex order ≡ (seq, id) order (critical for SET_IF_GREATER_LUA)
 *   - v2 lex-exceeds all v1 tokens ('v' > any digit)
 *   - Round-trip: cursorFor → parseCursor → (seq, id) identity
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Import from dist (same as other tests in this repo)
const { parseCursor, cursorFor } = await import('../dist/domains/cats/services/stores/cursor.js');

describe('#1200 v2 cursor format (§8.3)', () => {
  // ---- parseCursor ----

  it('returns null for undefined/null/empty', () => {
    assert.equal(parseCursor(undefined), null);
    assert.equal(parseCursor(null), null);
    assert.equal(parseCursor(''), null);
  });

  it('parses v1 cursor (raw message ID)', () => {
    const result = parseCursor('1719000000000-abc123');
    assert.deepEqual(result, { version: 1, id: '1719000000000-abc123' });
  });

  it('parses v2 cursor with valid 16-digit seq', () => {
    const result = parseCursor('v2:0000000000000042:msg-xyz');
    assert.deepEqual(result, { version: 2, seq: 42, id: 'msg-xyz' });
  });

  it('parses v2 cursor at MAX_SAFE_INTEGER boundary', () => {
    const maxSafe = '9007199254740991'; // 16 digits
    const result = parseCursor(`v2:${maxSafe}:big-msg`);
    assert.deepEqual(result, {
      version: 2,
      seq: Number.MAX_SAFE_INTEGER,
      id: 'big-msg',
    });
  });

  it('parses v2 cursor with colons in messageId', () => {
    // Message IDs could theoretically contain colons
    const result = parseCursor('v2:0000000000000001:id:with:colons');
    assert.deepEqual(result, { version: 2, seq: 1, id: 'id:with:colons' });
  });

  it('throws on v2 with non-16-digit seq', () => {
    assert.throws(() => parseCursor('v2:42:msg'), /seq must be exactly 16 digits/);
  });

  it('throws on v2 with missing messageId', () => {
    assert.throws(() => parseCursor('v2:0000000000000042:'), /empty messageId/);
  });

  it('throws on v2 with no second colon', () => {
    assert.throws(() => parseCursor('v2:0000000000000042'), /missing id component/);
  });

  it('throws on v2 with letters in seq', () => {
    assert.throws(() => parseCursor('v2:000000000000abc0:msg'), /seq must be exactly 16 digits/);
  });

  // ---- P3: unknown version prefix fail-closed ----

  it('throws on unknown v<N>: prefix (fail-closed)', () => {
    assert.throws(() => parseCursor('v1:0000000000000042:msg'), /Unknown cursor version v1/);
    assert.throws(() => parseCursor('v3:0000000000000042:msg'), /Unknown cursor version v3/);
    assert.throws(() => parseCursor('v99:anything'), /Unknown cursor version v99/);
  });

  it('does NOT reject non-v<N> prefixed raw IDs', () => {
    // IDs that happen to start with 'v' but are NOT v<digits>: patterns
    const result1 = parseCursor('valid-msg-id');
    assert.deepEqual(result1, { version: 1, id: 'valid-msg-id' });

    const result2 = parseCursor('vague-prefix-id');
    assert.deepEqual(result2, { version: 1, id: 'vague-prefix-id' });
  });

  // ---- cursorFor ----

  it('issues v2 token for message with visibilitySeq', () => {
    const token = cursorFor({ id: 'msg-abc', visibilitySeq: 42 });
    assert.equal(token, 'v2:0000000000000042:msg-abc');
  });

  it('issues v1 (raw ID) for message without visibilitySeq', () => {
    const token = cursorFor({ id: 'msg-abc' });
    assert.equal(token, 'msg-abc');
  });

  it('issues v1 for message with visibilitySeq=undefined', () => {
    const token = cursorFor({ id: 'msg-abc', visibilitySeq: undefined });
    assert.equal(token, 'msg-abc');
  });

  it('zero-pads to exactly 16 digits', () => {
    const token = cursorFor({ id: 'x', visibilitySeq: 1 });
    assert.equal(token, 'v2:0000000000000001:x');
    assert.equal(token.split(':')[1]?.length, 16);
  });

  // ---- Round-trip ----

  it('parseCursor(cursorFor(msg)) recovers (seq, id) identity', () => {
    const msg = { id: 'msg-42', visibilitySeq: 12345 };
    const token = cursorFor(msg);
    const parsed = parseCursor(token);
    assert.deepEqual(parsed, { version: 2, seq: 12345, id: 'msg-42' });
  });

  it('v1 round-trip preserves id', () => {
    const msg = { id: '1719000000000-def456' };
    const token = cursorFor(msg);
    const parsed = parseCursor(token);
    assert.deepEqual(parsed, { version: 1, id: '1719000000000-def456' });
  });

  // ---- Lex ordering invariants ----

  it('v2 lex order matches numeric seq order', () => {
    const a = cursorFor({ id: 'a', visibilitySeq: 9 });
    const b = cursorFor({ id: 'a', visibilitySeq: 10 });
    assert.ok(a < b, `Expected "${a}" < "${b}" (lex order)`);
  });

  it('v2 tokens with same seq break ties by id lex order', () => {
    const a = cursorFor({ id: 'aaa', visibilitySeq: 100 });
    const b = cursorFor({ id: 'bbb', visibilitySeq: 100 });
    assert.ok(a < b, `Expected "${a}" < "${b}" (same seq, id tiebreak)`);
  });

  it('every v2 token lex-exceeds every v1 raw ID', () => {
    // This is the v1→v2 upgrade property: SET_IF_GREATER always advances
    const v1 = '9999999999999-zzz'; // max realistic v1 ID
    const v2 = cursorFor({ id: 'a', visibilitySeq: 0 }); // smallest possible v2
    assert.ok(v2 > v1, `v2 "${v2}" must lex-exceed v1 "${v1}" (v > any digit)`);
  });
});
