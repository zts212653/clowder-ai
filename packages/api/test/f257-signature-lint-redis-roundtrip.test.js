/**
 * F257 #4 (sol R1 P1-2) — signatureLint MUST survive the Redis serialize→parse
 * round-trip.
 *
 * Bug: `serializeExtra` writes the whole object (so signatureLint is stored),
 * but `safeParseExtra` rebuilds `extra` from an explicit allowlist and silently
 * dropped `signatureLint` → the field was in-process-only; any Redis-backed
 * reload/hydration lost it, violating the detection-layer persistence contract.
 * The in-memory MessageStore callback tests never caught this because they
 * inspect the immediate append result, not the Redis read path.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { serializeExtra, safeParseExtra } = await import(
  '../dist/domains/cats/services/stores/redis/redis-message-parsers.js'
);

function roundTrip(extra) {
  return safeParseExtra(serializeExtra(extra));
}

describe('F257 #4 (sol R1 P1-2) — safeParseExtra preserves signatureLint', () => {
  it('signed:false round-trips', () => {
    assert.deepEqual(roundTrip({ signatureLint: { signed: false } }), { signatureLint: { signed: false } });
  });

  it('signed:true round-trips', () => {
    assert.deepEqual(roundTrip({ signatureLint: { signed: true } }), { signatureLint: { signed: true } });
  });

  it('coexists with other extra fields (no cross-contamination)', () => {
    assert.deepEqual(roundTrip({ isExplicitPost: true, signatureLint: { signed: false } }), {
      isExplicitPost: true,
      signatureLint: { signed: false },
    });
  });

  it('malformed signatureLint.signed (non-boolean) is dropped, other fields survive', () => {
    // signed: 'no' is not a boolean → signatureLint dropped; isExplicitPost preserved.
    const parsed = safeParseExtra(JSON.stringify({ isExplicitPost: true, signatureLint: { signed: 'no' } }));
    assert.deepEqual(parsed, { isExplicitPost: true });
  });

  it('non-object signatureLint is dropped', () => {
    const parsed = safeParseExtra(JSON.stringify({ isExplicitPost: true, signatureLint: 'x' }));
    assert.deepEqual(parsed, { isExplicitPost: true });
  });

  it('signatureLint-only with malformed shape → whole extra undefined (no phantom field)', () => {
    assert.equal(safeParseExtra(JSON.stringify({ signatureLint: { signed: 1 } })), undefined);
  });
});
