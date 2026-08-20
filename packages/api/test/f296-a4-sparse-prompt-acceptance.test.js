// F296 AC-A4: Phase A removed candidate bodies, lifecycle-less open questions and
// regex/recency directives. This file is the acceptance gate for what is LEFT:
// a deliberately sparse prompt. It asserts sparseness at the real prompt boundary
// (what the provider actually receives), not at a helper's return value — and it
// asserts that nothing new filled the space back in.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
const { buildSessionBootstrap } = await import('../dist/domains/cats/services/session/SessionBootstrap.js');
const { buildBriefingMessage } = await import('../dist/domains/cats/services/agents/routing/format-briefing.js');

// --- Poisoned inputs: every Phase A failure mode, wired at once. ---
const CANDIDATE_TITLE = 'F091 Secret Sauce Distillation';
const CANDIDATE_SNIPPET = 'Phase C shipped the distillation queue';
const CLOSED_QUESTION = '要不要把 delivery cursor 拆成两个 store？(PR #1108 已合入两个月)';
const DECISION = 'cursor 用单 store';
const STALE_ARTIFACT = '.codex-tmp-pr1108-review.md';

const THREAD_MEMORY = {
  v: 1,
  summary: 'Earlier sessions converged on the cursor contract.',
  sessionsIncorporated: 4,
  updatedAt: Date.now(),
  decisions: [DECISION],
  decisionRefs: [{ threadId: 'thread-a4' }],
  openQuestions: [CLOSED_QUESTION],
  openQuestionRefs: [{ threadId: 'thread-a4' }],
  recentArtifacts: [
    { type: 'file', ref: STALE_ARTIFACT, label: STALE_ARTIFACT, updatedAt: Date.now(), updatedBy: 'opus' },
  ],
};

function mockThreadStore() {
  return {
    get: async () => ({ id: 'thread-a4', title: 'delivery cursor thread', userId: 'user-1', createdAt: Date.now() }),
    create: async () => ({}),
    list: async () => [],
    listByProject: async () => [],
    addParticipants: async () => {},
    getParticipants: async () => [],
    getParticipantsWithActivity: async () => [],
    updateParticipantActivity: async () => {},
    updateLastActive: async () => {},
    getThreadMemory: async () => THREAD_MEMORY,
    updateThreadMemory: async () => {},
    getVotingState: async () => null,
    updateVotingState: async () => {},
    consumeMentionRoutingFeedback: async () => null,
  };
}

function mockEvidenceStore() {
  return {
    search: async () => [
      {
        anchor: 'F091',
        kind: 'feature',
        status: 'active',
        title: CANDIDATE_TITLE,
        summary: CANDIDATE_SNIPPET,
        sourcePath: 'docs/features/F091.md',
        keywords: [],
      },
    ],
    upsert: async () => {},
    deleteByAnchor: async () => {},
    getByAnchor: async () => null,
    health: async () => true,
    initialize: async () => {},
  };
}

