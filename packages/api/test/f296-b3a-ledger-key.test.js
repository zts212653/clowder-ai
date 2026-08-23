// F296 B3a hard gate 1: the presentation ledger key must be collision-free.
//
// Why this file exists: B2b joined the five coordinates with U+001F. That byte
// can appear *inside* `subjectKey` (it is externally shaped: `pr:owner/repo#42`,
// `subject:<ns>:<opaque>` where the opaque half is producer-controlled) and
// inside a version string. So two genuinely different projections could hash to
// one key, and the ledger would suppress a projection the cat never saw.
//
// The contract asserted here is stronger than "these two known strings differ":
// the encoding must be *injective*, proven by decoding back to the exact input.
// A mutation that drops the length prefix, or that swaps back to a delimiter
// join, breaks round-trip on the adversarial corpus below.
//
// Separators are written as `<US>` escapes, never pasted literally: an
// invisible control character in source is unreviewable.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { presentationLedgerKey, decodePresentationLedgerKey, encodeLedgerFields, decodeLedgerFields } = await import(
  '../dist/domains/cats/services/session/ledger-key.js'
);

const US = '\u001f';
const version = (value) => ({ kind: 'version', value });
const asOf = (value) => ({ kind: 'as_of', value });

describe('F296 B3a gate 1: ledger key encoding is injective', () => {
  test('the exact collision named in the spec no longer collides', () => {
    // subjectKey="x<US>v:y", asOf="z"  vs  subjectKey="x", asOf="y<US>v:z"
    // Under the old `join('<US>')` both produced `...x<US>v:y<US>v:z...`.
    const a = presentationLedgerKey({
      scopeKey: 's',
      contextEpoch: 1,
      subjectKey: `x${US}v:y`,
      asOf: version('z'),
      presentation: 'state',
    });
    const b = presentationLedgerKey({
      scopeKey: 's',
      contextEpoch: 1,
      subjectKey: 'x',
      asOf: version(`y${US}v:z`),
      presentation: 'state',
    });
    assert.notEqual(a, b);
  });

  test('a separator in the scope key cannot forge a field boundary either', () => {
    const a = presentationLedgerKey({
      scopeKey: `u${US}c`,
      contextEpoch: 1,
      subjectKey: 'sub',
      asOf: version('r'),
      presentation: 'state',
    });
    const b = presentationLedgerKey({
      scopeKey: 'u',
      contextEpoch: 1,
      subjectKey: `c${US}sub`,
      asOf: version('r'),
      presentation: 'state',
    });
    assert.notEqual(a, b);
  });

  // A length prefix is only unambiguous if the *length* itself cannot be
  // confused with payload. Payloads that look like a length prefix are the
  // attack: `"3:abc"` inside a field must not be readable as a field header.
  const ADVERSARIAL_FIELDS = [
    '',
    'plain',
    US,
    `${US}${US}`,
    `x${US}v:y`,
    '3:abc',
    '0:',
    '12:not-really-twelve',
    ':',
    '::',
    'pr:zts212653/cat-cafe#3776',
    'subject:memory:ab:c',
    ' ',
    'emoji-\u{1F43E}-multibyte',
    '中文字段',
    'a'.repeat(300),
  ];

  test('every adversarial field round-trips through encode/decode unchanged', () => {
    for (const field of ADVERSARIAL_FIELDS) {
      const encoded = encodeLedgerFields([field]);
      assert.deepEqual(decodeLedgerFields(encoded), [field], `round-trip failed for ${JSON.stringify(field)}`);
    }
  });

  test('multi-byte payloads keep their exact boundary', () => {
    const fields = ['emoji-\u{1F43E}', '中文', 'ascii'];
    assert.deepEqual(decodeLedgerFields(encodeLedgerFields(fields)), fields);
  });

  test('the full adversarial cross-product produces no duplicate keys', () => {
    const seen = new Map();
    for (const subjectKey of ADVERSARIAL_FIELDS) {
      for (const revision of ADVERSARIAL_FIELDS) {
        const key = presentationLedgerKey({
          scopeKey: `u${US}c`,
          contextEpoch: 7,
          subjectKey,
          asOf: version(revision),
          presentation: 'state',
        });
        const prior = seen.get(key);
        assert.equal(
          prior,
          undefined,
          `collision: ${JSON.stringify([subjectKey, revision])} vs ${JSON.stringify(prior)}`,
        );
        seen.set(key, [subjectKey, revision]);
      }
    }
    assert.equal(seen.size, ADVERSARIAL_FIELDS.length ** 2);
  });

  test('the key decodes back to the exact five coordinates', () => {
    const input = {
      scopeKey: 'user-1::opus5::thread-1',
      contextEpoch: 42,
      subjectKey: `subject:memory:ab${US}cd`,
      asOf: version('rev-9'),
      presentation: 'pointer',
    };
    assert.deepEqual(decodePresentationLedgerKey(presentationLedgerKey(input)), input);
  });

  test('as_of and version revisions of the same value are different keys', () => {
    const base = { scopeKey: 's', contextEpoch: 1, subjectKey: 'sub', presentation: 'state' };
    assert.notEqual(
      presentationLedgerKey({ ...base, asOf: version('1700') }),
      presentationLedgerKey({ ...base, asOf: asOf(1700) }),
    );
  });

  test('every coordinate is load-bearing: changing any one changes the key', () => {
    const base = {
      scopeKey: 's',
      contextEpoch: 1,
      subjectKey: 'sub',
      asOf: version('r'),
      presentation: 'state',
    };
    const baseKey = presentationLedgerKey(base);
    const mutations = [
      { ...base, scopeKey: 's2' },
      { ...base, contextEpoch: 2 },
      { ...base, subjectKey: 'sub2' },
      { ...base, asOf: version('r2') },
      { ...base, presentation: 'pointer' },
    ];
    for (const mutation of mutations) {
      assert.notEqual(presentationLedgerKey(mutation), baseKey);
    }
  });

  test('encoding is deterministic across calls', () => {
    const input = {
      scopeKey: 's',
      contextEpoch: 1,
      subjectKey: 'sub',
      asOf: version('r'),
      presentation: 'state',
    };
    assert.equal(presentationLedgerKey(input), presentationLedgerKey(input));
  });

  test('a truncated or malformed key is rejected, not silently half-decoded', () => {
    const key = presentationLedgerKey({
      scopeKey: 's',
      contextEpoch: 1,
      subjectKey: 'sub',
      asOf: version('r'),
      presentation: 'state',
    });
    assert.throws(() => decodePresentationLedgerKey(key.slice(0, key.length - 2)), /ledger_key/);
    assert.throws(() => decodeLedgerFields('nope'), /ledger_key/);
  });
});
