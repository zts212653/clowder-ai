// F296 AC-A2: ThreadMemory.openQuestions has no canonical lifecycle state and no
// invalidator — a regex/summary-derived question keeps claiming "still open" long
// after it closed. Until a canonical owner supplies asOf + unresolved state +
// invalidator, these claims must not reach any model-facing surface.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { assembleIncrementalContext: assembleRaw } = await import(
  '../dist/domains/cats/services/agents/routing/route-helpers.js'
);
const { buildBriefingMessage, formatContextBriefing } = await import(
  '../dist/domains/cats/services/agents/routing/format-briefing.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');

// The live sample from the F296 kickoff: a question whose PR merged two months
// ago, still injected as if it were current work.
const CLOSED_QUESTION = '要不要把 delivery cursor 拆成两个 store？(PR #1108 已合入两个月)';
const OPEN_LOOKING_QUESTION = '谁来接 Phase C 的 provider handshake？';

function mockMsg(overrides) {
  return {
    threadId: 'thread-1',
    userId: 'user-1',
    catId: null,
    content: overrides.content ?? 'test message',
    mentions: [],
    timestamp: overrides.timestamp ?? Date.now(),
  };
}

function seedMessages(messageStore, count) {
  const baseTs = Date.now() - count * 60_000;
  for (let i = 0; i < count; i++) {
    messageStore.append(mockMsg({ content: `message ${i} about delivery cursor`, timestamp: baseTs + i * 60_000 }));
  }
}

function mockThreadStore(threadMemory) {
  return {
    get: async () => ({ id: 'thread-1', title: 'delivery cursor thread', userId: 'user-1', createdAt: Date.now() }),
    create: async () => ({}),
    list: async () => [],
    listByProject: async () => [],
    addParticipants: async () => {},
    getParticipants: async () => [],
    getParticipantsWithActivity: async () => [],
    updateParticipantActivity: async () => {},
    updateLastActive: async () => {},
    getThreadMemory: async () => threadMemory,
    updateThreadMemory: async () => {},
  };
}

const THREAD_MEMORY_WITH_QUESTIONS = {
  v: 1,
  summary: 'Earlier sessions converged on the cursor contract.',
  sessionsIncorporated: 4,
  updatedAt: Date.now(),
  decisions: ['cursor 用单 store'],
  decisionRefs: [{ threadId: 'thread-1' }],
  openQuestions: [CLOSED_QUESTION, OPEN_LOOKING_QUESTION],
  openQuestionRefs: [{ threadId: 'thread-1' }, { threadId: 'thread-1' }],
};

function buildDeps(messageStore, deliveryCursorStore, threadMemory) {
  return {
    services: {},
    invocationDeps: { threadStore: mockThreadStore(threadMemory) },
    messageStore,
    deliveryCursorStore,
    evidenceStore: undefined,
  };
}

function assembleIncrementalContext(deps) {
  return assembleRaw(deps, 'user-1', 'thread-1', 'opus', undefined, undefined, {
    effectiveMaxContextTokens: 500_000,
  });
}

const BASE_COVERAGE_MAP = {
  omitted: { count: 20, timeRange: { from: 1712000000000, to: 1712003600000 }, participants: ['opus'] },
  burst: { count: 5, timeRange: { from: 1712003600000, to: 1712004000000 } },
  anchorIds: [],
  threadMemory: { available: true, sessionsIncorporated: 4 },
  recallPointer: { candidateCount: 0 },
};

describe('F296 AC-A2: lifecycle-less openQuestions exit every model-facing surface', () => {
  test('cold packet: coverage map carries no openQuestions, not even a closed one', async () => {
    const messageStore = new MessageStore();
    seedMessages(messageStore, 20);
    const deps = buildDeps(messageStore, new DeliveryCursorStore(), THREAD_MEMORY_WITH_QUESTIONS);

    const result = await assembleIncrementalContext(deps);

    const serialized = JSON.stringify(result.coverageMap);
    assert.ok(!serialized.includes(CLOSED_QUESTION), 'closed question must not survive in the coverage map');
    assert.ok(!serialized.includes(OPEN_LOOKING_QUESTION), 'no openQuestion may survive in the coverage map');
    assert.ok(!serialized.includes('openQuestion'), 'the field itself is gone from the presentation contract');
    // Decisions are timestamped historical facts, not live-state claims — they stay.
    assert.ok(serialized.includes('cursor 用单 store'), 'decisions are out of AC-A2 scope and must not regress');
  });

  test('cold packet: prompt text carries no openQuestions', async () => {
    const messageStore = new MessageStore();
    seedMessages(messageStore, 20);
    const deps = buildDeps(messageStore, new DeliveryCursorStore(), THREAD_MEMORY_WITH_QUESTIONS);

    const result = await assembleIncrementalContext(deps);

    assert.ok(result.contextText.includes('智能窗口'), 'precondition: cold smart-window path');
    assert.ok(!result.contextText.includes(CLOSED_QUESTION), 'closed question must not reach the model');
    assert.ok(!result.contextText.includes(OPEN_LOOKING_QUESTION), 'no openQuestion may reach the model');
    // Thread Memory summary itself is still allowed — only the lifecycle-less field left.
    assert.ok(result.contextText.includes('Thread Memory'), 'thread memory summary is not collateral damage');
  });

  test('briefing: no 待决问题 block even when a legacy coverage map still carries the field', () => {
    const legacyMap = {
      ...BASE_COVERAGE_MAP,
      threadMemory: {
        available: true,
        sessionsIncorporated: 4,
        openQuestions: [CLOSED_QUESTION, OPEN_LOOKING_QUESTION],
        openQuestionRefs: [{ threadId: 'thread-1' }, { threadId: 'thread-1' }],
      },
    };

    const msg = buildBriefingMessage(legacyMap, 'thread-1');
    const card = msg.extra.rich.blocks[0];
    const body = card.bodyMarkdown ?? '';

    assert.ok(!body.includes('待决问题'), 'briefing must not render a 待决问题 block');
    assert.ok(!body.includes(CLOSED_QUESTION), 'closed question must not reach the briefing card');
    assert.ok(!body.includes(OPEN_LOOKING_QUESTION), 'no openQuestion may reach the briefing card');
  });

  test('briefing rich block: coverage map projection stays free of openQuestions', () => {
    const result = formatContextBriefing(BASE_COVERAGE_MAP);
    assert.ok(!JSON.stringify(result.richBlock).includes('openQuestion'));
  });

  /** Strip comments so the guard measures code, not the prose that explains it. */
  function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  test('no bypass: no prompt-assembly surface reads openQuestions', () => {
    const srcRoot = fileURLToPath(new URL('../src/domains/cats/services/', import.meta.url));
    const surfaces = [
      'agents/routing/route-helpers.ts',
      'agents/routing/route-serial.ts',
      'agents/routing/route-parallel.ts',
      'agents/routing/format-briefing.ts',
      'agents/routing/context-transport.ts',
      'session/SessionBootstrap.ts',
    ];
    for (const file of surfaces) {
      const code = stripComments(readFileSync(`${srcRoot}${file}`, 'utf8'));
      assert.ok(!code.includes('openQuestion'), `${file} must not read lifecycle-less openQuestions`);
    }
  });
});
