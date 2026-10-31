/**
 * F163 Phase C P1 fix: upsert must auto-trigger contradiction detection.
 * Reviewer @codex evidence: upsert with flag=apply does NOT auto-populate contradicts[].
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

describe('F163 P1: upsert auto-triggers contradiction detection', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.F163_CONTRADICTION_DETECTION;
    process.env.F163_CONTRADICTION_DETECTION = 'apply';
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.F163_CONTRADICTION_DETECTION;
    else process.env.F163_CONTRADICTION_DETECTION = savedEnv;
  });

  it('auto-populates contradicts[] when upserting a conflicting doc', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    await store.upsert([
      {
        anchor: 'LL-EXIST',
        kind: 'lesson',
        status: 'active',
        title: 'Redis EVAL ignores keyPrefix',
        summary: 'keyPrefix not applied to EVAL commands in ioredis',
        updatedAt: '2026-04-10',
      },
    ]);

    await store.upsert([
      {
        anchor: 'LL-NEW',
        kind: 'lesson',
        status: 'active',
        title: 'Redis EVAL respects keyPrefix',
        summary: 'keyPrefix IS applied to EVAL in latest ioredis',
        updatedAt: '2026-04-16',
      },
    ]);

    const doc = await store.getByAnchor('LL-NEW');
    assert.ok(doc, 'LL-NEW should exist');
    assert.ok(doc.contradicts, 'contradicts should be auto-populated by upsert');
    assert.ok(doc.contradicts.length >= 1, 'should detect at least 1 contradiction');
    assert.equal(doc.contradicts[0], 'LL-EXIST');
  });

  it('does not include own anchor in contradicts when updating same doc', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    await store.upsert([
      {
        anchor: 'LL-SELF',
        kind: 'lesson',
        status: 'active',
        title: 'Redis EVAL ignores keyPrefix',
        summary: 'old version',
        updatedAt: '2026-04-10',
      },
    ]);

    await store.upsert([
      {
        anchor: 'LL-SELF',
        kind: 'lesson',
        status: 'active',
        title: 'Redis EVAL ignores keyPrefix',
        summary: 'updated version',
        updatedAt: '2026-04-11',
      },
    ]);

    const doc = await store.getByAnchor('LL-SELF');
    assert.ok(doc, 'LL-SELF should exist');
    if (doc.contradicts) {
      assert.ok(!doc.contradicts.includes('LL-SELF'), 'must not self-contradict');
    }
  });

  it('does not overwrite explicit contradicts value on upsert', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    await store.upsert([
      {
        anchor: 'LL-MANUAL',
        kind: 'lesson',
        status: 'active',
        title: 'Redis EVAL ignores keyPrefix',
        summary: 'test doc',
        updatedAt: '2026-04-10',
        contradicts: ['LL-EXPLICIT'],
      },
    ]);

    const doc = await store.getByAnchor('LL-MANUAL');
    assert.ok(doc);
    assert.deepEqual(doc.contradicts, ['LL-EXPLICIT']);
  });
});
