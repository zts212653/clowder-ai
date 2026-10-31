/**
 * F163 Phase C Task 3: Write-time contradiction detector (AC-C1)
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ContradictionDetector } from '../../dist/domains/memory/f163-contradiction-detector.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

describe('F163 ContradictionDetector', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.F163_CONTRADICTION_DETECTION;
    process.env.F163_CONTRADICTION_DETECTION = 'apply';
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.F163_CONTRADICTION_DETECTION;
    else process.env.F163_CONTRADICTION_DETECTION = savedEnv;
  });

  it('detects similar existing docs as potential contradictions', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsert([
      {
        anchor: 'LL-1',
        kind: 'lesson',
        status: 'active',
        title: 'Redis EVAL ignores keyPrefix',
        summary: 'keyPrefix not applied to EVAL commands in ioredis',
        updatedAt: '2026-04-10',
      },
    ]);
    const detector = new ContradictionDetector(store);
    const hits = await detector.check({
      title: 'Redis EVAL respects keyPrefix',
      summary: 'keyPrefix IS applied to EVAL in latest ioredis',
      kind: 'lesson',
    });
    assert.ok(hits.length >= 1, `expected ≥1 hit, got ${hits.length}`);
    assert.equal(hits[0].anchor, 'LL-1');
    assert.ok(hits[0].similarity > 0, 'similarity should be positive');
  });

  it('returns empty when no contradictions found', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const detector = new ContradictionDetector(store);
    const hits = await detector.check({
      title: 'Unrelated topic about gardening',
      summary: 'Something completely different about plants',
      kind: 'lesson',
    });
    assert.deepEqual(hits, []);
  });

  it('skips detection when flag is off', async () => {
    process.env.F163_CONTRADICTION_DETECTION = 'off';
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsert([
      {
        anchor: 'LL-2',
        kind: 'lesson',
        status: 'active',
        title: 'Redis EVAL ignores keyPrefix',
        summary: 'keyPrefix not applied to EVAL',
        updatedAt: '2026-04-10',
      },
    ]);
    const detector = new ContradictionDetector(store);
    const hits = await detector.check({
      title: 'Redis EVAL respects keyPrefix',
      summary: 'keyPrefix IS applied to EVAL',
      kind: 'lesson',
    });
    assert.deepEqual(hits, []);
  });
});
