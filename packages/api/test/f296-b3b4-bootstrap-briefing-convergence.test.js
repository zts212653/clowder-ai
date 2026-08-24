// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { buildSessionBootstrap } = await import('../dist/domains/cats/services/session/SessionBootstrap.js');
const { buildBriefingMessage, formatContextBriefing } = await import(
  '../dist/domains/cats/services/agents/routing/format-briefing.js'
);
const { projectRankedSource, selectDirectiveSources } = await import(
  '../dist/domains/cats/services/agents/routing/source-ranking.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');

const COORDINATE = {
  providerCarrier: { provider: 'codex', carrier: 'exec_json' },
  invocationOrigin: 'interactive',
  routeTopology: 'serial',
};

function modeProjection(contextMode) {
  return {
    coordinate: COORDINATE,
    contextEpoch: 7,
    contextMode,
    transition: contextMode === 'cold' ? 'fresh' : 'resumed',
    reason: contextMode === 'cold' ? 'resume_rejected' : 'resume_confirmed',
  };
}

function surfaceProjection(contextMode = 'cold') {
  return {
    ...modeProjection(contextMode),
    deltaSize: 'large',
    presentationCounts: { T0: 3, T1: 1, T2: 2, invalid: 0 },
  };
}

const COVERAGE_MAP = {
  omitted: { count: 12, timeRange: { from: 10, to: 20 }, participants: ['user-1'] },
  burst: { count: 4, timeRange: { from: 21, to: 30 } },
  anchorIds: [],
  threadMemory: null,
  recallPointer: { candidateCount: 0 },
};

function bootstrapFixture() {
  const calls = { chain: 0, active: 0, digest: 0, memory: 0, task: 0, thread: 0 };
  const sealed = {
    id: 'session-1',
    catId: 'opus',
    threadId: 'thread-b3b4',
    userId: 'user-1',
    status: 'sealed',
    seq: 0,
    sealReason: 'cat_initiated_handoff',
    catHandoffNote: {
      done: 'implemented exact handoff',
      nextSteps: 'continue from the typed projection',
    },
  };
  const active = { ...sealed, id: 'session-2', status: 'active', seq: 1, sealReason: undefined };
  return {
    calls,
    opts: {
      sessionChainStore: {
        async getChain() {
          calls.chain += 1;
          return [sealed, active];
        },
        async getActive() {
          calls.active += 1;
          return active;
        },
      },
      transcriptReader: {
        async readDigest() {
          calls.digest += 1;
          return {
            time: null,
            invocations: [],
            filesTouched: [],
            errors: [],
            recentMessages: [{ role: 'assistant', content: 'POISON HISTORICAL DIGEST' }],
          };
        },
      },
      threadStore: {
        async getThreadMemory() {
          calls.memory += 1;
          return { summary: 'POISON THREAD MEMORY', sessionsIncorporated: 9 };
        },
        async get() {
          calls.thread += 1;
          return { id: 'thread-b3b4', title: 'POISON RECALL QUERY' };
        },
      },
      taskStore: {
        async listByThread() {
          calls.task += 1;
          return [{ id: 'task-1', title: 'POISON TASK SNAPSHOT', status: 'todo' }];
        },
      },
    },
  };
}

