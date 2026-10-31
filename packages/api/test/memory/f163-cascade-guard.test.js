/**
 * F163 Phase B Task 2: Cascade compression guard (AC-B5)
 * A summary-of-summary cannot be created — if any sourceIds reference
 * a doc that already has summaryOfAnchor set, upsert must reject.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

describe('F163 cascade compression guard (AC-B5)', () => {
  it('allows creating a summary over original docs', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Create original doc A
    await store.upsert([
      {
        anchor: 'LL-001',
        kind: 'lesson',
        status: 'active',
        title: 'Redis keyPrefix behavior',
        summary: 'keyPrefix is not applied to EVAL commands',
        updatedAt: '2026-04-16',
      },
    ]);

    // Create summary S1 covering A — should succeed
    await store.upsert([
      {
        anchor: 'S-001',
        kind: 'lesson',
        status: 'active',
        title: 'Redis key management summary',
        summary: 'Consolidated Redis key management lessons',
        updatedAt: '2026-04-16',
        sourceIds: ['LL-001'],
        summaryOfAnchor: 'summary-group-001',
        compressionRationale: 'Single Redis key lesson, trivial merge',
      },
    ]);

    // Verify S1 was created with correct fields
    const s1 = await store.getByAnchor('S-001');
    assert.ok(s1);
    assert.deepEqual(s1.sourceIds, ['LL-001']);
    assert.equal(s1.summaryOfAnchor, 'summary-group-001');
    assert.equal(s1.compressionRationale, 'Single Redis key lesson, trivial merge');
  });

  it('rejects summary-of-summary (cascade compression)', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Create original doc A
    await store.upsert([
      {
        anchor: 'LL-010',
        kind: 'lesson',
        status: 'active',
        title: 'Original lesson',
        updatedAt: '2026-04-16',
      },
    ]);

    // Create summary S1 covering A
    await store.upsert([
      {
        anchor: 'S-010',
        kind: 'lesson',
        status: 'active',
        title: 'Summary of original',
        updatedAt: '2026-04-16',
        sourceIds: ['LL-010'],
        summaryOfAnchor: 'sg-010',
      },
    ]);

    // Attempt to create S2 covering S1 — must throw
    await assert.rejects(
      () =>
        store.upsert([
          {
            anchor: 'S-020',
            kind: 'lesson',
            status: 'active',
            title: 'Summary of summary',
            updatedAt: '2026-04-16',
            sourceIds: ['S-010'],
            summaryOfAnchor: 'sg-020',
          },
        ]),
      (err) => {
        assert.ok(
          err.message.includes('cascade compression prohibited'),
          `expected "cascade compression prohibited", got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('rejects when ANY sourceId is already a summary (mixed batch)', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Create original A and B
    await store.upsert([
      { anchor: 'LL-020', kind: 'lesson', status: 'active', title: 'A', updatedAt: '2026-04-16' },
      { anchor: 'LL-021', kind: 'lesson', status: 'active', title: 'B', updatedAt: '2026-04-16' },
    ]);

    // Create summary S1 covering A
    await store.upsert([
      {
        anchor: 'S-030',
        kind: 'lesson',
        status: 'active',
        title: 'Summary of A',
        updatedAt: '2026-04-16',
        sourceIds: ['LL-020'],
        summaryOfAnchor: 'sg-030',
      },
    ]);

    // Attempt to create S2 covering B (original) + S1 (summary) — must throw
    await assert.rejects(
      () =>
        store.upsert([
          {
            anchor: 'S-040',
            kind: 'lesson',
            status: 'active',
            title: 'Mixed sources summary',
            updatedAt: '2026-04-16',
            sourceIds: ['LL-021', 'S-030'],
            summaryOfAnchor: 'sg-040',
          },
        ]),
      (err) => {
        assert.ok(err.message.includes('cascade compression prohibited'));
        return true;
      },
    );
  });

  it('allows summary over non-summary docs even if they have activation=backstop', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Create doc with backstop activation (already demoted by earlier compression)
    await store.upsert([
      {
        anchor: 'LL-030',
        kind: 'lesson',
        status: 'active',
        title: 'Backstop doc',
        updatedAt: '2026-04-16',
        activation: 'backstop',
      },
    ]);

    // Creating a summary over backstop originals is fine (they're not summaries themselves)
    await store.upsert([
      {
        anchor: 'S-050',
        kind: 'lesson',
        status: 'active',
        title: 'Summary over backstop',
        updatedAt: '2026-04-16',
        sourceIds: ['LL-030'],
        summaryOfAnchor: 'sg-050',
      },
    ]);

    const s = await store.getByAnchor('S-050');
    assert.ok(s);
    assert.equal(s.summaryOfAnchor, 'sg-050');
  });
});
