/**
 * F233 — FeatTrajectoryProjector apply methods for new collectors
 *
 * Tests applyThreadSplit() and applyCrossPost() projector methods.
 * These transform collector snapshots into trajectory entries stored
 * in the feat projection.
 *
 * RED tests — methods don't exist yet on projector.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { FeatTrajectoryProjector } from '../dist/domains/feat-trajectory/FeatTrajectoryProjector.js';
import { InMemoryFeatTrajectoryStore } from '../dist/domains/feat-trajectory/FeatTrajectoryStore.js';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeThreadSplitSnapshot(overrides = {}) {
  return {
    kind: 'thread_split',
    proposalId: 'prop_001',
    parentThreadId: 'thread_parent',
    childThreadId: 'thread_child',
    featId: 'F252',
    splitAt: 1719360060000,
    catId: 'opus',
    ...overrides,
  };
}

function makeCrossPostSnapshot(overrides = {}) {
  return {
    kind: 'thread_merge',
    messageId: 'msg_001',
    sourceThreadId: 'thread_source',
    targetThreadId: 'thread_target',
    catId: 'opus',
    featId: 'F252',
    postedAt: 1719360099000,
    ...overrides,
  };
}

// ==========================================================================
// Tests — applyThreadSplit
// ==========================================================================

describe('FeatTrajectoryProjector.applyThreadSplit', () => {
  let store;
  let projector;

  beforeEach(() => {
    store = new InMemoryFeatTrajectoryStore();
    projector = new FeatTrajectoryProjector(store);
  });

  it('creates trajectory entry with kind=thread_split', async () => {
    const snap = makeThreadSplitSnapshot();
    await projector.applyThreadSplit(snap);

    const proj = await store.get('F252');
    assert.ok(proj);
    assert.equal(proj.entries.length, 1);
    assert.equal(proj.entries[0].kind, 'thread_split');
    assert.equal(proj.entries[0].source, 'event-stream');
    assert.equal(proj.entries[0].featId, 'F252');
    assert.equal(proj.entries[0].at, 1719360060000);
  });

  it('stores parentThreadId and childThreadId in payload', async () => {
    const snap = makeThreadSplitSnapshot();
    await projector.applyThreadSplit(snap);

    const proj = await store.get('F252');
    const entry = proj.entries[0];
    assert.equal(entry.payload.parentThreadId, 'thread_parent');
    assert.equal(entry.payload.childThreadId, 'thread_child');
    assert.equal(entry.payload.proposalId, 'prop_001');
    assert.equal(entry.payload.catId, 'opus');
  });

  it('uses stable entryId derived from proposalId (idempotent)', async () => {
    const snap = makeThreadSplitSnapshot();
    await projector.applyThreadSplit(snap);
    await projector.applyThreadSplit(snap); // duplicate apply

    const proj = await store.get('F252');
    assert.equal(proj.entries.length, 1); // upsert, not duplicate
    assert.ok(proj.entries[0].entryId.includes('prop_001'));
  });

  it('creates initial projection if feat not yet tracked', async () => {
    const snap = makeThreadSplitSnapshot({ featId: 'F999' });
    await projector.applyThreadSplit(snap);

    const proj = await store.get('F999');
    assert.ok(proj);
    assert.equal(proj.featId, 'F999');
    assert.equal(proj.appliedEntryCount, 1);
  });
});

// ==========================================================================
// Tests — applyCrossPost
// ==========================================================================

describe('FeatTrajectoryProjector.applyCrossPost', () => {
  let store;
  let projector;

  beforeEach(() => {
    store = new InMemoryFeatTrajectoryStore();
    projector = new FeatTrajectoryProjector(store);
  });

  it('creates trajectory entry with kind=thread_merge', async () => {
    const snap = makeCrossPostSnapshot();
    await projector.applyCrossPost(snap);

    const proj = await store.get('F252');
    assert.ok(proj);
    assert.equal(proj.entries.length, 1);
    assert.equal(proj.entries[0].kind, 'thread_merge');
    assert.equal(proj.entries[0].source, 'event-stream');
    assert.equal(proj.entries[0].featId, 'F252');
    assert.equal(proj.entries[0].at, 1719360099000);
  });

  it('stores sourceThreadId and targetThreadId in payload', async () => {
    const snap = makeCrossPostSnapshot();
    await projector.applyCrossPost(snap);

    const proj = await store.get('F252');
    const entry = proj.entries[0];
    assert.equal(entry.payload.sourceThreadId, 'thread_source');
    assert.equal(entry.payload.targetThreadId, 'thread_target');
    assert.equal(entry.payload.messageId, 'msg_001');
    assert.equal(entry.payload.catId, 'opus');
  });

  it('uses stable entryId derived from messageId (idempotent)', async () => {
    const snap = makeCrossPostSnapshot();
    await projector.applyCrossPost(snap);
    await projector.applyCrossPost(snap); // duplicate apply

    const proj = await store.get('F252');
    assert.equal(proj.entries.length, 1); // upsert, not duplicate
    assert.ok(proj.entries[0].entryId.includes('msg_001'));
  });

  it('appends to existing projection with other entries', async () => {
    // First a thread_split, then a cross-post on same feat
    await projector.applyThreadSplit(makeThreadSplitSnapshot());
    await projector.applyCrossPost(makeCrossPostSnapshot());

    const proj = await store.get('F252');
    assert.equal(proj.entries.length, 2);
    assert.equal(proj.appliedEntryCount, 2);
    // Sorted by at
    const kinds = proj.entries.map((e) => e.kind);
    assert.ok(kinds.includes('thread_split'));
    assert.ok(kinds.includes('thread_merge'));
  });
});