describe('F296 B3b-4: SessionBootstrap consumes the epoch-owned projection', () => {
  test('hot continuity structurally suppresses bootstrap before any history store read', async () => {
    const { calls, opts } = bootstrapFixture();
    const result = await buildSessionBootstrap(
      { ...opts, contextProjection: modeProjection('hot') },
      'opus',
      'thread-b3b4',
    );

    assert.equal(result, null);
    assert.deepEqual(calls, { chain: 0, active: 0, digest: 0, memory: 0, task: 0, thread: 0 });
  });

  test('cold continuity admits only the exact handoff and a content-free drill pointer', async () => {
    const { calls, opts } = bootstrapFixture();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('epoch-aware bootstrap must not run heuristic recall');
    };
    try {
      const result = await buildSessionBootstrap(
        { ...opts, contextProjection: modeProjection('cold') },
        'opus',
        'thread-b3b4',
      );

      assert.ok(result);
      assert.match(result.text, /\[Cat Handoff Note/);
      assert.match(result.text, /implemented exact handoff/);
      assert.match(result.text, /\[Session Recall Pointer\]/);
      for (const poison of ['POISON HISTORICAL DIGEST', 'POISON THREAD MEMORY', 'POISON TASK SNAPSHOT']) {
        assert.doesNotMatch(result.text, new RegExp(poison));
      }
      assert.equal(calls.digest, 0);
      assert.equal(calls.memory, 0);
      assert.equal(calls.task, 0);
      assert.equal(calls.thread, 0);
      assert.deepEqual(result.presentationCounts, { T0: 1, T1: 0, T2: 1, invalid: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('F296 B3b-4: Context Briefing is a read-only view of the shared projection', () => {
  test('formatter copies coordinate, mode/reason and tier counts without recomputing them', () => {
    const projection = surfaceProjection();
    const result = formatContextBriefing(COVERAGE_MAP, undefined, undefined, projection);

    assert.deepEqual(result.richBlock.contextSurfaceProjection, projection);
    assert.match(result.summary, /cold/);
    assert.match(result.summary, /resume_rejected/);
    assert.match(result.summary, /T0 3/);
    assert.match(result.summary, /T1 1/);
    assert.match(result.summary, /T2 2/);
  });

  test('persisted card carries the typed projection in metadata and displays its coordinate', () => {
    const projection = surfaceProjection();
    const message = buildBriefingMessage(COVERAGE_MAP, 'thread-b3b4', {
      contextSurfaceProjection: projection,
    });
    const card = message.extra.rich.blocks[0];

    assert.deepEqual(card.meta?.contextSurfaceProjection, projection);
    assert.deepEqual(card.fields?.slice(-3), [
      { label: '坐标', value: 'codex/exec_json · interactive · serial' },
      { label: '上下文', value: 'cold · resume_rejected · epoch 7 · large' },
      { label: '呈现', value: 'T0 3 · T1 1 · T2 2 · invalid 0' },
    ]);
  });
});

describe('F296 B3b-4: canonical subject eligibility crosses mapToPresentation', () => {
  test('a producer boolean cannot promote a recency source to directive', () => {
    const source = {
      type: 'file',
      ref: 'notes/old.md',
      label: 'old note',
      provenance: 'recency',
      directiveEligible: true,
      updatedAt: 123,
    };

    assert.deepEqual(projectRankedSource(source), {
      subjectKey: 'artifact:file:notes/old.md',
      asOf: { kind: 'as_of', value: 123 },
      sourceTier: 'T2',
      presentation: 'pointer',
    });
    assert.deepEqual(selectDirectiveSources([source]), []);
  });
});

const CODEX_EXEC = {
  provider: 'openai',
  carrier: 'exec_json',
  reportsRuntimeWindow: true,
  authoritativeUsage: true,
  usageTelemetry: 'available',
  nativeWindowControl: true,
  nativeCompressionControl: true,
  observesCompression: false,
  reason: 'F296 B3b-4 integration fixture',
};

function seedRouteMessages(messageStore) {
  const baseTs = Date.now() - 40 * 60_000;
  for (let index = 0; index < 30; index += 1) {
    messageStore.append({
      threadId: 'thread-b3b4',
      userId: 'user-1',
      catId: null,
      content: `message ${index} about presentation convergence`,
      mentions: [],
      timestamp: baseTs + index * 60_000,
    });
  }
  return messageStore.append({
    threadId: 'thread-b3b4',
    userId: 'user-1',
    catId: null,
    content: '@opus continue',
    mentions: ['opus'],
    timestamp: baseTs + 31 * 60_000,
  });
}

function routeThreadStore() {
  return {
    get: async () => ({ id: 'thread-b3b4', title: 'F296 convergence', userId: 'user-1', createdAt: Date.now() }),
    getThreadMemory: async () => ({
      summary: 'POISON ROUTE THREAD MEMORY',
      sessionsIncorporated: 9,
      recentArtifacts: [
        {
          type: 'file',
          ref: 'POISON-RECENCY-ARTIFACT.md',
          label: 'POISON-RECENCY-ARTIFACT.md',
          updatedAt: Date.now(),
          updatedBy: 'opus',
        },
      ],
    }),
    isRebornSession: async () => false,
    create: async () => ({}),
    list: async () => [],
    listByProject: async () => [],
    addParticipants: async () => {},
    getParticipants: async () => [],
    getParticipantsWithActivity: async () => [],
    updateParticipantActivity: async () => {},
    updateLastActive: async () => {},
    updateThreadMemory: async () => {},
    getVotingState: async () => null,
    updateVotingState: async () => {},
    consumeMentionRoutingFeedback: async () => null,
  };
}

function createRouteFixture(captured) {
  const messageStore = new MessageStore();
  const current = seedRouteMessages(messageStore);
  let invocationSeq = 0;
  let providerAttempt = 0;
  let epoch = 0;
  const sessionChainStore = new SessionChainStore();
  const sealed = sessionChainStore.create({
    catId: 'opus',
    threadId: 'thread-b3b4',
    userId: 'user-1',
  });
  sessionChainStore.update(sealed.id, {
    status: 'sealed',
    sealReason: 'cat_initiated_handoff',
    catHandoffNote: { done: 'route exact handoff', nextSteps: 'consume the shared projection' },
  });
  sessionChainStore.create({
    catId: 'opus',
    threadId: 'thread-b3b4',
    userId: 'user-1',
  });
  return {
    currentUserMessageId: current.id,
    services: {
      opus: {
        contextCapability: () => CODEX_EXEC,
        async *invoke(prompt) {
          captured.push(prompt);
          providerAttempt += 1;
          if (providerAttempt === 1) {
            yield {
              type: 'error',
              catId: 'opus',
              error: 'No conversation found with session ID: stale-runtime-session',
              timestamp: Date.now(),
            };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
            return;
          }
          yield { type: 'text', catId: 'opus', content: 'recovered [签名/model🐾]', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
    },
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-b3b4-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => 'stale-runtime-session',
        getOrCreate: async () => ({}),
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: routeThreadStore(),
      sessionChainStore,
      transcriptReader: {
        readDigest: async () => ({
          time: null,
          invocations: [],
          filesTouched: [],
          errors: [],
          recentMessages: [{ role: 'assistant', content: 'POISON ROUTE DIGEST' }],
        }),
      },
      contextEpochOwner: {
        async resolve(input) {
          epoch += 1;
          return {
            scopeKey: `user-1::${input.catId}::thread-b3b4`,
            contextEpoch: epoch,
            contextMode: 'cold',
            lastTransitionRef: input.disposition.evidenceRef,
            consumedCompactionEventIds: [],
            transition: input.disposition.state === 'fresh' ? 'fresh' : 'unknown',
            normalizedDisposition: input.disposition,
            healthSignals: [],
          };
        },
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore,
    deliveryCursorStore: new DeliveryCursorStore(),
    evidenceStore: {
      search: async () => [],
      upsert: async () => {},
      deleteByAnchor: async () => {},
      getByAnchor: async () => null,
      health: async () => true,
      initialize: async () => {},
    },
  };
}

function storedBriefings(messageStore) {
  return messageStore
    .getByThread('thread-b3b4', 1_000)
    .filter((message) => message.origin === 'briefing' && message.extra?.systemKind === 'context_briefing');
}

describe('F296 B3b-4: real routes publish the final generation projection', () => {
  for (const [routeName, loadRoute, topology] of [
    [
      'serial',
      async () => (await import('../dist/domains/cats/services/agents/routing/route-serial.js')).routeSerial,
      'serial',
    ],
    [
      'parallel',
      async () => (await import('../dist/domains/cats/services/agents/routing/route-parallel.js')).routeParallel,
      'parallel',
    ],
  ]) {
    test(`${routeName}: replacement rebuilds bootstrap and briefing from the second epoch decision`, async () => {
      const captured = [];
      const deps = createRouteFixture(captured);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: [] }) });
      try {
        const route = await loadRoute();
        for await (const _ of route(deps, ['opus'], '@opus continue', 'user-1', 'thread-b3b4', {
          currentUserMessageId: deps.currentUserMessageId,
        })) {
          // drain
        }
      } finally {
        globalThis.fetch = originalFetch;
      }

      assert.equal(captured.length, 2, 'fixture must exercise provider replacement');
      for (const prompt of captured) {
        assert.match(prompt, /\[Cat Handoff Note/);
        assert.match(prompt, /\[Session Recall Pointer\]/);
        assert.doesNotMatch(prompt, /POISON ROUTE DIGEST|POISON ROUTE THREAD MEMORY/);
      }

      const briefings = storedBriefings(deps.messageStore);
      assert.equal(briefings.length, 1, 'replacement must persist only the final-generation card');
      const card = briefings[0].extra.rich.blocks[0];
      assert.doesNotMatch(card.bodyMarkdown ?? '', /POISON-RECENCY-ARTIFACT/);
      const projection = card.meta?.contextSurfaceProjection;
      assert.equal(projection.reason, 'resume_failed');
      assert.equal(projection.contextEpoch, 2);
      assert.equal(projection.coordinate.routeTopology, topology);
      assert.equal(projection.coordinate.providerCarrier.provider, 'codex');
      assert.equal(projection.coordinate.providerCarrier.carrier, 'exec_json');
      assert.equal(projection.presentationCounts.T0 > 0, true);
      assert.equal(projection.presentationCounts.T2 > 0, true);
    });
  }
});
