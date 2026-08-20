// F296 AC-A1: heuristic recall bodies must leave the model-facing prompt.
// Both auto-recall surfaces (cold context + SessionBootstrap) may only emit a
// content-free retrieval pointer; candidate titles/snippets/bodies are gone.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { assembleIncrementalContext: assembleRaw } = await import(
  '../dist/domains/cats/services/agents/routing/route-helpers.js'
);
const { recallEvidenceWithProvenance } = await import(
  '../dist/domains/cats/services/agents/routing/context-transport.js'
);
const { buildSessionBootstrap } = await import('../dist/domains/cats/services/session/SessionBootstrap.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');

const CANDIDATE_TITLE = 'F091 Secret Sauce Distillation';
const CANDIDATE_SNIPPET = 'Phase C shipped the distillation queue with a nightly rebuild job';

function mockMsg(overrides) {
  return {
    threadId: overrides.threadId ?? 'thread-1',
    userId: overrides.userId ?? 'user-1',
    catId: overrides.catId ?? null,
    content: overrides.content ?? 'test message',
    mentions: [],
    timestamp: overrides.timestamp ?? Date.now(),
  };
}

function seedMessages(messageStore, count) {
  const baseTs = Date.now() - count * 60_000;
  for (let i = 0; i < count; i++) {
    messageStore.append(
      mockMsg({ content: `message ${i} about Redis and deployment`, timestamp: baseTs + i * 60_000 }),
    );
  }
}

function mockThreadStore(title = 'Redis deployment thread') {
  return {
    get: async () => ({ id: 'thread-1', title, userId: 'user-1', createdAt: Date.now() }),
    create: async () => ({}),
    list: async () => [],
    listByProject: async () => [],
    addParticipants: async () => {},
    getParticipants: async () => [],
    getParticipantsWithActivity: async () => [],
    updateParticipantActivity: async () => {},
    updateLastActive: async () => {},
    getThreadMemory: async () => null,
    updateThreadMemory: async () => {},
  };
}

function mockEvidenceStore(count = 3) {
  return {
    search: async () =>
      Array.from({ length: count }, (_, i) => ({
        anchor: `F09${i}`,
        kind: 'feature',
        status: 'active',
        title: `${CANDIDATE_TITLE} #${i}`,
        summary: `${CANDIDATE_SNIPPET} (${i})`,
        sourcePath: `docs/features/F09${i}.md`,
        keywords: [],
      })),
    upsert: async () => {},
    deleteByAnchor: async () => {},
    getByAnchor: async () => null,
    health: async () => true,
    initialize: async () => {},
  };
}

function buildDeps(messageStore, deliveryCursorStore, options = {}) {
  return {
    services: {},
    invocationDeps: { threadStore: options.threadStore ?? mockThreadStore() },
    messageStore,
    deliveryCursorStore,
    evidenceStore: options.evidenceStore,
  };
}

function assembleIncrementalContext(deps) {
  return assembleRaw(deps, 'user-1', 'thread-1', 'opus', undefined, undefined, {
    effectiveMaxContextTokens: 500_000,
  });
}

const HC_CONFIG = {
  maxEvidenceHits: 3,
  evidenceRecallTimeoutMs: 500,
};

