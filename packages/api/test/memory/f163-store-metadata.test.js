/**
 * F163: SqliteEvidenceStore metadata round-trip
 * Tests: upsert persists authority/activation/verifiedAt, search returns them
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

describe('F163 store metadata round-trip', () => {
  let store;

  beforeEach(async () => {
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
  });

  it('upsert persists authority/activation/verifiedAt and getByAnchor returns them', async () => {
    await store.upsert([
      {
        anchor: 'test-f163-1',
        kind: 'lesson',
        status: 'active',
        title: 'Test constitutional lesson',
        authority: 'constitutional',
        activation: 'always_on',
        verifiedAt: '2026-04-16T00:00:00Z',
        updatedAt: '2026-04-16T00:00:00Z',
      },
    ]);

    const item = await store.getByAnchor('test-f163-1');
    assert.ok(item);
    assert.equal(item.authority, 'constitutional');
    assert.equal(item.activation, 'always_on');
    assert.equal(item.verifiedAt, '2026-04-16T00:00:00Z');
  });

  it('upsert defaults authority=observed, activation=query when not set', async () => {
    await store.upsert([
      {
        anchor: 'test-f163-2',
        kind: 'feature',
        status: 'active',
        title: 'Test feature without metadata',
        updatedAt: '2026-04-16T00:00:00Z',
      },
    ]);

    const item = await store.getByAnchor('test-f163-2');
    assert.ok(item);
    assert.equal(item.authority, 'observed');
    assert.equal(item.activation, 'query');
    assert.equal(item.verifiedAt, undefined);
  });

  it('search returns items with authority/activation fields', async () => {
    await store.upsert([
      {
        anchor: 'test-f163-3',
        kind: 'lesson',
        status: 'active',
        title: 'Redis pitfall validated lesson',
        summary: 'Redis keyPrefix does not apply to eval commands',
        authority: 'validated',
        activation: 'query',
        updatedAt: '2026-04-16T00:00:00Z',
      },
    ]);

    const results = await store.search('Redis pitfall');
    assert.ok(results.length > 0);
    const found = results.find((r) => r.anchor === 'test-f163-3');
    assert.ok(found);
    assert.equal(found.authority, 'validated');
    assert.equal(found.activation, 'query');
  });
});