/** Fake provider that records exactly what it was asked to run on. */
function createCapturingService(catId, captured) {
  return {
    async *invoke(prompt) {
      captured.push(prompt);
      yield { type: 'text', catId, content: `ok [签名/model🐾]`, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function seedColdThread(messageStore, count = 60) {
  const baseTs = Date.now() - (count + 1) * 60_000;
  for (let i = 0; i < count; i++) {
    messageStore.append({
      threadId: 'thread-a4',
      userId: 'user-1',
      catId: null,
      content: `message ${i} about the delivery cursor contract`,
      mentions: [],
      timestamp: baseTs + i * 60_000,
    });
  }
  // The trigger message must exist in the store: incremental (cold-window) mode
  // only engages when the route knows which message is the current one.
  return messageStore.append({
    threadId: 'thread-a4',
    userId: 'user-1',
    catId: null,
    content: '@opus 看看这个',
    mentions: ['opus'],
    timestamp: baseTs + count * 60_000,
  });
}

function createRouteDeps(catIds, captured) {
  const messageStore = new MessageStore();
  const currentUserMessage = seedColdThread(messageStore);
  let seq = 0;
  const services = {};
  for (const catId of catIds) services[catId] = createCapturingService(catId, captured);
  return {
    currentUserMessageId: currentUserMessage.id,
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-a4-${++seq}`, callbackToken: `tok-a4-${seq}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: mockThreadStore(),
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore,
    deliveryCursorStore: new DeliveryCursorStore(),
    evidenceStore: mockEvidenceStore(),
  };
}

/**
 * The single acceptance predicate, applied to whatever a surface actually emits.
 * Phase A is "no fake authority", so this asserts absence of the three retired
 * classes plus absence of anything that would refill the space.
 */
function assertPhaseASparse(text, label) {
  assert.ok(!text.includes(CANDIDATE_TITLE), `${label}: AC-A1 — no heuristic candidate title`);
  assert.ok(!text.includes(CANDIDATE_SNIPPET), `${label}: AC-A1 — no heuristic candidate snippet`);
  assert.ok(!text.includes('[Evidence:'), `${label}: AC-A1 — no legacy evidence body line`);
  assert.ok(!text.includes(CLOSED_QUESTION), `${label}: AC-A2 — no lifecycle-less open question`);
  assert.ok(!text.includes('待决问题'), `${label}: AC-A2 — no open-question section`);
  // AC-A3: a deleted temp artifact must never become a directive truth source.
  const directiveLine = text.split('\n').find((line) => line.startsWith('真相源:'));
  if (directiveLine) {
    assert.ok(
      !directiveLine.includes(STALE_ARTIFACT),
      `${label}: AC-A3 — stale artifact must not become 真相源, got: ${directiveLine}`,
    );
  }
  // AC-A4: nothing generated new prose to refill the space.
  for (const filler of ['自动摘要', 'AI 总结', '为你总结', '推测', '可能相关的是']) {
    assert.ok(!text.includes(filler), `${label}: AC-A4 — no generated filler (${filler})`);
  }
}

describe('F296 AC-A4: sparse output is accepted at every entry point', () => {
  test('route-serial: the prompt the provider receives is sparse', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const captured = [];
    const deps = createRouteDeps(['opus'], captured);

    for await (const _ of routeSerial(deps, ['opus'], '@opus 看看这个', 'user-1', 'thread-a4', {
      currentUserMessageId: deps.currentUserMessageId,
    })) {
      // drain
    }

    assert.equal(captured.length, 1, 'provider was invoked exactly once');
    assertPhaseASparse(captured[0], 'route-serial');
    // Sparse is not empty: the retrieval entry and the omitted range survive.
    assert.match(captured[0], /pointer only/, 'route-serial keeps a content-free retrieval pointer');
  });

  test('route-parallel: the prompt each provider receives is sparse', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const captured = [];
    const deps = createRouteDeps(['opus', 'codex'], captured);

    for await (const _ of routeParallel(deps, ['opus', 'codex'], '@opus @codex 各自看看', 'user-1', 'thread-a4', {
      currentUserMessageId: deps.currentUserMessageId,
    })) {
      // drain
    }

    assert.equal(captured.length, 2, 'both providers were invoked');
    captured.forEach((prompt, i) => assertPhaseASparse(prompt, `route-parallel[${i}]`));
  });

  test('SessionBootstrap: bootstrap text is sparse', async () => {
    const sessions = [
      { id: 'sess-0', catId: 'opus', threadId: 'thread-a4', status: 'sealed', seq: 0 },
      { id: 'sess-1', catId: 'opus', threadId: 'thread-a4', status: 'active', seq: 1 },
    ];
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
        {
          sessionChainStore: {
            getActive: (catId, threadId) =>
              sessions.find((s) => s.catId === catId && s.threadId === threadId && s.status === 'active') ?? null,
            getChain: (catId, threadId) => sessions.filter((s) => s.catId === catId && s.threadId === threadId),
          },
          transcriptReader: { readDigest: async () => null },
          threadStore: mockThreadStore(),
        },
        'opus',
        'thread-a4',
      );
      assert.ok(result, 'bootstrap is produced');
      assertPhaseASparse(result.text, 'SessionBootstrap');
      assert.match(result.text, /pointer only/, 'bootstrap keeps a content-free retrieval pointer');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('briefing card: the human-facing card is sparse in the same way', () => {
    const coverageMap = {
      omitted: { count: 48, timeRange: { from: 1712000000000, to: 1712003600000 }, participants: ['opus'] },
      burst: { count: 12, timeRange: { from: 1712003600000, to: 1712004000000 } },
      anchorIds: [],
      threadMemory: {
        available: true,
        sessionsIncorporated: 4,
        decisions: [DECISION],
        decisionRefs: [{ threadId: 'thread-a4' }],
        // legacy shape — must still not render
        openQuestions: [CLOSED_QUESTION],
        openQuestionRefs: [{ threadId: 'thread-a4' }],
      },
      recallPointer: { candidateCount: 1 },
    };

    const msg = buildBriefingMessage(coverageMap, 'thread-a4', {
      recentArtifacts: [{ type: 'file', label: STALE_ARTIFACT, ref: STALE_ARTIFACT, updatedBy: 'opus' }],
      rankedSources: [],
    });
    const card = msg.extra.rich.blocks[0];
    const rendered = `${card.bodyMarkdown ?? ''}\n${card.fields.map((f) => `${f.label}: ${f.value}`).join('\n')}`;

    assertPhaseASparse(rendered, 'briefing');
    // Sparse is honest, not silent: no qualified source → say so, and keep a drill.
    assert.match(rendered, /真相源: 未定位/, 'briefing states 未定位 rather than promoting a stale artifact');
    assert.match(rendered, /下一步:/, 'briefing keeps an exact drill entry');
  });

  test('prompt section snapshot: the cold packet block has exactly the accepted sections', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const captured = [];
    const deps = createRouteDeps(['opus'], captured);

    for await (const _ of routeSerial(deps, ['opus'], '@opus 看看这个', 'user-1', 'thread-a4', {
      currentUserMessageId: deps.currentUserMessageId,
    })) {
      // drain
    }

    // Scope to the context block the route injects. Static collaboration
    // guidance is not Phase A's surface and is deliberately out of frame.
    const prompt = captured[0];
    const blockStart = prompt.indexOf('[导航]');
    const blockEnd = prompt.indexOf('[/对话历史]');
    assert.ok(blockStart >= 0 && blockEnd > blockStart, 'cold context block is present');
    const block = prompt.slice(blockStart, blockEnd + '[/对话历史]'.length);

    // The accepted shape of a Phase A cold packet. Anything not on this list is a
    // regression *or* a deliberate addition that has to change this list first —
    // which is exactly the argument AC-A4 wants a future "add a summary back" to have.
    const ACCEPTED_PREFIXES = [
      '[导航]', // baton + truth source + next step
      '[/导航]',
      '[对话历史增量', // window header (N omitted / M detailed)
      '[Context Coverage Map]', // machine-readable coverage, no candidate bodies
      '[Thread Memory', // session summary text (no openQuestions)
      '[System: skipped', // tombstone for the omitted range
      '[Thread opener', // real thread messages selected as anchors
      '[Anchor ',
      '[Related evidence — pointer only]', // content-free retrieval entry
      '[/Related evidence]',
      '[/对话历史]',
    ];
    const MESSAGE_LINE = /^\[\d{16}-\d{6}-[0-9a-f]{8}\]/; // verbatim burst messages

    const unexpected = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('['))
      .filter((line) => !MESSAGE_LINE.test(line))
      .filter((line) => !ACCEPTED_PREFIXES.some((prefix) => line.startsWith(prefix)));

    assert.deepEqual(unexpected, [], `unexpected prompt sections appeared: ${JSON.stringify(unexpected)}`);

    // Sparse acceptance, stated positively: these are the things that MUST be there.
    assert.match(block, /真相源: 未定位/, 'no qualified source → say 未定位, do not promote a candidate');
    assert.match(block, /下一步: cat_cafe_get_thread_context/, 'an exact drill entry survives');
    assert.match(block, /\[Related evidence — pointer only\]/, 'the retrieval entry survives as a pointer');
    assert.match(block, /\[System: skipped 49 messages/, 'the omitted range is stated, not silently dropped');
    // …and the coverage map still reports the omitted range + a content-free count.
    assert.match(block, /"recallPointer":\{"candidateCount":1\}/);
    assert.ok(!block.includes('"openQuestion'), 'no lifecycle-less questions in the coverage map');
  });
});
