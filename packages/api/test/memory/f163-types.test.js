/**
 * F163 Types: flag snapshot + variant_id computation
 * Tests: freezeFlags reads env, computeVariantId is deterministic + stable
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeVariantId, freezeFlags } from '../../dist/domains/memory/f163-types.js';

describe('F163 types', () => {
  it('freezeFlags returns all 7 flags with default off', () => {
    // Clear any F163 env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }

    const flags = freezeFlags();
    assert.equal(flags.authorityBoost, 'off');
    assert.equal(flags.alwaysOnInjection, 'off');
    assert.equal(flags.retrievalRerank, 'off');
    assert.equal(flags.compression, 'off');
    assert.equal(flags.promotionGate, 'off');
    assert.equal(flags.contradictionDetection, 'off');
    assert.equal(flags.reviewQueue, 'off');
  });

  it('freezeFlags reads env vars', () => {
    process.env.F163_AUTHORITY_BOOST = 'shadow';
    process.env.F163_ALWAYS_ON_INJECTION = 'on';
    try {
      const flags = freezeFlags();
      assert.equal(flags.authorityBoost, 'shadow');
      assert.equal(flags.alwaysOnInjection, 'on');
      assert.equal(flags.retrievalRerank, 'off'); // not set
    } finally {
      delete process.env.F163_AUTHORITY_BOOST;
      delete process.env.F163_ALWAYS_ON_INJECTION;
    }
  });

  it('freezeFlags returns frozen object', () => {
    const flags = freezeFlags();
    assert.throws(() => {
      // @ts-expect-error testing freeze
      flags.authorityBoost = 'on';
    }, TypeError);
  });

  it('computeVariantId is deterministic', () => {
    const flags = freezeFlags();
    const v1 = computeVariantId(flags);
    const v2 = computeVariantId(flags);
    assert.equal(v1, v2);
  });

  it('computeVariantId is 12 chars hex', () => {
    const flags = freezeFlags();
    const vid = computeVariantId(flags);
    assert.equal(vid.length, 12);
    assert.match(vid, /^[0-9a-f]{12}$/);
  });

  it('computeVariantId changes when flags change', () => {
    const flags1 = freezeFlags();
    const v1 = computeVariantId(flags1);

    process.env.F163_AUTHORITY_BOOST = 'on';
    try {
      const flags2 = freezeFlags();
      const v2 = computeVariantId(flags2);
      assert.notEqual(v1, v2);
    } finally {
      delete process.env.F163_AUTHORITY_BOOST;
    }
  });
});