describe('F296 AC-A1: heuristic recall bodies exit the model prompt', () => {
  test('cold context: candidate titles and snippets never reach the prompt', async () => {
    const messageStore = new MessageStore();
    seedMessages(messageStore, 20);
    const deps = buildDeps(messageStore, new DeliveryCursorStore(), { evidenceStore: mockEvidenceStore(3) });

    const result = await assembleIncrementalContext(deps);

    assert.ok(result.contextText.includes('智能窗口'), 'precondition: cold smart-window path');
    assert.ok(!result.contextText.includes(CANDIDATE_TITLE), 'candidate title must not be injected');
    assert.ok(!result.contextText.includes(CANDIDATE_SNIPPET), 'candidate snippet must not be injected');
    assert.ok(!result.contextText.includes('[Evidence:'), 'legacy evidence body line must be gone');
    assert.match(result.contextText, /\[Related evidence — pointer only\]/, 'content-free pointer must remain');
    assert.match(result.contextText, /cat_cafe_search_evidence/, 'pointer must carry an exact drill tool');
    assert.match(result.contextText, /3/, 'pointer may state the content-free candidate count');
  });

  test('cold context: coverage map carries no candidate body, only a pointer count', async () => {
    const messageStore = new MessageStore();
    seedMessages(messageStore, 20);
    const deps = buildDeps(messageStore, new DeliveryCursorStore(), { evidenceStore: mockEvidenceStore(2) });

    const result = await assembleIncrementalContext(deps);

    const serialized = JSON.stringify(result.coverageMap);
    assert.ok(!serialized.includes(CANDIDATE_TITLE), 'coverage map must not carry candidate titles');
    assert.ok(!serialized.includes(CANDIDATE_SNIPPET), 'coverage map must not carry candidate snippets');
    assert.equal(result.coverageMap.recallPointer.candidateCount, 2, 'content-free count is retained');
    assert.equal(
      /** @type {Record<string, unknown>} */ (result.coverageMap).retrievalHints,
      undefined,
      'title-bearing retrievalHints field is removed from the contract',
    );
  });

  test('cold context: F263 trace records a pointer, not presented candidate bodies', async () => {
    const messageStore = new MessageStore();
    seedMessages(messageStore, 20);
    const deps = buildDeps(messageStore, new DeliveryCursorStore(), { evidenceStore: mockEvidenceStore(3) });

    const result = await assembleIncrementalContext(deps);
    const presentation = result.pushRecallPresentations?.[0];

    assert.ok(presentation, 'push recall presentation is still traced');
    assert.equal(presentation.surface, 'cold_context');
    assert.equal(presentation.presentationKind, 'pointer', 'trace must be marked pointer, not body');
    assert.equal(presentation.candidates.length, 3, 'candidate coordinates stay in the trace');
    const serialized = JSON.stringify(presentation.candidates);
    assert.ok(!serialized.includes(CANDIDATE_TITLE), 'trace candidates stay content-free');
  });

  test('recall producer returns content-free coordinates only', async () => {
    const result = await recallEvidenceWithProvenance(
      mockEvidenceStore(2),
      'Redis deployment thread',
      'how do we handle Redis?',
      [],
      HC_CONFIG,
    );

    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(CANDIDATE_TITLE), 'producer must not return candidate titles');
    assert.ok(!serialized.includes(CANDIDATE_SNIPPET), 'producer must not return candidate summaries');
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(Object.keys(result.candidates[0]).sort(), ['anchor', 'docKind', 'rank', 'sourcePath']);
  });

  test('SessionBootstrap: auto recall degrades to a content-free pointer', async () => {
    const sessions = [
      { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 0 },
      { id: 'sess-1', catId: 'opus', threadId: 'thread-1', status: 'active', seq: 1 },
    ];
    const sessionChainStore = {
      getActive: (catId, threadId) =>
        sessions.find((s) => s.catId === catId && s.threadId === threadId && s.status === 'active') ?? null,
      getChain: (catId, threadId) => sessions.filter((s) => s.catId === catId && s.threadId === threadId),
    };
    const threadStore = {
      get: async () => ({ id: 'thread-1', title: 'Memory lifecycle telemetry' }),
      getThreadMemory: async () => null,
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        results: [
          {
            title: CANDIDATE_TITLE,
            anchor: 'F091',
            sourcePath: 'docs/features/F091.md',
            snippet: CANDIDATE_SNIPPET,
            sourceType: 'feature',
          },
        ],
      }),
    });
    try {
      const result = await buildSessionBootstrap(
        { sessionChainStore, transcriptReader: { readDigest: async () => null }, threadStore },
        'opus',
        'thread-1',
      );

      assert.ok(!result.text.includes(CANDIDATE_TITLE), 'bootstrap must not inject candidate titles');
      assert.ok(!result.text.includes(CANDIDATE_SNIPPET), 'bootstrap must not inject candidate snippets');
      assert.match(result.text, /\[Project Knowledge Recall — pointer only\]/);
      assert.match(result.text, /cat_cafe_search_evidence/);
      const presentation = result.pushRecallPresentations?.[0];
      assert.ok(presentation, 'trace is still emitted');
      assert.equal(presentation.presentationKind, 'pointer');
      assert.ok(!JSON.stringify(presentation.candidates).includes(CANDIDATE_TITLE));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('no bypass: route-serial / route-parallel own no second recall-body producer', () => {
    const routingDir = fileURLToPath(new URL('../src/domains/cats/services/agents/routing/', import.meta.url));
    for (const file of ['route-serial.ts', 'route-parallel.ts']) {
      const source = readFileSync(`${routingDir}${file}`, 'utf8');
      assert.ok(!source.includes('recallEvidence'), `${file} must not run its own evidence recall`);
      assert.ok(!source.includes('[Related evidence'), `${file} must not format its own evidence section`);
      assert.ok(
        !source.includes('[Project Knowledge Recall'),
        `${file} must not format its own knowledge recall section`,
      );
    }
  });
});
