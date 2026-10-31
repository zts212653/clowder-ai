/**
 * F163 Phase C Task 8: Zero-regression — flags off = no behavior change
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ContradictionDetector } from '../../dist/domains/memory/f163-contradiction-detector.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

describe('F163 Phase C zero-regression', () => {
  let savedDetection;
  let savedQueue;

  beforeEach(() => {
    savedDetection = process.env.F163_CONTRADICTION_DETECTION;
    savedQueue = process.env.F163_REVIEW_QUEUE;
    delete process.env.F163_CONTRADICTION_DETECTION;
    delete process.env.F163_REVIEW_QUEUE;
  });

  afterEach(() => {
    if (savedDetection === undefined) delete process.env.F163_CONTRADICTION_DETECTION;
    else process.env.F163_CONTRADICTION_DETECTION = savedDetection;
    if (savedQueue === undefined) delete process.env.F163_REVIEW_QUEUE;
    else process.env.F163_REVIEW_QUEUE = savedQueue;
  });

  it('upsert works normally when all Phase C flags are off (default)', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsert([
      {
        anchor: 'LL-ZR',
        kind: 'lesson',
        status: 'active',
        title: 'Zero regression test',
        updatedAt: '2026-04-16',
      },
    ]);
    const doc = await store.getByAnchor('LL-ZR');
    assert.ok(doc);
    assert.equal(doc.contradicts, undefined);
    assert.equal(doc.invalidAt, undefined);
    assert.equal(doc.reviewCycleDays, undefined);
  });

  it('ContradictionDetector returns empty when flag defaults to off', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsert([
      {
        anchor: 'LL-EXIST',
        kind: 'lesson',
        status: 'active',
        title: 'Redis EVAL ignores keyPrefix',
        summary: 'keyPrefix not applied',
        updatedAt: '2026-04-10',
      },
    ]);
    const detector = new ContradictionDetector(store);
    const hits = await detector.check({
      title: 'Redis EVAL respects keyPrefix',
      summary: 'keyPrefix IS applied',
      kind: 'lesson',
    });
    assert.deepEqual(hits, []);
  });
});
