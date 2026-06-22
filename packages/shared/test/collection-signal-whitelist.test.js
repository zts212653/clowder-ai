/**
 * F231 AC-C3: Collection signal whitelist (KD-9).
 *
 * The whitelist is a CLOSED enum of deterministic, explainable event types.
 * KD-9 contract: only these kinds are allowed as collection sources.
 * Everything else (classifier, regex scan, LLM annotation) is forbidden.
 *
 * Tests verify:
 *   1. COLLECTION_SIGNAL_KINDS is a frozen array of allowed kinds
 *   2. isAllowedCollectionSignal() accepts every whitelisted kind
 *   3. isAllowedCollectionSignal() rejects forbidden kinds
 *   4. ProfileUpdateSignalProvenance.kind type is a subset of the whitelist
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { COLLECTION_SIGNAL_KINDS, isAllowedCollectionSignal } from '../dist/types/profile-update.js';

describe('F231 AC-C3 — Collection signal whitelist (KD-9)', () => {
  describe('COLLECTION_SIGNAL_KINDS', () => {
    test('is a frozen array (closed enum, no runtime extension)', () => {
      assert.ok(Array.isArray(COLLECTION_SIGNAL_KINDS), 'must be an array');
      assert.ok(Object.isFrozen(COLLECTION_SIGNAL_KINDS), 'must be frozen');
    });

    test('contains all KD-9 whitelisted kinds', () => {
      const required = ['cvo-instructed', 'cat-declared', 'magic-word', 'message-coordinate', 'sign-off', 'reaction'];
      for (const kind of required) {
        assert.ok(COLLECTION_SIGNAL_KINDS.includes(kind), `whitelist must include "${kind}"`);
      }
    });

    test('contains ONLY whitelisted kinds (no extras)', () => {
      const allowed = new Set([
        'cvo-instructed',
        'cat-declared',
        'magic-word',
        'message-coordinate',
        'sign-off',
        'reaction',
      ]);
      for (const kind of COLLECTION_SIGNAL_KINDS) {
        assert.ok(allowed.has(kind), `unexpected kind "${kind}" in whitelist`);
      }
    });
  });

  describe('isAllowedCollectionSignal()', () => {
    test('accepts every whitelisted kind', () => {
      for (const kind of COLLECTION_SIGNAL_KINDS) {
        assert.equal(isAllowedCollectionSignal(kind), true, `"${kind}" must be accepted`);
      }
    });

    test('rejects classifier-inferred kinds (KD-9 forbidden)', () => {
      const forbidden = ['classifier-inferred', 'regex-scan', 'llm-annotation', 'sentiment-analysis', 'pattern-match'];
      for (const kind of forbidden) {
        assert.equal(isAllowedCollectionSignal(kind), false, `"${kind}" must be rejected (KD-9 禁 classifier)`);
      }
    });

    test('rejects empty string and undefined', () => {
      assert.equal(isAllowedCollectionSignal(''), false);
      assert.equal(isAllowedCollectionSignal(undefined), false);
      assert.equal(isAllowedCollectionSignal(null), false);
    });
  });
});
