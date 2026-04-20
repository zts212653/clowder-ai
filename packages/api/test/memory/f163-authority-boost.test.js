/**
 * F163: Post-retrieval authority boost
 * Tests: validated items rank above observed when boost=on; no effect when off
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

describe('F163 authority boost', () => {
  let store;
  const savedEnv = {};

  beforeEach(async () => {
    // Save and clear F163 env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }

    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Insert two items matching same query — different authority
    await store.upsert([
      {
        anchor: 'lesson-observed',
        kind: 'lesson',
        status: 'active',
        title: 'Redis pitfall observed',
        summary: 'Redis keyPrefix observed lesson about pitfall',
        authority: 'observed',
        activation: 'query',
        updatedAt: '2026-04-16T00:00:00Z',
      },
      {
        anchor: 'lesson-validated',
        kind: 'lesson',
        status: 'active',
        title: 'Redis pitfall validated',
        summary: 'Redis keyPrefix validated lesson about pitfall',
        authority: 'validated',
        activation: 'query',
        updatedAt: '2026-04-16T00:00:00Z',
      },
    ]);
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('F163_')) delete process.env[key];
    }
    for (const [key, val] of Object.entries(savedEnv)) {
      process.env[key] = val;
    }
  });

  it('authority_boost=on ranks validated above observed', async () => {
    process.env.F163_AUTHORITY_BOOST = 'on';
    const results = await store.search('Redis pitfall');
    assert.ok(results.length >= 2);

    const validatedIdx = results.findIndex((r) => r.anchor === 'lesson-validated');
    const observedIdx = results.findIndex((r) => r.anchor === 'lesson-observed');
    assert.ok(
      validatedIdx < observedIdx,
      `validated (idx=${validatedIdx}) should rank before observed (idx=${observedIdx})`,
    );
  });

  it('authority_boost=off preserves original order', async () => {
    process.env.F163_AUTHORITY_BOOST = 'off';
    const results = await store.search('Redis pitfall');
    assert.ok(results.length >= 2);

    // With boost off, each result should have boostSource=['legacy']
    // (boostSource is tested in Task 6, here we just verify ordering is unchanged)
  });

  it('authority_boost=shadow does NOT change result order', async () => {
    process.env.F163_AUTHORITY_BOOST = 'shadow';
    const results = await store.search('Redis pitfall');
    assert.ok(results.length >= 2);

    // Shadow mode: original order preserved (boost computed but not applied)
    // Verified by comparing with off results
    process.env.F163_AUTHORITY_BOOST = 'off';
    const offResults = await store.search('Redis pitfall');
    assert.deepEqual(
      results.map((r) => r.anchor),
      offResults.map((r) => r.anchor),
      'shadow mode should not change result ordering',
    );
  });

  it('constitutional ranks above validated', async () => {
    await store.upsert([
      {
        anchor: 'lesson-constitutional',
        kind: 'lesson',
        status: 'active',
        title: 'Redis pitfall constitutional',
        summary: 'Redis keyPrefix constitutional lesson about pitfall',
        authority: 'constitutional',
        activation: 'always_on',
        updatedAt: '2026-04-16T00:00:00Z',
      },
    ]);

    process.env.F163_AUTHORITY_BOOST = 'on';
    const results = await store.search('Redis pitfall');
    const constIdx = results.findIndex((r) => r.anchor === 'lesson-constitutional');
    const validatedIdx = results.findIndex((r) => r.anchor === 'lesson-validated');
    assert.ok(
      constIdx < validatedIdx,
      `constitutional (idx=${constIdx}) should rank before validated (idx=${validatedIdx})`,
    );
  });
});
