/**
 * F163: Cohort sticky routing — same threadId gets same variantId across requests
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { computeVariantId, freezeFlags, getOrAssignCohort } from '../../dist/domains/memory/f163-types.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

describe('F163 Cohort Sticky Routing', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigrations(db);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }
  });

  it('assigns and returns variantId for new threadId', () => {
    const flags = freezeFlags();
    const currentVariant = computeVariantId(flags);

    const result = getOrAssignCohort(db, 'thread-new', currentVariant);
    assert.equal(result, currentVariant);

    // Verify persisted in db
    const row = db.prepare('SELECT variant_id FROM f163_cohorts WHERE thread_id = ?').get('thread-new');
    assert.ok(row);
    assert.equal(row.variant_id, currentVariant);
  });

  it('returns same variantId on subsequent calls (sticky)', () => {
    const flags = freezeFlags();
    const v1 = computeVariantId(flags);

    const first = getOrAssignCohort(db, 'thread-sticky', v1);
    const second = getOrAssignCohort(db, 'thread-sticky', 'different-variant');

    assert.equal(first, v1);
    assert.equal(second, v1); // sticky — ignores new variant
  });

  it('sticks even when flags change (variant stays)', () => {
    const flags1 = freezeFlags();
    const v1 = computeVariantId(flags1);
    getOrAssignCohort(db, 'thread-change', v1);

    // Change flags
    process.env.F163_AUTHORITY_BOOST = 'on';
    const flags2 = freezeFlags();
    const v2 = computeVariantId(flags2);
    assert.notEqual(v1, v2); // different variant due to different flags

    const result = getOrAssignCohort(db, 'thread-change', v2);
    assert.equal(result, v1); // still returns original
  });

  it('different threads get different variants when flags differ', () => {
    const flags1 = freezeFlags();
    const v1 = computeVariantId(flags1);
    getOrAssignCohort(db, 'thread-A', v1);

    process.env.F163_AUTHORITY_BOOST = 'on';
    const flags2 = freezeFlags();
    const v2 = computeVariantId(flags2);
    const result = getOrAssignCohort(db, 'thread-B', v2);

    assert.equal(result, v2); // new thread gets current variant
    assert.notEqual(v1, v2);
  });
});
