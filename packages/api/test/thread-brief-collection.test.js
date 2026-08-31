import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('ThreadBrief current discovery and collection', () => {
  test('resolves canonical live only for indexed candidates and drops suppressed zombies', async () => {
    const { ThreadBriefCurrentDiscovery } = await import(
      '../dist/domains/thread-progress/ThreadBriefCurrentDiscovery.js'
    );
    const liveReads = [];
    const discovery = new ThreadBriefCurrentDiscovery({
      listRunningThreadIds: async () => ['thread-live', 'thread-zombie'],
      listAttention: async () => [
        { threadId: 'thread-attention', item: { kind: 'approval', label: '请确认', createdAt: 10 } },
      ],
      listWaits: async () => [{ threadId: 'thread-wait', item: { kind: 'external', label: '等待 CI', createdAt: 20 } }],
      readLiveExecutions: async (threadId) => {
        liveReads.push(threadId);
        return threadId === 'thread-live'
          ? [{ catId: 'opus', startedAt: 30, turnInvocationId: 'turn-1', degraded: false }]
          : [];
      },
    });

    const result = await discovery.discover('user-1');
    assert.deepEqual([...result.keys()].sort(), ['thread-attention', 'thread-live', 'thread-wait']);
    assert.deepEqual(liveReads.sort(), ['thread-live', 'thread-zombie']);
  });

  test('returns all current briefs and independently paginates non-current recent briefs', async () => {
    const { ThreadBriefCollectionAssembler } = await import(
      '../dist/domains/thread-progress/ThreadBriefCollectionAssembler.js'
    );
    const threads = new Map([
      ['thread-run', ordinaryThread('thread-run')],
      ['thread-attention', ordinaryThread('thread-attention')],
      ['thread-recent', ordinaryThread('thread-recent')],
      ['thread-system', { ...ordinaryThread('thread-system'), systemKind: 'eval_domain' }],
    ]);
    let observedExclude;
    const assembler = new ThreadBriefCollectionAssembler({
      threadStore: { get: async (threadId) => threads.get(threadId) ?? null },
      receiptStore: {
        listRecentThreads: async (_owner, options) => {
          observedExclude = options.excludeThreadIds;
          return {
            items: [
              { threadId: 'thread-run', lastProgressAt: 400 },
              { threadId: 'thread-recent', lastProgressAt: 300 },
              { threadId: 'thread-system', lastProgressAt: 200 },
            ].filter((item) => !options.excludeThreadIds.has(item.threadId)),
            nextCursor: 'next-page',
          };
        },
      },
      briefAssembler: { assemble: async (thread, _owner, facts) => briefFor(thread, facts) },
      discoverCurrentFacts: async () =>
        new Map([
          ['thread-run', { live: [{ catId: 'opus', startedAt: 20, degraded: false }], attention: [], waits: [] }],
          [
            'thread-attention',
            { live: [], attention: [{ kind: 'approval', label: '请确认', createdAt: 10 }], waits: [] },
          ],
        ]),
      now: () => 500,
    });

    const result = await assembler.assemble('user-1', { limit: 1 });
    assert.deepEqual(
      result.current.map((brief) => brief.thread.id),
      ['thread-attention', 'thread-run'],
      'current is complete and deterministically partitioned before recent',
    );
    assert.equal(observedExclude.has('thread-run'), true);
    assert.deepEqual(
      result.recent.map((brief) => brief.thread.id),
      ['thread-recent'],
    );
    assert.equal(result.nextCursor, 'next-page');
    assert.equal(result.generatedAt, 500);
  });

  test('does not truncate current when it exceeds the recent page limit', async () => {
    const { ThreadBriefCollectionAssembler } = await import(
      '../dist/domains/thread-progress/ThreadBriefCollectionAssembler.js'
    );
    const threads = new Map();
    const currentFacts = new Map();
    for (let index = 0; index < 55; index++) {
      const threadId = `thread-${String(index).padStart(2, '0')}`;
      threads.set(threadId, ordinaryThread(threadId));
      currentFacts.set(threadId, {
        live: [{ catId: 'opus', startedAt: index, degraded: false }],
        attention: [],
        waits: [],
      });
    }
    const assembler = new ThreadBriefCollectionAssembler({
      threadStore: { get: async (threadId) => threads.get(threadId) ?? null },
      receiptStore: { listRecentThreads: async () => ({ items: [], nextCursor: null }) },
      briefAssembler: { assemble: async (thread, _owner, facts) => briefFor(thread, facts) },
      discoverCurrentFacts: async () => currentFacts,
    });

    const result = await assembler.assemble('user-1', { limit: 1 });
    assert.equal(result.current.length, 55);
    assert.equal(result.recent.length, 0);
  });

  test('does not run per-thread liveness reads for recent-only threads', async () => {
    const [
      { ThreadBriefCollectionAssembler },
      { ThreadBriefAssembler },
      { ThreadProgressReceiptStore },
      { TaskStore },
    ] = await Promise.all([
      import('../dist/domains/thread-progress/ThreadBriefCollectionAssembler.js'),
      import('../dist/domains/thread-progress/ThreadBriefAssembler.js'),
      import('../dist/domains/thread-progress/ThreadProgressReceiptStore.js'),
      import('../dist/domains/cats/services/stores/ports/TaskStore.js'),
    ]);
    const receiptStore = new ThreadProgressReceiptStore();
    await receiptStore.appendIfAbsent({
      v: 1,
      id: 'receipt-recent-only',
      ownerUserId: 'user-1',
      threadId: 'thread-recent-only',
      kind: 'milestone',
      impactAxes: ['verified_outcome'],
      actor: { kind: 'cat', catId: 'opus' },
      headline: '形成进展',
      provenance: [{ kind: 'invocation', invocationId: 'inv-recent-only' }],
      sourceKey: 'source-recent-only',
      occurredAt: 100,
      createdAt: 100,
    });
    let liveReads = 0;
    const briefAssembler = new ThreadBriefAssembler({
      receiptStore,
      taskStore: new TaskStore(),
      readLiveExecutions: async () => {
        liveReads++;
        return [];
      },
      readAttention: async () => [],
      readWaits: async () => [],
    });
    const collectionAssembler = new ThreadBriefCollectionAssembler({
      threadStore: {
        get: async (threadId) => (threadId === 'thread-recent-only' ? ordinaryThread(threadId) : null),
      },
      receiptStore,
      briefAssembler,
      discoverCurrentFacts: async () => new Map(),
    });

    const result = await collectionAssembler.assemble('user-1', { limit: 50 });
    assert.deepEqual(
      result.recent.map((brief) => brief.thread.id),
      ['thread-recent-only'],
    );
    assert.equal(liveReads, 0, 'recent projection must use the proven-empty current snapshot');
  });
});

function ordinaryThread(id) {
  return {
    id,
    title: id,
    projectPath: 'default',
    createdBy: 'user-1',
    participants: [],
    lastActiveAt: 1,
    createdAt: 1,
  };
}

function briefFor(thread, facts) {
  const presentationState =
    facts.attention.length > 0
      ? 'needs_user'
      : facts.live.length > 0
        ? 'running'
        : facts.waits.length > 0
          ? 'waiting_external'
          : 'idle';
  return {
    v: 1,
    thread: { id: thread.id, title: thread.title },
    contextHeading: { label: '会话', text: thread.title },
    availability: 'ok',
    presentationState,
    currentExecutions: facts.live.map((item) => ({
      catId: item.catId,
      startedAt: item.startedAt,
      confidence: item.degraded ? 'degraded' : 'confirmed',
    })),
    attention: facts.attention,
    waits: facts.waits,
    recentProgress: [],
    lastProgressAt: null,
    nextStep: null,
    openWorkTaskCount: 0,
    hasHistory: true,
    generatedAt: 100,
  };
}
