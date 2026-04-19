/**
 * F163 Phase C Task 9: Hub config dynamic flag update verification (issue #1221)
 *
 * Verifies that freezeFlags() reads process.env on every call, so changes via
 * PATCH /api/config/env (F136) take effect immediately without restart.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { freezeFlags } from '../../dist/domains/memory/f163-types.js';

describe('F163 Hub config dynamic updates (issue #1221)', () => {
  const keysToRestore = ['F163_CONTRADICTION_DETECTION', 'F163_REVIEW_QUEUE', 'F163_AUTHORITY_BOOST'];
  const saved = {};

  afterEach(() => {
    for (const k of keysToRestore) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('freezeFlags() picks up process.env changes without restart', () => {
    for (const k of keysToRestore) saved[k] = process.env[k];

    delete process.env.F163_CONTRADICTION_DETECTION;
    assert.equal(freezeFlags().contradictionDetection, 'off');

    process.env.F163_CONTRADICTION_DETECTION = 'suggest';
    assert.equal(freezeFlags().contradictionDetection, 'suggest');

    process.env.F163_CONTRADICTION_DETECTION = 'apply';
    assert.equal(freezeFlags().contradictionDetection, 'apply');
  });

  it('all F163 flags respond to runtime env changes', () => {
    for (const k of keysToRestore) saved[k] = process.env[k];

    delete process.env.F163_REVIEW_QUEUE;
    assert.equal(freezeFlags().reviewQueue, 'off');

    process.env.F163_REVIEW_QUEUE = 'apply';
    assert.equal(freezeFlags().reviewQueue, 'apply');

    delete process.env.F163_AUTHORITY_BOOST;
    assert.equal(freezeFlags().authorityBoost, 'off');

    process.env.F163_AUTHORITY_BOOST = 'on';
    assert.equal(freezeFlags().authorityBoost, 'on');
  });
});
