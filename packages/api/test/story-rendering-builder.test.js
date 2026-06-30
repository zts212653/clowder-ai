// @ts-check

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/**
 * F252 Phase C — buildFeatureStoryRendering pure function tests.
 *
 * Converts FeatTrajectoryProjection → FeatureStoryRenderingDTO
 * (swimlanes + causal edges + milestones).
 */

// Helper: create a minimal trajectory projection
function makeProjection(featId, entries = []) {
  const countsBySource = { 'event-stream': 0, 'historical-stitched': 0, 'git-ref-snapshot': 0 };
  const countsByKind = {};
  for (const e of entries) {
    countsBySource[e.source] = (countsBySource[e.source] || 0) + 1;
    countsByKind[e.kind] = (countsByKind[e.kind] || 0) + 1;
  }
  return {
    featId,
    entries,
    countsBySource,
    countsByKind,
    appliedEntryCount: entries.length,
    createdAt: 1719360000000,
    updatedAt: 1719360000000,
  };
}

// Helper: thread metadata map
function makeThreadMeta(threads) {
  const map = new Map();
  for (const t of threads) {
    map.set(t.id, { threadId: t.id, name: t.name || t.id, participants: t.participants || [] });
  }
  return map;
}

describe('buildFeatureStoryRendering', () => {
  test('empty projection produces empty rendering with feat metadata', async () => {
    const { buildFeatureStoryRendering } = await import('../dist/domains/story/buildFeatureStoryRendering.js');

    const projection = makeProjection('F252', []);
    const threadMeta = makeThreadMeta([]);

    const result = buildFeatureStoryRendering(projection, threadMeta, 'F252: Story Player');

    assert.equal(result.storyId, 'feat:F252');
    assert.equal(result.featId, 'F252');
    assert.equal(result.title, 'F252: Story Player');
    assert.deepStrictEqual(result.lanes, []);
    assert.deepStrictEqual(result.edges, []);
    assert.deepStrictEqual(result.milestones, []);
  });

  test('thread_split entries create two lanes + causal edge', async () => {
    const { buildFeatureStoryRendering } = await import('../dist/domains/story/buildFeatureStoryRendering.js');

    const entries = [
      {
        entryId: 'split:prop_1',
        subjectKey: 'feat:F252',
        featId: 'F252',
        at: 1719360060000,
        kind: 'thread_split',
        source: 'event-stream',
        payload: {
          parentThreadId: 'thread_main',
          childThreadId: 'thread_review',
          proposalId: 'prop_1',
          catId: 'opus',
        },
      },
    ];

    const projection = makeProjection('F252', entries);
    const threadMeta = makeThreadMeta([
      { id: 'thread_main', name: 'Main Discussion' },
      { id: 'thread_review', name: 'Code Review' },
    ]);

    const result = buildFeatureStoryRendering(projection, threadMeta, 'F252: Story Player');

    // Should have 2 lanes (parent + child)
    assert.equal(result.lanes.length, 2);
    const parentLane = result.lanes.find((l) => l.threadId === 'thread_main');
    const childLane = result.lanes.find((l) => l.threadId === 'thread_review');
    assert.ok(parentLane, 'parent lane exists');
    assert.ok(childLane, 'child lane exists');
    assert.equal(parentLane.threadName, 'Main Discussion');
    assert.equal(childLane.threadName, 'Code Review');

    // Parent lane should have the thread_split marker
    assert.equal(parentLane.markers.length, 1);
    assert.equal(parentLane.markers[0].kind, 'thread_split');

    // Should have exactly 1 causal edge (parent → child)
    assert.equal(result.edges.length, 1);
    const edge = result.edges[0];
    assert.equal(edge.kind, 'thread_split');
    assert.equal(edge.from.threadId, 'thread_main');
    assert.equal(edge.to.threadId, 'thread_review');
    assert.equal(edge.confidence, 'high'); // thread_split from proposal store = high confidence
  });

  test('thread_merge entries create causal edge from source to target', async () => {
    const { buildFeatureStoryRendering } = await import('../dist/domains/story/buildFeatureStoryRendering.js');

    const entries = [
      {
        entryId: 'merge:msg_1',
        subjectKey: 'feat:F252',
        featId: 'F252',
        at: 1719360120000,
        kind: 'thread_merge',
        source: 'event-stream',
        payload: {
          sourceThreadId: 'thread_dev',
          targetThreadId: 'thread_main',
          messageId: 'msg_1',
          catId: 'codex',
        },
      },
    ];

    const projection = makeProjection('F252', entries);
    const threadMeta = makeThreadMeta([
      { id: 'thread_dev', name: 'Dev Thread' },
      { id: 'thread_main', name: 'Main Thread' },
    ]);

    const result = buildFeatureStoryRendering(projection, threadMeta, 'F252');

    // Should have 2 lanes
    assert.equal(result.lanes.length, 2);

    // Should have 1 causal edge (source → target)
    assert.equal(result.edges.length, 1);
    const edge = result.edges[0];
    assert.equal(edge.kind, 'thread_merge');
    assert.equal(edge.from.threadId, 'thread_dev');
    assert.equal(edge.to.threadId, 'thread_main');
    assert.equal(edge.confidence, 'high');
  });

  test('git-ref entries with associatedThreadIds create lanes', async () => {
    const { buildFeatureStoryRendering } = await import('../dist/domains/story/buildFeatureStoryRendering.js');

    const entries = [
      {
        entryId: 'git-ref:feat/f252:abc123:branch_pushed',
        subjectKey: 'git-ref:feat/f252',
        featId: 'F252',
        at: 1719360180000,
        kind: 'branch_pushed',
        source: 'git-ref-snapshot',
        payload: {
          snapshot: {
            branchName: 'feat/f252',
            headCommitSha: 'abc123',
            headCommitAt: 1719360180000,
            associatedThreadIds: ['thread_impl'],
            authorIdentity: 'opus',
          },
        },
      },
    ];

    const projection = makeProjection('F252', entries);
    const threadMeta = makeThreadMeta([{ id: 'thread_impl', name: 'Implementation' }]);

    const result = buildFeatureStoryRendering(projection, threadMeta, 'F252');

    // Thread from associatedThreadIds should appear as a lane
    assert.equal(result.lanes.length, 1);
    assert.equal(result.lanes[0].threadId, 'thread_impl');
    assert.equal(result.lanes[0].markers.length, 1);
    assert.equal(result.lanes[0].markers[0].kind, 'branch_pushed');
  });

  test('branch_merged_to_main creates milestone', async () => {
    const { buildFeatureStoryRendering } = await import('../dist/domains/story/buildFeatureStoryRendering.js');

    const entries = [
      {
        entryId: 'git-ref:feat/f252:pr-100:branch_merged_to_main',
        subjectKey: 'git-ref:feat/f252',
        featId: 'F252',
        at: 1719360240000,
        kind: 'branch_merged_to_main',
        source: 'git-ref-snapshot',
        payload: {
          snapshot: {
            branchName: 'feat/f252',
            prNumber: 100,
            prMergedAt: 1719360240000,
            associatedThreadIds: ['thread_impl'],
            authorIdentity: 'opus',
          },
        },
      },
    ];

    const projection = makeProjection('F252', entries);
    const threadMeta = makeThreadMeta([{ id: 'thread_impl', name: 'Implementation' }]);

    const result = buildFeatureStoryRendering(projection, threadMeta, 'F252');

    // branch_merged_to_main should be a milestone
    assert.ok(result.milestones.length >= 1);
    const milestone = result.milestones.find((m) => m.kind === 'branch_merged_to_main');
    assert.ok(milestone, 'branch_merged_to_main milestone exists');
    assert.equal(milestone.at, 1719360240000);
  });

  test('timeRange covers all entries', async () => {
    const { buildFeatureStoryRendering } = await import('../dist/domains/story/buildFeatureStoryRendering.js');

    const entries = [
      {
        entryId: 'e1',
        subjectKey: 'feat:F252',
        featId: 'F252',
        at: 1719360000000,
        kind: 'thread_split',
        source: 'event-stream',
        payload: { parentThreadId: 't1', childThreadId: 't2', proposalId: 'p1', catId: 'opus' },
      },
      {
        entryId: 'e2',
        subjectKey: 'feat:F252',
        featId: 'F252',
        at: 1719460000000,
        kind: 'thread_merge',
        source: 'event-stream',
        payload: { sourceThreadId: 't2', targetThreadId: 't1', messageId: 'm1', catId: 'codex' },
      },
    ];

    const projection = makeProjection('F252', entries);
    const threadMeta = makeThreadMeta([
      { id: 't1', name: 'T1' },
      { id: 't2', name: 'T2' },
    ]);

    const result = buildFeatureStoryRendering(projection, threadMeta, 'F252');

    assert.equal(result.timeRange.start, 1719360000000);
    assert.equal(result.timeRange.end, 1719460000000);
  });

  test('participants aggregated from entry catId fields', async () => {
    const { buildFeatureStoryRendering } = await import('../dist/domains/story/buildFeatureStoryRendering.js');

    const entries = [
      {
        entryId: 'split:p1',
        subjectKey: 'feat:F252',
        featId: 'F252',
        at: 1719360060000,
        kind: 'thread_split',
        source: 'event-stream',
        payload: { parentThreadId: 't1', childThreadId: 't2', proposalId: 'p1', catId: 'opus' },
      },
      {
        entryId: 'merge:m1',
        subjectKey: 'feat:F252',
        featId: 'F252',
        at: 1719360120000,
        kind: 'thread_merge',
        source: 'event-stream',
        payload: { sourceThreadId: 't1', targetThreadId: 't2', messageId: 'm1', catId: 'codex' },
      },
    ];

    const projection = makeProjection('F252', entries);
    const threadMeta = makeThreadMeta([
      { id: 't1', name: 'T1' },
      { id: 't2', name: 'T2' },
    ]);

    const result = buildFeatureStoryRendering(projection, threadMeta, 'F252');

    const t1Lane = result.lanes.find((l) => l.threadId === 't1');
    assert.ok(t1Lane);
    // t1 should have both opus (split from t1) and codex (merge from t1)
    assert.ok(t1Lane.participants.includes('opus'));
    assert.ok(t1Lane.participants.includes('codex'));
  });

  test('route-layer thread extraction uses title field (not name)', async () => {
    // P2 fix: threadStore.get() returns { id, title }, not { id, name }.
    // The route must read thread.title, not thread.name.
    // This test simulates the route's thread metadata extraction logic.
    const threadStoreResult = { id: 'thread_main', title: 'Main Discussion' };

    // Route extraction logic (mirrors story-rendering.ts line 97-101):
    const tid = 'thread_main';
    const threadMeta = new Map();
    threadMeta.set(tid, {
      threadId: tid,
      name: threadStoreResult.title ?? tid, // must use .title, not .name
      participants: [],
    });

    // Verify the extracted name is the title, not the threadId fallback
    assert.equal(threadMeta.get(tid).name, 'Main Discussion');

    // Counter-case: if we had used .name (which doesn't exist on Thread), we'd get threadId
    const wrongExtraction = threadStoreResult.name ?? tid;
    assert.equal(wrongExtraction, tid); // .name is undefined → falls back to tid
  });

  // ── AC-E6 Guest Lane (Cloud R2 P1 fix) ──

  test('thread_merge target-only lane is marked guest', async () => {
    const { buildFeatureStoryRendering } = await import('../dist/domains/story/buildFeatureStoryRendering.js');

    // F252 owns thread_dev (from thread_split).
    // Cross-post goes to thread_external (F666) via thread_merge.
    // thread_external should be a guest lane — not feature-owned.
    const entries = [
      {
        entryId: 'split:p1',
        subjectKey: 'feat:F252',
        featId: 'F252',
        at: 1719360060000,
        kind: 'thread_split',
        source: 'event-stream',
        payload: { parentThreadId: 'thread_main', childThreadId: 'thread_dev', proposalId: 'p1', catId: 'opus' },
      },
      {
        entryId: 'merge:m1',
        subjectKey: 'feat:F252',
        featId: 'F252',
        at: 1719360120000,
        kind: 'thread_merge',
        source: 'event-stream',
        payload: { sourceThreadId: 'thread_dev', targetThreadId: 'thread_external', messageId: 'm1', catId: 'codex' },
      },
    ];

    const projection = makeProjection('F252', entries);
    const threadMeta = makeThreadMeta([
      { id: 'thread_main', name: 'Main' },
      { id: 'thread_dev', name: 'Dev' },
      { id: 'thread_external', name: 'F666 Thread' },
    ]);

    const result = buildFeatureStoryRendering(projection, threadMeta, 'F252');

    // 3 lanes: thread_main (owned), thread_dev (owned), thread_external (guest)
    assert.equal(result.lanes.length, 3);

    const mainLane = result.lanes.find((l) => l.threadId === 'thread_main');
    const devLane = result.lanes.find((l) => l.threadId === 'thread_dev');
    const extLane = result.lanes.find((l) => l.threadId === 'thread_external');

    assert.ok(mainLane && !mainLane.guest, 'thread_main is owned (from thread_split parent)');
    assert.ok(devLane && !devLane.guest, 'thread_dev is owned (from thread_split child)');
    assert.ok(extLane, 'thread_external lane exists');
    assert.strictEqual(extLane.guest, true, 'thread_external is guest (only thread_merge target)');
  });

  test('thread_merge-only lanes are all guest (no ownership from merge)', async () => {
    const { buildFeatureStoryRendering } = await import('../dist/domains/story/buildFeatureStoryRendering.js');

    // Cloud R3 P2-1 fix: Only thread_split/git-ref-snapshot establish ownership.
    // thread_merge does NOT establish ownership for either side — because
    // CrossPostCollector falls back to target feature when source has no feat
    // association, making the source thread external in that scenario.
    // With no split/snapshot, both sides are guest (conservative fallback).
    const entries = [
      {
        entryId: 'merge:m1',
        subjectKey: 'feat:F252',
        featId: 'F252',
        at: 1719360120000,
        kind: 'thread_merge',
        source: 'event-stream',
        payload: { sourceThreadId: 'thread_ours', targetThreadId: 'thread_theirs', messageId: 'm1', catId: 'opus' },
      },
    ];

    const projection = makeProjection('F252', entries);
    const threadMeta = makeThreadMeta([
      { id: 'thread_ours', name: 'Our Thread' },
      { id: 'thread_theirs', name: 'Their Thread' },
    ]);

    const result = buildFeatureStoryRendering(projection, threadMeta, 'F252');

    assert.equal(result.lanes.length, 2);

    const oursLane = result.lanes.find((l) => l.threadId === 'thread_ours');
    const theirsLane = result.lanes.find((l) => l.threadId === 'thread_theirs');

    // Neither side gets ownership from merge alone — both are guest
    assert.ok(oursLane, 'source lane exists');
    assert.strictEqual(oursLane.guest, true, 'source thread is guest (merge alone ≠ ownership)');
    assert.ok(theirsLane, 'target lane exists');
    assert.strictEqual(theirsLane.guest, true, 'target thread is guest');
  });

  test('incoming cross-post: target thread owned by split, source is guest', async () => {
    const { buildFeatureStoryRendering } = await import('../dist/domains/story/buildFeatureStoryRendering.js');

    // Cloud R3 P2-1 scenario: F252 receives a cross-post from F666.
    // CrossPostCollector assigned the entry to F252 (target feature fallback).
    // thread_main is F252's own (established by split), thread_f666 is external.
    const entries = [
      {
        entryId: 'split:p1',
        subjectKey: 'feat:F252',
        featId: 'F252',
        at: 1719360060000,
        kind: 'thread_split',
        source: 'event-stream',
        payload: { parentThreadId: 'thread_main', childThreadId: 'thread_dev', proposalId: 'p1', catId: 'opus' },
      },
      {
        entryId: 'merge:incoming',
        subjectKey: 'feat:F252',
        featId: 'F252',
        at: 1719360120000,
        kind: 'thread_merge',
        source: 'event-stream',
        // Source is external (F666), target is our thread (F252)
        payload: { sourceThreadId: 'thread_f666', targetThreadId: 'thread_main', messageId: 'm1', catId: 'gpt52' },
      },
    ];

    const projection = makeProjection('F252', entries);
    const threadMeta = makeThreadMeta([
      { id: 'thread_main', name: 'F252 Main' },
      { id: 'thread_dev', name: 'F252 Dev' },
      { id: 'thread_f666', name: 'F666 Thread' },
    ]);

    const result = buildFeatureStoryRendering(projection, threadMeta, 'F252');

    assert.equal(result.lanes.length, 3);

    const mainLane = result.lanes.find((l) => l.threadId === 'thread_main');
    const devLane = result.lanes.find((l) => l.threadId === 'thread_dev');
    const f666Lane = result.lanes.find((l) => l.threadId === 'thread_f666');

    assert.ok(mainLane && !mainLane.guest, 'thread_main is owned (from split, despite being merge target)');
    assert.ok(devLane && !devLane.guest, 'thread_dev is owned (from split child)');
    assert.ok(f666Lane, 'F666 lane exists');
    assert.strictEqual(f666Lane.guest, true, 'thread_f666 is guest (external source, no split/snapshot)');
  });

  test('thread that is both split-child and merge-target is NOT guest', async () => {
    const { buildFeatureStoryRendering } = await import('../dist/domains/story/buildFeatureStoryRendering.js');

    // thread_review is introduced via thread_split (owned) AND referenced as
    // a thread_merge target. It should still be owned, not guest.
    const entries = [
      {
        entryId: 'split:p1',
        subjectKey: 'feat:F252',
        featId: 'F252',
        at: 1719360060000,
        kind: 'thread_split',
        source: 'event-stream',
        payload: { parentThreadId: 'thread_main', childThreadId: 'thread_review', proposalId: 'p1', catId: 'opus' },
      },
      {
        entryId: 'merge:m1',
        subjectKey: 'feat:F252',
        featId: 'F252',
        at: 1719360120000,
        kind: 'thread_merge',
        source: 'event-stream',
        payload: { sourceThreadId: 'thread_main', targetThreadId: 'thread_review', messageId: 'm1', catId: 'codex' },
      },
    ];

    const projection = makeProjection('F252', entries);
    const threadMeta = makeThreadMeta([
      { id: 'thread_main', name: 'Main' },
      { id: 'thread_review', name: 'Review' },
    ]);

    const result = buildFeatureStoryRendering(projection, threadMeta, 'F252');

    assert.equal(result.lanes.length, 2);

    const mainLane = result.lanes.find((l) => l.threadId === 'thread_main');
    const reviewLane = result.lanes.find((l) => l.threadId === 'thread_review');

    assert.ok(mainLane && !mainLane.guest, 'thread_main is owned');
    assert.ok(reviewLane && !reviewLane.guest, 'thread_review is owned (split-child overrides merge-target)');
  });

  test('unknown thread falls back to threadId as name', async () => {
    const { buildFeatureStoryRendering } = await import('../dist/domains/story/buildFeatureStoryRendering.js');

    const entries = [
      {
        entryId: 'split:p1',
        subjectKey: 'feat:F252',
        featId: 'F252',
        at: 1719360060000,
        kind: 'thread_split',
        source: 'event-stream',
        payload: {
          parentThreadId: 'thread_unknown',
          childThreadId: 'thread_also_unknown',
          proposalId: 'p1',
          catId: 'opus',
        },
      },
    ];

    const projection = makeProjection('F252', entries);
    // Empty thread meta — no names available
    const threadMeta = makeThreadMeta([]);

    const result = buildFeatureStoryRendering(projection, threadMeta, 'F252');

    assert.equal(result.lanes.length, 2);
    const unknownLane = result.lanes.find((l) => l.threadId === 'thread_unknown');
    assert.ok(unknownLane);
    assert.equal(unknownLane.threadName, 'thread_unknown'); // fallback to ID
  });
});
