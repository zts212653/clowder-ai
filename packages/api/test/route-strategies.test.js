/**
 * Route Strategies Tests
 * 验证 routeSerial / routeParallel 纯函数的基本行为 + A2A worklist
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Create a mock agent service that yields text + done
function createMockService(catId, text = 'hello') {
  return {
    async *invoke(_prompt) {
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

// Mock service that captures the prompt it receives
function createCapturingService(catId, text = 'hello') {
  const calls = [];
  return {
    calls,
    async *invoke(prompt) {
      calls.push(prompt);
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createOptionsCapturingService(catId, text = 'hello') {
  const calls = [];
  return {
    calls,
    async *invoke(prompt, options) {
      calls.push({ prompt, options });
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createSequentialCapturingService(catId, responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async *invoke(prompt) {
      calls.push(prompt);
      const text = responses[index] ?? responses[responses.length - 1] ?? 'ok';
      index += 1;
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createGuideAckThreadStore(initialGuideState, currentGuideState, projectPath = '/tmp/test') {
  return {
    async get() {
      return {
        id: 'thread1',
        title: 'Test',
        createdBy: 'user1',
        participants: [],
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
        projectPath,
      };
    },
    async getParticipantsWithActivity() {
      return [];
    },
    /** Create an InMemoryGuideSessionStore pre-seeded with initial state, returning it and a bridge for assertions. */
    _createSessionStore: null,
  };
}

async function createGuideAckFixture(guideState, projectPath = '/tmp/test') {
  const { InMemoryGuideSessionStore, createGuideStoreBridge } = await import(
    '../dist/domains/guides/GuideSessionRepository.js'
  );
  const sessionStore = new InMemoryGuideSessionStore();
  const bridge = createGuideStoreBridge(sessionStore);
  await bridge.set('thread1', guideState);
  const threadStore = createGuideAckThreadStore(null, null, projectPath);
  return { threadStore, sessionStore, bridge };
}

/** Session store that returns initialState on first read, then replacementState afterwards.
 *  Models concurrent guide replacement between prepare and ack phases. */
async function createSwitchingGuideAckFixture(initialState, replacementState, projectPath = '/tmp/test') {
  const { createSessionFromState } = await import('../dist/domains/guides/GuideSession.js');
  let readCount = 0;
  const sessionStore = {
    async getByThread(threadId) {
      readCount++;
      const state = readCount <= 1 ? initialState : replacementState;
      return createSessionFromState(threadId, state);
    },
    async save() {},
    async delete() {},
  };
  const threadStore = createGuideAckThreadStore(null, null, projectPath);
  return { threadStore, sessionStore };
}

function createSharedDefaultGuideThreadStore() {
  const updates = [];
  return {
    updates,
    async get() {
      return {
        id: 'default',
        title: 'Default Thread',
        createdBy: 'system',
        participants: [],
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
        projectPath: 'default',
      };
    },
    async getParticipantsWithActivity() {
      return [];
    },
    async consumeMentionRoutingFeedback() {
      return null;
    },
    async updateParticipantActivity() {},
    async updateGuideState(threadId, nextGuideState) {
      updates.push({ threadId, guideState: nextGuideState });
    },
  };
}

async function createSharedDefaultGuideFixture(guideState) {
  const { InMemoryGuideSessionStore, createGuideStoreBridge } = await import(
    '../dist/domains/guides/GuideSessionRepository.js'
  );
  const sessionStore = new InMemoryGuideSessionStore();
  const bridge = createGuideStoreBridge(sessionStore);
  await bridge.set('default', guideState);
  const threadStore = createSharedDefaultGuideThreadStore();
  return { threadStore, sessionStore, bridge };
}

function createMockDeps(services, appendCalls, threadStore = null, guideSessionStore = null) {
  let counter = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: () => null,
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore,
      guideSessionStore,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        if (appendCalls) appendCalls.push(msg);
        return { id: `msg-${counter}`, userId: '', catId: null, content: '', mentions: [], timestamp: 0 };
      },
      getById: () => null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

function degradationSystemInfos(messages) {
  return messages.filter((m) => {
    if (m.type !== 'system_info') return false;
    if (!m.content) return true;
    if (m.content.startsWith('⚠️ Shared-state preflight:')) return false;
    try {
      const parsed = JSON.parse(m.content);
      // Invocation lifecycle telemetry is expected on every run and is not degradation.
      return parsed?.type !== 'invocation_metrics' && parsed?.type !== 'invocation_created';
    } catch {
      return true;
    }
  });
}

describe('routeSerial', () => {
  it('executes single cat and yields text + done', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({ opus: createMockService('opus', 'serial response') });

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'test message', 'user1', 'thread1')) {
      messages.push(msg);
    }

    const textMsgs = messages.filter((m) => m.type === 'text');
    const doneMsgs = messages.filter((m) => m.type === 'done');
    assert.ok(textMsgs.length > 0, 'should have text messages');
    assert.ok(doneMsgs.length > 0, 'should have done message');
    assert.equal(textMsgs[0].content, 'serial response');
  });

  it('persists toolEvents when agent yields tool_use and tool_result', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');

    // Mock service that yields tool_use → tool_result → text → done
    const toolService = {
      async *invoke(_prompt) {
        yield { type: 'tool_use', catId: 'opus', toolName: 'Read', toolInput: { path: '/a.ts' }, timestamp: 1000 };
        yield { type: 'tool_result', catId: 'opus', content: 'file content here', timestamp: 1001 };
        yield { type: 'text', catId: 'opus', content: 'I read the file', timestamp: 1002 };
        yield { type: 'done', catId: 'opus', timestamp: 1003 };
      },
    };

    const appendCalls = [];
    const deps = createMockDeps({ opus: toolService }, appendCalls);

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'read a.ts', 'user1', 'thread1')) {
      messages.push(msg);
    }

    // Verify tool events were yielded to frontend
    const toolUses = messages.filter((m) => m.type === 'tool_use');
    const toolResults = messages.filter((m) => m.type === 'tool_result');
    assert.equal(toolUses.length, 1, 'should yield tool_use');
    assert.equal(toolResults.length, 1, 'should yield tool_result');

    // Verify toolEvents were persisted via messageStore.append()
    assert.equal(appendCalls.length, 1, 'should call append once');
    const stored = appendCalls[0];
    assert.ok(stored.toolEvents, 'stored message should have toolEvents');
    assert.equal(stored.toolEvents.length, 2, 'should have 2 tool events');
    assert.equal(stored.toolEvents[0].type, 'tool_use');
    assert.ok(stored.toolEvents[0].label.includes('Read'));
    assert.equal(stored.toolEvents[1].type, 'tool_result');
  });

  it('strips leaked tool-call payloads from streamed text before yielding and persisting', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');

    const contaminatedService = {
      async *invoke() {
        yield { type: 'tool_use', catId: 'opus', toolName: 'Read', toolInput: { path: '/a.ts' }, timestamp: 1000 };
        yield {
          type: 'text',
          catId: 'opus',
          content: `先看实现，再补测试。

{"tool_uses":[{"recipient_name":"functions.exec_command","parameters":{"cmd":"sed -n '1,220p' foo.ts"}}]}`,
          timestamp: 1001,
        };
        yield { type: 'done', catId: 'opus', timestamp: 1002 };
      },
    };

    const appendCalls = [];
    const deps = createMockDeps({ opus: contaminatedService }, appendCalls);

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'read a.ts', 'user1', 'thread1')) {
      messages.push(msg);
    }

    const textMsgs = messages.filter((m) => m.type === 'text');
    assert.equal(textMsgs.length, 1, 'should still yield one text message');
    assert.equal(textMsgs[0].content, '先看实现，再补测试。');

    assert.equal(appendCalls.length, 1, 'should persist one final message');
    assert.equal(appendCalls[0].content, '先看实现，再补测试。');
  });

  it('strips leaked tool-call payloads split across streamed text chunks', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');

    const contaminatedService = {
      async *invoke() {
        yield {
          type: 'text',
          catId: 'opus',
          content: `先看实现，再补测试。

{`,
          timestamp: 1000,
        };
        yield {
          type: 'text',
          catId: 'opus',
          content: `"tool_uses":[{"recipient_name":"functions.exec_command","parameters":{"cmd":"echo leaked"}}]}`,
          timestamp: 1001,
        };
        yield { type: 'done', catId: 'opus', timestamp: 1002 };
      },
    };

    const appendCalls = [];
    const deps = createMockDeps({ opus: contaminatedService }, appendCalls);

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'read a.ts', 'user1', 'thread1')) {
      messages.push(msg);
    }

    const textMsgs = messages.filter((m) => m.type === 'text');
    assert.equal(textMsgs.length, 1, 'should yield only the prose chunk');
    assert.equal(textMsgs[0].content, '先看实现，再补测试。');
    assert.ok(textMsgs.every((m) => !m.content.includes('tool_uses')));
    assert.ok(textMsgs.every((m) => !m.content.includes('recipient_name')));

    assert.equal(appendCalls.length, 1, 'should persist one final message');
    assert.equal(appendCalls[0].content, '先看实现，再补测试。');
  });

  it('keeps legitimate tool-use JSON examples when prose continues afterwards', async () => {
    const { stripLeakedToolCallPayload } = await import(
      '../dist/domains/cats/services/agents/routing/route-helpers.js'
    );

    const example = `示例 payload：

{"tool_uses":[{"recipient_name":"functions.exec_command","parameters":{"cmd":"echo hi"}}]}
上面只是文档示例，不是泄漏。`;

    assert.equal(stripLeakedToolCallPayload(example), example);
  });
});

describe('routeSerial A2A worklist', () => {
  it('extends worklist when cat response contains line-start @mention', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    // opus responds with a line-start mention of codex
    const deps = createMockDeps({
      opus: createMockService('opus', '我写好了代码\n@缅因猫 请 review 一下'),
      codex: createMockService('codex', 'LGTM, 代码没问题'),
    });

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'write hello world', 'user1', 'thread1')) {
      messages.push(msg);
    }

    // Should have text from both cats (opus + codex via A2A)
    const opusText = messages.filter((m) => m.type === 'text' && m.catId === 'opus');
    const codexText = messages.filter((m) => m.type === 'text' && m.catId === 'codex');
    assert.ok(opusText.length > 0, 'opus should produce text');
    assert.ok(codexText.length > 0, 'codex should be invoked via A2A');
  });

  it('yields a2a_handoff event when A2A chain triggers', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({
      opus: createMockService('opus', '请看一下\n@缅因猫 帮忙检查'),
      codex: createMockService('codex', '已检查完毕'),
    });

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'check code', 'user1', 'thread1')) {
      messages.push(msg);
    }

    const handoffs = messages.filter((m) => m.type === 'a2a_handoff');
    assert.equal(handoffs.length, 1, 'should yield exactly one a2a_handoff');
    assert.equal(handoffs[0].catId, 'opus', 'handoff should be from opus');
    assert.ok(handoffs[0].content.includes('→'), 'handoff content should show arrow');
  });

  it('A2A cat receives previousResponses in prompt (debug mode)', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const codexService = createCapturingService('codex', '已审查');
    const deps = createMockDeps({
      opus: createMockService('opus', '代码完成\n@缅因猫 请review'),
      codex: codexService,
    });

    for await (const _ of routeSerial(deps, ['opus'], 'write code', 'user1', 'thread1', { thinkingMode: 'debug' })) {
    }

    assert.equal(codexService.calls.length, 1, 'codex should be called once');
    assert.ok(
      codexService.calls[0].includes('代码完成'),
      'codex prompt should include opus response content in debug mode',
    );
  });

  it('A2A cat does NOT receive previousResponses in play mode (thinking isolation)', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const codexService = createCapturingService('codex', '已审查');
    const deps = createMockDeps({
      opus: createMockService('opus', '代码完成\n@缅因猫 请review'),
      codex: codexService,
    });

    // Explicitly set play mode — cats should not see each other's thinking (default is now debug)
    for await (const _ of routeSerial(deps, ['opus'], 'write code', 'user1', 'thread1', { thinkingMode: 'play' })) {
    }

    assert.equal(codexService.calls.length, 1, 'codex should be called once');
    assert.ok(
      !codexService.calls[0].includes('代码完成'),
      'codex prompt should NOT include opus response content in play mode',
    );
  });

  it('isFinal is true only on the last done in the chain', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({
      opus: createMockService('opus', '好的\n@缅因猫 帮忙'),
      codex: createMockService('codex', '搞定了'),
    });

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'help', 'user1', 'thread1')) {
      messages.push(msg);
    }

    const doneMsgs = messages.filter((m) => m.type === 'done');
    assert.ok(doneMsgs.length >= 2, 'should have done from both cats');
    // First done (opus) should NOT be isFinal
    const opusDone = doneMsgs.find((m) => m.catId === 'opus');
    assert.ok(!opusDone.isFinal, 'opus done should not be isFinal');
    // Last done (codex) should be isFinal
    const codexDone = doneMsgs.find((m) => m.catId === 'codex');
    assert.ok(codexDone.isFinal, 'codex done (chain end) should be isFinal');
  });

  it('does not extend worklist beyond maxA2ADepth', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    // opus mentions codex, codex mentions gemini, gemini mentions opus
    // With maxA2ADepth=1, only first A2A hop should trigger
    const deps = createMockDeps({
      opus: createMockService('opus', '看看吧\n@缅因猫 帮忙'),
      codex: createMockService('codex', '需要设计\n@暹罗猫 帮忙设计'),
      gemini: createMockService('gemini', '设计好了'),
    });

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1', { maxA2ADepth: 1 })) {
      messages.push(msg);
    }

    // Only opus + codex should produce text (depth=1 allows 1 hop)
    const catIds = [...new Set(messages.filter((m) => m.type === 'text').map((m) => m.catId))];
    assert.ok(catIds.includes('opus'), 'opus should have text');
    assert.ok(catIds.includes('codex'), 'codex should be invoked (1st hop)');
    assert.ok(!catIds.includes('gemini'), 'gemini should NOT be invoked (2nd hop blocked by depth=1)');
  });

  it('does not extend A2A worklist when queue has queued user messages', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({
      opus: createMockService('opus', '我先回复\n@缅因猫 帮忙继续'),
      codex: createMockService('codex', 'should not run when queue pending'),
    });

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1', {
      queueHasQueuedMessages: () => true,
    })) {
      messages.push(msg);
    }

    const codexText = messages.filter((m) => m.type === 'text' && m.catId === 'codex');
    assert.equal(codexText.length, 0, 'A2A should yield to queued user messages');

    const handoffs = messages.filter((m) => m.type === 'a2a_handoff');
    assert.equal(handoffs.length, 0, 'should not emit handoff when fairness guard blocks extension');
  });

  it('skips A2A text-scan @mention when cat already dispatched via callback (cross-path dedup)', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({
      opus: createMockService('opus', '代码完成\n@缅因猫 请 review'),
      codex: createMockService('codex', 'should not be invoked via text-scan'),
    });

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1', {
      hasQueuedOrActiveAgentForCat: (_tid, catId) => catId === 'codex',
    })) {
      messages.push(msg);
    }

    const codexText = messages.filter((m) => m.type === 'text' && m.catId === 'codex');
    assert.equal(codexText.length, 0, 'codex must NOT be invoked when already in InvocationQueue');

    const handoffs = messages.filter((m) => m.type === 'a2a_handoff');
    assert.equal(handoffs.length, 0, 'should not emit handoff for deduped cat');
  });

  it('self-mention does not trigger A2A', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({
      opus: createMockService('opus', '我是布偶猫\n@布偶猫 说完了'),
      codex: createMockService('codex', 'should not be called'),
    });

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1')) {
      messages.push(msg);
    }

    const handoffs = messages.filter((m) => m.type === 'a2a_handoff');
    assert.equal(handoffs.length, 0, 'self-mention should not trigger A2A');
    const codexText = messages.filter((m) => m.type === 'text' && m.catId === 'codex');
    assert.equal(codexText.length, 0, 'codex should not be invoked');
  });

  it('non-line-start @mention does not trigger A2A', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({
      opus: createMockService('opus', '之前缅因猫说的 @缅因猫 方案不错，我同意'),
      codex: createMockService('codex', 'should not be called'),
    });

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'feedback', 'user1', 'thread1')) {
      messages.push(msg);
    }

    const handoffs = messages.filter((m) => m.type === 'a2a_handoff');
    assert.equal(handoffs.length, 0, 'mid-line mention should not trigger A2A');
  });

  it('signal abort stops worklist chain', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const ac = new AbortController();
    const deps = createMockDeps({
      opus: {
        async *invoke() {
          yield { type: 'text', catId: 'opus', content: '开始\n@缅因猫 帮忙', timestamp: Date.now() };
          // Abort after opus produces text
          ac.abort();
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
      codex: createMockService('codex', 'should not run'),
    });

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1', { signal: ac.signal })) {
      messages.push(msg);
    }

    // Codex should not be invoked because signal was aborted
    const codexText = messages.filter((m) => m.type === 'text' && m.catId === 'codex');
    assert.equal(codexText.length, 0, 'codex should not be invoked after abort');
  });

  it('stores mentions correctly in messageStore.append', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        opus: createMockService('opus', '写完了\n@缅因猫 帮review'),
        codex: createMockService('codex', '审查完毕'),
      },
      appendCalls,
    );

    for await (const _ of routeSerial(deps, ['opus'], 'code', 'user1', 'thread1')) {
    }

    // opus's stored message should have mentions: ['codex']
    const opusAppend = appendCalls.find((c) => c.catId === 'opus');
    assert.ok(opusAppend, 'opus response should be stored');
    assert.deepEqual(opusAppend.mentions, ['codex'], 'opus mentions should include codex');

    // codex's stored message (no mention in response) → mentions: []
    const codexAppend = appendCalls.find((c) => c.catId === 'codex');
    assert.ok(codexAppend, 'codex response should be stored');
    assert.deepEqual(codexAppend.mentions, [], 'codex mentions should be empty');
  });

  it('supports 2-hop A2A chain: user→A→B→A', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    let opusCallCount = 0;
    const deps = createMockDeps({
      opus: {
        async *invoke() {
          opusCallCount++;
          if (opusCallCount === 1) {
            yield { type: 'text', catId: 'opus', content: '写好了\n@缅因猫 review', timestamp: Date.now() };
          } else {
            yield { type: 'text', catId: 'opus', content: '已修复', timestamp: Date.now() };
          }
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
      codex: createMockService('codex', '有bug\n@布偶猫 请修复'),
    });

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'implement feature', 'user1', 'thread1', { maxA2ADepth: 2 })) {
      messages.push(msg);
    }

    // Chain: opus → codex → opus (2 hops)
    const handoffs = messages.filter((m) => m.type === 'a2a_handoff');
    assert.equal(handoffs.length, 2, 'should have 2 A2A handoffs');
    assert.equal(opusCallCount, 2, 'opus should be called twice');
  });

  it('incremental mode: falls back to explicit user message when current message is missing from incremental context', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const captureService = createCapturingService('opus', 'ack');

    const deps = createMockDeps({ opus: captureService });
    deps.deliveryCursorStore = {
      getCursor: async () => undefined,
      ackCursor: async () => {},
    };
    deps.messageStore.getByThreadAfter = async () => [
      {
        id: '0000000000000001-000001-aaaaaaaa',
        threadId: 'thread1',
        userId: 'user1',
        catId: null,
        content: 'older user message',
        mentions: [],
        timestamp: Date.now() - 1000,
      },
    ];

    for await (const _ of routeSerial(deps, ['opus'], 'CURRENT USER MESSAGE', 'user1', 'thread1', {
      currentUserMessageId: 'missing-current-id',
    })) {
    }

    assert.equal(captureService.calls.length, 1, 'opus should be called once');
    const prompt = captureService.calls[0];
    assert.ok(prompt.includes('older user message'), 'prompt should include incremental unseen history');
    assert.ok(
      prompt.includes('CURRENT USER MESSAGE'),
      'prompt must include current user message explicitly when missing from unseen history',
    );
  });

  it('incremental mode: does NOT inject whisper content for non-recipient cat (F35 privacy fix)', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const codexService = createCapturingService('codex', 'ack');

    const deps = createMockDeps({ codex: codexService });
    deps.deliveryCursorStore = {
      getCursor: async () => undefined,
      ackCursor: async () => {},
    };
    // The unseen list contains a whisper message intended only for opus.
    // When codex is the target cat, this message should be filtered out AND
    // the raw message text must NOT be injected as fallback.
    const whisperMsgId = '0000000000000001-000001-whisper01';
    deps.messageStore.getByThreadAfter = async () => [
      {
        id: whisperMsgId,
        threadId: 'thread1',
        userId: 'user1',
        catId: null,
        content: 'SECRET: 图灵是狼人',
        mentions: ['opus'],
        timestamp: Date.now(),
        visibility: 'whisper',
        whisperTo: ['opus'],
      },
    ];

    for await (const _ of routeSerial(deps, ['codex'], 'SECRET: 图灵是狼人', 'user1', 'thread1', {
      currentUserMessageId: whisperMsgId,
      thinkingMode: 'play',
    })) {
    }

    assert.equal(codexService.calls.length, 1, 'codex should be called once');
    const prompt = codexService.calls[0];
    assert.ok(!prompt.includes('图灵'), 'whisper content must NOT appear in non-recipient prompt');
    assert.ok(!prompt.includes('SECRET'), 'whisper content must NOT leak via fallback injection');
  });

  it('line-start @mention always routes without keyword gate (no suppression feedback)', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const threadStore = new ThreadStore();
    const thread = threadStore.create('user1', 'no suppression');
    const opusService = createCapturingService('opus', '收到');
    const codexService = createSequentialCapturingService('codex', ['@布偶猫', '第二次调用']);
    const deps = createMockDeps({ codex: codexService, opus: opusService }, undefined, threadStore);

    const messages = [];
    for await (const msg of routeSerial(deps, ['codex'], 'first', 'user1', thread.id, { thinkingMode: 'debug' })) {
      messages.push(msg);
    }

    // @布偶猫 alone should now trigger A2A handoff (no keyword required)
    const handoffs = messages.filter((m) => m.type === 'a2a_handoff');
    assert.equal(handoffs.length, 1, 'bare @布偶猫 should trigger A2A handoff without action keywords');

    // Second invocation should NOT have any routing feedback (suppression system removed)
    for await (const _ of routeSerial(deps, ['codex'], 'second', 'user1', thread.id, { thinkingMode: 'debug' })) {
    }
    assert.ok(
      !codexService.calls[1].includes('Routing feedback(one-shot):'),
      'no routing feedback should be injected (suppression system removed)',
    );
  });

  it('sanitize should preserve normal markdown separator lines', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        opus: createMockService('opus', '章节A\n---\n章节B'),
      },
      appendCalls,
    );

    for await (const _ of routeSerial(deps, ['opus'], 'markdown test', 'user1', 'thread1')) {
    }

    const saved = appendCalls.find((c) => c.catId === 'opus');
    assert.ok(saved, 'stored message should exist');
    assert.equal(saved.content, '章节A\n---\n章节B', 'sanitizer must not remove normal markdown separator lines');
  });
});

describe('routeSerial resilience', () => {
  it('yields done even when messageStore.append throws (Redis failure)', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');

    // Create deps with a failing messageStore
    let counter = 0;
    const deps = {
      services: { opus: createMockService('opus', '结果在这里') },
      invocationDeps: {
        registry: {
          create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
          verify: () => null,
        },
        sessionManager: {
          getOrCreate: async () => ({}),
          resolveWorkingDirectory: () => '/tmp/test',
        },
        threadStore: null,
        apiUrl: 'http://127.0.0.1:3004',
      },
      messageStore: {
        append: async () => {
          throw new Error('Redis connection refused');
        },
        getRecent: () => [],
        getMentionsFor: () => [],
        getBefore: () => [],
        getByThread: () => [],
        getByThreadAfter: () => [],
        getByThreadBefore: () => [],
      },
    };

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1')) {
      messages.push(msg);
    }

    // done MUST still be yielded despite append failure
    const doneMsgs = messages.filter((m) => m.type === 'done');
    assert.ok(doneMsgs.length > 0, 'done must be yielded even when append throws');
    assert.ok(doneMsgs[0].isFinal, 'done should be isFinal');
  });
});

describe('routeSerial cursor ack on error', () => {
  it('acks delivery cursor even when cat yields error (prevents infinite re-delivery)', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');

    // Mock service that yields text THEN error THEN done
    const errorService = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'partial', timestamp: Date.now() };
        yield { type: 'error', catId: 'opus', error: 'token limit', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = createMockDeps({ opus: errorService });
    deps.deliveryCursorStore = {
      getCursor: async () => undefined,
      ackCursor: async () => {},
    };
    deps.messageStore.getByThreadAfter = async () => [
      {
        id: '0000000000000001-000001-aaaaaaaa',
        threadId: 'thread1',
        userId: 'user1',
        catId: null,
        content: 'user message',
        mentions: [],
        timestamp: Date.now(),
      },
    ];

    const cursorBoundaries = new Map();
    for await (const _ of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1', {
      currentUserMessageId: '0000000000000001-000001-aaaaaaaa',
      cursorBoundaries,
    })) {
    }

    assert.ok(cursorBoundaries.has('opus'), 'cursor boundary must be set for opus even when hadError=true');
    assert.equal(
      cursorBoundaries.get('opus'),
      '0000000000000001-000001-aaaaaaaa',
      'boundary should match the last unseen message ID',
    );
  });
});

describe('routeParallel cursor ack on error', () => {
  it('acks delivery cursor even when cat yields error (prevents infinite re-delivery)', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    // Mock service that yields error + done
    const errorService = {
      async *invoke() {
        yield { type: 'error', catId: 'opus', error: 'API failure', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const deps = createMockDeps({
      opus: errorService,
      codex: createMockService('codex', 'codex ok'),
    });
    deps.deliveryCursorStore = {
      getCursor: async () => undefined,
      ackCursor: async () => {},
    };
    deps.messageStore.getByThreadAfter = async () => [
      {
        id: '0000000000000002-000001-bbbbbbbb',
        threadId: 'thread1',
        userId: 'user1',
        catId: null,
        content: 'user message',
        mentions: [],
        timestamp: Date.now(),
      },
    ];

    const cursorBoundaries = new Map();
    for await (const _ of routeParallel(deps, ['opus', 'codex'], 'test', 'user1', 'thread1', {
      currentUserMessageId: '0000000000000002-000001-bbbbbbbb',
      cursorBoundaries,
    })) {
    }

    assert.ok(cursorBoundaries.has('opus'), 'cursor boundary must be set for opus even when it errored');
    assert.ok(cursorBoundaries.has('codex'), 'cursor boundary must be set for codex (no error)');
  });
});

describe('routeParallel resilience', () => {
  it('yields done even when messageStore.append throws (Redis failure)', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    const deps = createMockDeps({
      opus: createMockService('opus', 'opus says'),
      codex: createMockService('codex', 'codex says'),
    });
    // Force append failure (simulates Redis outage)
    deps.messageStore.append = async () => {
      throw new Error('Redis connection refused');
    };

    const messages = [];
    for await (const msg of routeParallel(deps, ['opus', 'codex'], 'test', 'user1', 'thread1')) {
      messages.push(msg);
    }

    const doneMsgs = messages.filter((m) => m.type === 'done');
    assert.equal(doneMsgs.length, 2, 'should still yield done for both cats');
    assert.ok(
      doneMsgs.some((m) => m.isFinal),
      'one done should be isFinal',
    );
  });

  it('strips leaked tool-call payloads from parallel text before yielding and persisting', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    const contaminatedService = {
      async *invoke() {
        yield { type: 'tool_use', catId: 'opus', toolName: 'Read', toolInput: { path: '/a.ts' }, timestamp: 1000 };
        yield {
          type: 'text',
          catId: 'opus',
          content: `继续落实现，别把内部参数露出去。

{"tool_uses":[{"recipient_name":"functions.exec_command","parameters":{"cmd":"sed -n '1,220p' foo.ts"}}]}`,
          timestamp: 1001,
        };
        yield { type: 'done', catId: 'opus', timestamp: 1002 };
      },
    };

    const appendCalls = [];
    const deps = createMockDeps({ opus: contaminatedService }, appendCalls);

    const messages = [];
    for await (const msg of routeParallel(deps, ['opus'], 'read a.ts', 'user1', 'thread1')) {
      messages.push(msg);
    }

    const textMsgs = messages.filter((m) => m.type === 'text');
    assert.equal(textMsgs.length, 1, 'should still yield one text message');
    assert.equal(textMsgs[0].content, '继续落实现，别把内部参数露出去。');

    assert.equal(appendCalls.length, 1, 'should persist one final message');
    assert.equal(appendCalls[0].content, '继续落实现，别把内部参数露出去。');
  });

  it('strips leaked tool-call payloads split across parallel text chunks', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    const contaminatedService = {
      async *invoke() {
        yield {
          type: 'text',
          catId: 'opus',
          content: `继续落实现，别把内部参数露出去。

{`,
          timestamp: 1000,
        };
        yield {
          type: 'text',
          catId: 'opus',
          content: `"tool_uses":[{"recipient_name":"functions.exec_command","parameters":{"cmd":"echo leaked"}}]}`,
          timestamp: 1001,
        };
        yield { type: 'done', catId: 'opus', timestamp: 1002 };
      },
    };

    const appendCalls = [];
    const deps = createMockDeps({ opus: contaminatedService }, appendCalls);

    const messages = [];
    for await (const msg of routeParallel(deps, ['opus'], 'read a.ts', 'user1', 'thread1')) {
      messages.push(msg);
    }

    const textMsgs = messages.filter((m) => m.type === 'text');
    assert.equal(textMsgs.length, 1, 'should yield only the prose chunk');
    assert.equal(textMsgs[0].content, '继续落实现，别把内部参数露出去。');
    assert.ok(textMsgs.every((m) => !m.content.includes('tool_uses')));
    assert.ok(textMsgs.every((m) => !m.content.includes('recipient_name')));

    assert.equal(appendCalls.length, 1, 'should persist one final message');
    assert.equal(appendCalls[0].content, '继续落实现，别把内部参数露出去。');
  });

  it('preserves metadata when parallel provider only attaches it to done', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    const doneMetadata = {
      model: 'codex-test',
      usage: { inputTokens: 12, outputTokens: 7 },
    };

    const metadataOnDoneService = {
      async *invoke() {
        yield { type: 'text', catId: 'opus', content: 'metadata should survive', timestamp: 1000 };
        yield { type: 'done', catId: 'opus', metadata: doneMetadata, timestamp: 1001 };
      },
    };

    const appendCalls = [];
    const deps = createMockDeps({ opus: metadataOnDoneService }, appendCalls);

    for await (const _ of routeParallel(deps, ['opus'], 'test metadata', 'user1', 'thread1')) {
    }

    assert.equal(appendCalls.length, 1, 'should persist one final message');
    assert.deepEqual(appendCalls[0].metadata, doneMetadata);
  });
});

describe('routeParallel abort marks healthy (#267)', () => {
  it('abort/cancel writes healthy=true, not false', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    const ac = new AbortController();
    const activityUpdates = [];
    const threadStore = {
      get: () => ({ id: 't1', participants: ['opus'], preferredCats: [] }),
      addParticipants: () => {},
      getParticipants: () => ['opus'],
      getParticipantsWithActivity: () => [{ catId: 'opus', lastMessageAt: 1, messageCount: 1 }],
      consumeMentionRoutingFeedback: () => null,
      updateParticipantActivity: (threadId, catId, healthy) => {
        activityUpdates.push({ threadId, catId, healthy });
      },
      updateLastActive: () => {},
    };

    const deps = createMockDeps(
      {
        opus: {
          async *invoke() {
            yield { type: 'text', catId: 'opus', content: 'working...', timestamp: Date.now() };
            ac.abort();
            yield { type: 'error', catId: 'opus', error: 'AbortError', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          },
        },
      },
      null,
      threadStore,
    );

    const messages = [];
    for await (const msg of routeParallel(deps, ['opus'], 'test', 'user1', 't1', { signal: ac.signal })) {
      messages.push(msg);
    }

    const opusUpdate = activityUpdates.find((u) => u.catId === 'opus');
    assert.ok(opusUpdate, 'should have updated opus activity');
    assert.equal(opusUpdate.healthy, true, '#267: abort should be treated as healthy, not provider failure');
  });
});

describe('F155 guide offer ownership', () => {
  it('serial: suppresses fresh guide offers when another user has a non-terminal guide on shared default thread', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const codexService = createCapturingService('codex', '我来处理这个请求');
    const { threadStore, sessionStore } = await createSharedDefaultGuideFixture({
      v: 1,
      guideId: 'configure-provider',
      status: 'active',
      offeredAt: Date.now(),
      startedAt: Date.now(),
      offeredBy: 'opus',
      userId: 'other-user',
    });
    const deps = createMockDeps({ codex: codexService }, null, threadStore, sessionStore);

    for await (const _ of routeSerial(deps, ['codex'], '请帮我添加成员', 'user1', 'default')) {
    }

    assert.ok(
      !codexService.calls[0].includes('Guide Matched:'),
      'foreign non-terminal guide must block fresh guide matching for another user',
    );
    assert.ok(
      !codexService.calls[0].includes('status="offered"'),
      'routing must not emit a fresh offered guide when another user already owns the active guide',
    );
  });

  it('serial: ignores another user guide state on shared default thread', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const codexService = createCapturingService('codex', '我来处理这个请求');
    const { threadStore, sessionStore } = await createSharedDefaultGuideFixture({
      v: 1,
      guideId: 'configure-provider',
      status: 'completed',
      offeredAt: Date.now(),
      completedAt: Date.now(),
      offeredBy: 'opus',
      userId: 'other-user',
    });
    const deps = createMockDeps({ codex: codexService }, null, threadStore, sessionStore);

    for await (const _ of routeSerial(deps, ['codex'], '请帮我添加成员', 'user1', 'default')) {
    }

    assert.ok(
      codexService.calls[0].includes('Guide Matched:'),
      'foreign guide state should be hidden so current user can receive a fresh guide offer',
    );
    assert.ok(
      !codexService.calls[0].includes('Guide Completed:'),
      'foreign completed guide must not leak into the current user prompt',
    );
  });

  it('serial: injects offered guide only to the first target cat', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const opusService = createCapturingService('opus', '我来处理引导');
    const codexService = createCapturingService('codex', '不该收到引导 offer');
    const deps = createMockDeps({ opus: opusService, codex: codexService });

    for await (const _ of routeSerial(deps, ['opus', 'codex'], '请帮我添加成员', 'user1', 'thread1')) {
    }

    assert.equal(opusService.calls.length, 1, 'first cat should be invoked');
    assert.equal(codexService.calls.length, 1, 'second cat should still be invoked');
    assert.ok(opusService.calls[0].includes('status="offered"'), 'first cat should receive guide offer instructions');
    assert.ok(
      !codexService.calls[0].includes('status="offered"'),
      'second cat must not receive duplicate guide offer instructions',
    );
  });

  it('serial: passes guide selection context to a non-owner target cat', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const codexService = createCapturingService('codex', '我来给步骤概览');
    const threadStore = {
      async get() {
        return {
          id: 'thread1',
          title: 'Test',
          createdBy: 'user1',
          participants: [],
          lastActiveAt: Date.now(),
          createdAt: Date.now(),
          projectPath: 'default',
          guideState: {
            v: 1,
            guideId: 'add-member',
            status: 'offered',
            offeredAt: Date.now(),
            offeredBy: 'opus',
          },
        };
      },
      async getParticipantsWithActivity() {
        return [];
      },
      async consumeMentionRoutingFeedback() {
        return null;
      },
      async updateParticipantActivity() {},
    };
    const deps = createMockDeps({ codex: codexService }, null, threadStore);

    for await (const _ of routeSerial(deps, ['codex'], '引导流程：步骤概览', 'user1', 'thread1')) {
    }

    assert.equal(codexService.calls.length, 1, 'non-owner target cat should still be invoked');
    assert.ok(
      codexService.calls[0].includes('用户选择了「步骤概览」'),
      'selected guide branch must be visible to the routed cat even when it did not offer the guide',
    );
    assert.ok(
      !codexService.calls[0].includes('status="offered"'),
      'selection follow-up must not regress into a duplicate offered prompt',
    );
  });

  it('serial: routes owner-missing guide selection to only the first target cat', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const opusService = createCapturingService('opus', '我来给步骤概览');
    const codexService = createCapturingService('codex', '我不该收到选择分支');
    const threadStore = {
      async get() {
        return {
          id: 'thread1',
          title: 'Test',
          createdBy: 'user1',
          participants: [],
          lastActiveAt: Date.now(),
          createdAt: Date.now(),
          projectPath: 'default',
          guideState: {
            v: 1,
            guideId: 'add-member',
            status: 'offered',
            offeredAt: Date.now(),
            offeredBy: 'dare',
          },
        };
      },
      async getParticipantsWithActivity() {
        return [];
      },
      async consumeMentionRoutingFeedback() {
        return null;
      },
      async updateParticipantActivity() {},
    };
    const deps = createMockDeps({ opus: opusService, codex: codexService }, null, threadStore);

    for await (const _ of routeSerial(deps, ['opus', 'codex'], '引导流程：步骤概览', 'user1', 'thread1')) {
    }

    assert.ok(
      opusService.calls[0].includes('用户选择了「步骤概览」'),
      'first target cat should receive selection fallback',
    );
    assert.ok(
      !codexService.calls[0].includes('用户选择了「步骤概览」'),
      'second target cat must not receive duplicate selection fallback',
    );
  });

  it('serial: routes owner-missing awaiting_choice guide to only the first target cat', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const opusService = createCapturingService('opus', '我来处理等待中的引导');
    const codexService = createCapturingService('codex', '我不该收到 pending guide');
    const threadStore = {
      async get() {
        return {
          id: 'thread1',
          title: 'Test',
          createdBy: 'user1',
          participants: [],
          lastActiveAt: Date.now(),
          createdAt: Date.now(),
          projectPath: 'default',
          guideState: {
            v: 1,
            guideId: 'add-member',
            status: 'awaiting_choice',
            offeredAt: Date.now(),
            offeredBy: 'dare',
          },
        };
      },
      async getParticipantsWithActivity() {
        return [];
      },
      async consumeMentionRoutingFeedback() {
        return null;
      },
      async updateParticipantActivity() {},
    };
    const deps = createMockDeps({ opus: opusService, codex: codexService }, null, threadStore);

    for await (const _ of routeSerial(deps, ['opus', 'codex'], '继续', 'user1', 'thread1')) {
    }

    assert.ok(
      opusService.calls[0].includes('Guide Pending:'),
      'first target cat should receive the awaiting_choice reminder fallback',
    );
    assert.ok(
      !codexService.calls[0].includes('Guide Pending:'),
      'second target cat must not receive duplicate awaiting_choice context',
    );
  });

  it('parallel: passes guide selection context to a non-owner target cat', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const codexService = createCapturingService('codex', '我来给步骤概览');
    const threadStore = {
      async get() {
        return {
          id: 'thread1',
          title: 'Test',
          createdBy: 'user1',
          participants: [],
          lastActiveAt: Date.now(),
          createdAt: Date.now(),
          projectPath: 'default',
          guideState: {
            v: 1,
            guideId: 'add-member',
            status: 'offered',
            offeredAt: Date.now(),
            offeredBy: 'opus',
          },
        };
      },
      async getParticipantsWithActivity() {
        return [];
      },
      async updateParticipantActivity() {},
    };
    const deps = createMockDeps({ codex: codexService }, null, threadStore);

    for await (const _ of routeParallel(deps, ['codex'], '引导流程：步骤概览', 'user1', 'thread1')) {
    }

    assert.equal(codexService.calls.length, 1, 'parallel non-owner target cat should still be invoked');
    assert.ok(
      codexService.calls[0].includes('用户选择了「步骤概览」'),
      'parallel routed cat must see the selected guide context when the offer owner is absent',
    );
    assert.ok(
      !codexService.calls[0].includes('status="offered"'),
      'parallel selection follow-up must not regress into a duplicate offered prompt',
    );
  });

  it('parallel: routes owner-missing guide selection to only the first target cat', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const opusService = createCapturingService('opus', '我来给步骤概览');
    const codexService = createCapturingService('codex', '我不该收到选择分支');
    const threadStore = {
      async get() {
        return {
          id: 'thread1',
          title: 'Test',
          createdBy: 'user1',
          participants: [],
          lastActiveAt: Date.now(),
          createdAt: Date.now(),
          projectPath: 'default',
          guideState: {
            v: 1,
            guideId: 'add-member',
            status: 'offered',
            offeredAt: Date.now(),
            offeredBy: 'dare',
          },
        };
      },
      async getParticipantsWithActivity() {
        return [];
      },
      async updateParticipantActivity() {},
    };
    const deps = createMockDeps({ opus: opusService, codex: codexService }, null, threadStore);

    for await (const _ of routeParallel(deps, ['opus', 'codex'], '引导流程：步骤概览', 'user1', 'thread1')) {
    }

    assert.ok(
      opusService.calls[0].includes('用户选择了「步骤概览」'),
      'first target cat should receive selection fallback',
    );
    assert.ok(
      !codexService.calls[0].includes('用户选择了「步骤概览」'),
      'second target cat must not receive duplicate selection fallback',
    );
  });

  it('parallel: routes owner-missing awaiting_choice guide to only the first target cat', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const opusService = createCapturingService('opus', '我来处理等待中的引导');
    const codexService = createCapturingService('codex', '我不该收到 pending guide');
    const threadStore = {
      async get() {
        return {
          id: 'thread1',
          title: 'Test',
          createdBy: 'user1',
          participants: [],
          lastActiveAt: Date.now(),
          createdAt: Date.now(),
          projectPath: 'default',
          guideState: {
            v: 1,
            guideId: 'add-member',
            status: 'awaiting_choice',
            offeredAt: Date.now(),
            offeredBy: 'dare',
          },
        };
      },
      async getParticipantsWithActivity() {
        return [];
      },
      async updateParticipantActivity() {},
    };
    const deps = createMockDeps({ opus: opusService, codex: codexService }, null, threadStore);

    for await (const _ of routeParallel(deps, ['opus', 'codex'], '继续', 'user1', 'thread1')) {
    }

    assert.ok(
      opusService.calls[0].includes('Guide Pending:'),
      'first target cat should receive the awaiting_choice reminder fallback',
    );
    assert.ok(
      !codexService.calls[0].includes('Guide Pending:'),
      'second target cat must not receive duplicate awaiting_choice context',
    );
  });

  it('parallel: injects offered guide only to the first target cat', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const opusService = createCapturingService('opus', '我来处理引导');
    const codexService = createCapturingService('codex', '不该收到引导 offer');
    const deps = createMockDeps({ opus: opusService, codex: codexService });

    for await (const _ of routeParallel(deps, ['opus', 'codex'], '请帮我添加成员', 'user1', 'thread1')) {
    }

    assert.equal(opusService.calls.length, 1, 'first cat should be invoked');
    assert.equal(codexService.calls.length, 1, 'second cat should still be invoked');
    assert.ok(opusService.calls[0].includes('status="offered"'), 'first cat should receive guide offer instructions');
    assert.ok(
      !codexService.calls[0].includes('status="offered"'),
      'second cat must not receive duplicate guide offer instructions',
    );
  });

  it('parallel: suppresses fresh guide offers when another user has a non-terminal guide on shared default thread', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const codexService = createCapturingService('codex', '我来处理这个请求');
    const { threadStore, sessionStore } = await createSharedDefaultGuideFixture({
      v: 1,
      guideId: 'configure-provider',
      status: 'active',
      offeredAt: Date.now(),
      startedAt: Date.now(),
      offeredBy: 'opus',
      userId: 'other-user',
    });
    const deps = createMockDeps({ codex: codexService }, null, threadStore, sessionStore);

    for await (const _ of routeParallel(deps, ['codex'], '请帮我添加成员', 'user1', 'default')) {
    }

    assert.ok(
      !codexService.calls[0].includes('Guide Matched:'),
      'foreign non-terminal guide must block fresh guide matching for another user',
    );
    assert.ok(
      !codexService.calls[0].includes('status="offered"'),
      'parallel routing must not emit a fresh offered guide when another user already owns the active guide',
    );
  });

  it('parallel: ignores another user guide state on shared default thread', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const codexService = createCapturingService('codex', '我来处理这个请求');
    const { threadStore, sessionStore } = await createSharedDefaultGuideFixture({
      v: 1,
      guideId: 'configure-provider',
      status: 'completed',
      offeredAt: Date.now(),
      completedAt: Date.now(),
      offeredBy: 'opus',
      userId: 'other-user',
    });
    const deps = createMockDeps({ codex: codexService }, null, threadStore, sessionStore);

    for await (const _ of routeParallel(deps, ['codex'], '请帮我添加成员', 'user1', 'default')) {
    }

    assert.ok(
      codexService.calls[0].includes('Guide Matched:'),
      'foreign guide state should be hidden so current user can receive a fresh guide offer',
    );
    assert.ok(
      !codexService.calls[0].includes('Guide Completed:'),
      'foreign completed guide must not leak into the current user prompt',
    );
  });
});

describe('F155 guide completion ack ownership', () => {
  it('serial: does not ack a different guide that replaced the completed one', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { threadStore, sessionStore } = await createSwitchingGuideAckFixture(
      {
        v: 1,
        guideId: 'add-member',
        status: 'completed',
        offeredAt: Date.now(),
        completedAt: Date.now(),
        offeredBy: 'opus',
      },
      { v: 1, guideId: 'configure-provider', status: 'offered', offeredAt: Date.now(), offeredBy: 'codex' },
    );
    const deps = createMockDeps({ opus: createMockService('opus', 'done') }, null, threadStore, sessionStore);

    for await (const _ of routeSerial(deps, ['opus'], '继续', 'user1', 'thread1')) {
    }

    const gs = await sessionStore.getByThread('thread1');
    assert.ok(!gs.completionAcked, 'must not ack a replacement guide');
  });

  it('parallel: does not ack a different guide that replaced the completed one', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const { threadStore, sessionStore } = await createSwitchingGuideAckFixture(
      {
        v: 1,
        guideId: 'add-member',
        status: 'completed',
        offeredAt: Date.now(),
        completedAt: Date.now(),
        offeredBy: 'opus',
      },
      {
        v: 1,
        guideId: 'configure-provider',
        status: 'active',
        offeredAt: Date.now(),
        startedAt: Date.now(),
        offeredBy: 'codex',
      },
    );
    const deps = createMockDeps({ opus: createMockService('opus', 'done') }, null, threadStore, sessionStore);

    for await (const _ of routeParallel(deps, ['opus'], '继续', 'user1', 'thread1')) {
    }

    const gs = await sessionStore.getByThread('thread1');
    assert.ok(!gs.completionAcked, 'must not ack a replacement guide');
  });

  it('serial: does not ack completed guide after a silent done-only turn', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const completedGuide = {
      v: 1,
      guideId: 'add-member',
      status: 'completed',
      offeredAt: Date.now(),
      completedAt: Date.now(),
      offeredBy: 'codex',
    };
    const { threadStore, sessionStore, bridge } = await createGuideAckFixture(completedGuide, 'default');
    const deps = createMockDeps({ codex: createDoneOnlyService('codex') }, null, threadStore, sessionStore);

    for await (const _ of routeSerial(deps, ['codex'], '继续', 'user1', 'thread1')) {
    }

    const gs = await bridge.get('thread1');
    assert.ok(!gs.completionAcked, 'silent done-only turn must not ack guide completion');
  });

  it('parallel: does not ack completed guide after a silent done-only turn', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const completedGuide = {
      v: 1,
      guideId: 'add-member',
      status: 'completed',
      offeredAt: Date.now(),
      completedAt: Date.now(),
      offeredBy: 'codex',
    };
    const { threadStore, sessionStore, bridge } = await createGuideAckFixture(completedGuide, 'default');
    const deps = createMockDeps({ codex: createDoneOnlyService('codex') }, null, threadStore, sessionStore);

    for await (const _ of routeParallel(deps, ['codex'], '继续', 'user1', 'thread1')) {
    }

    const gs = await bridge.get('thread1');
    assert.ok(!gs.completionAcked, 'silent done-only turn must not ack guide completion');
  });

  it('serial: injects and acks completed guide when owner cat is not routed', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const completedGuide = {
      v: 1,
      guideId: 'add-member',
      status: 'completed',
      offeredAt: Date.now(),
      completedAt: Date.now(),
      offeredBy: 'opus',
    };
    const { threadStore, sessionStore, bridge } = await createGuideAckFixture(completedGuide, 'default');
    const codexService = createCapturingService('codex', '好的，我继续帮你');
    const deps = createMockDeps({ codex: codexService }, null, threadStore, sessionStore);

    for await (const _ of routeSerial(deps, ['codex'], '继续', 'user1', 'thread1')) {
    }

    assert.equal(codexService.calls.length, 1, 'routed non-owner cat should still be invoked');
    assert.ok(
      codexService.calls[0].includes('Guide Completed:'),
      'routed non-owner cat must see completed guide context when owner is absent',
    );
    const gs = await bridge.get('thread1');
    assert.equal(gs.completionAcked, true, 'visible non-owner response should ack guide completion');
  });

  it('serial: routes completed-guide fallback only to the first target cat', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const completedGuide = {
      v: 1,
      guideId: 'add-member',
      status: 'completed',
      offeredAt: Date.now(),
      completedAt: Date.now(),
      offeredBy: 'dare',
    };
    const { threadStore, sessionStore, bridge } = await createGuideAckFixture(completedGuide, 'default');
    const opusService = createCapturingService('opus', '我来接着处理');
    const codexService = createCapturingService('codex', '我也看到了');
    const deps = createMockDeps({ opus: opusService, codex: codexService }, null, threadStore, sessionStore);

    for await (const _ of routeSerial(deps, ['opus', 'codex'], '继续', 'user1', 'thread1')) {
    }

    assert.ok(opusService.calls[0].includes('Guide Completed:'), 'first target cat should receive completed guide');
    assert.ok(
      !codexService.calls[0].includes('Guide Completed:'),
      'second target cat must not receive duplicate completed guide fallback',
    );
    const gs = await bridge.get('thread1');
    assert.equal(gs.completionAcked, true, 'only one routed cat should ack the completed guide');
  });

  it('parallel: injects and acks completed guide when owner cat is not routed', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const completedGuide = {
      v: 1,
      guideId: 'add-member',
      status: 'completed',
      offeredAt: Date.now(),
      completedAt: Date.now(),
      offeredBy: 'opus',
    };
    const { threadStore, sessionStore, bridge } = await createGuideAckFixture(completedGuide, 'default');
    const codexService = createCapturingService('codex', '好的，我继续帮你');
    const deps = createMockDeps({ codex: codexService }, null, threadStore, sessionStore);

    for await (const _ of routeParallel(deps, ['codex'], '继续', 'user1', 'thread1')) {
    }

    assert.equal(codexService.calls.length, 1, 'routed non-owner cat should still be invoked');
    assert.ok(
      codexService.calls[0].includes('Guide Completed:'),
      'routed non-owner cat must see completed guide context when owner is absent',
    );
    const gs = await bridge.get('thread1');
    assert.equal(gs.completionAcked, true, 'visible non-owner response should ack guide completion');
  });

  it('parallel: routes completed-guide fallback only to the first target cat', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const completedGuide = {
      v: 1,
      guideId: 'add-member',
      status: 'completed',
      offeredAt: Date.now(),
      completedAt: Date.now(),
      offeredBy: 'dare',
    };
    const { threadStore, sessionStore, bridge } = await createGuideAckFixture(completedGuide, 'default');
    const opusService = createCapturingService('opus', '我来接着处理');
    const codexService = createCapturingService('codex', '我也看到了');
    const deps = createMockDeps({ opus: opusService, codex: codexService }, null, threadStore, sessionStore);

    for await (const _ of routeParallel(deps, ['opus', 'codex'], '继续', 'user1', 'thread1')) {
    }

    assert.ok(opusService.calls[0].includes('Guide Completed:'), 'first target cat should receive completed guide');
    assert.ok(
      !codexService.calls[0].includes('Guide Completed:'),
      'second target cat must not receive duplicate completed guide fallback',
    );
    const gs = await bridge.get('thread1');
    assert.equal(gs.completionAcked, true, 'only one routed cat should ack the completed guide');
  });
});

describe('routeParallel whisper privacy (F35)', () => {
  it('does NOT inject whisper content for non-recipient cat in parallel mode', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const codexService = createCapturingService('codex', 'ack');

    const deps = createMockDeps({ codex: codexService });
    deps.deliveryCursorStore = {
      getCursor: async () => undefined,
      ackCursor: async () => {},
    };
    const whisperMsgId = '0000000000000001-000001-whisper02';
    deps.messageStore.getByThreadAfter = async () => [
      {
        id: whisperMsgId,
        threadId: 'thread1',
        userId: 'user1',
        catId: null,
        content: 'SECRET: 图灵是狼人',
        mentions: ['opus'],
        timestamp: Date.now(),
        visibility: 'whisper',
        whisperTo: ['opus'],
      },
    ];

    for await (const _ of routeParallel(deps, ['codex'], 'SECRET: 图灵是狼人', 'user1', 'thread1', {
      currentUserMessageId: whisperMsgId,
      thinkingMode: 'play',
    })) {
    }

    assert.equal(codexService.calls.length, 1, 'codex should be called once');
    const prompt = codexService.calls[0];
    assert.ok(!prompt.includes('图灵'), 'whisper content must NOT appear in non-recipient prompt (parallel)');
    assert.ok(!prompt.includes('SECRET'), 'whisper content must NOT leak via parallel fallback injection');
  });
});

describe('routeParallel tool events persistence', () => {
  it('persists toolEvents per cat when agents yield tool_use events', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    // opus uses a tool, codex doesn't
    const opusService = {
      async *invoke(_prompt) {
        yield { type: 'tool_use', catId: 'opus', toolName: 'Write', toolInput: { path: '/b.ts' }, timestamp: 2000 };
        yield { type: 'tool_result', catId: 'opus', content: 'written', timestamp: 2001 };
        yield { type: 'text', catId: 'opus', content: 'wrote it', timestamp: 2002 };
        yield { type: 'done', catId: 'opus', timestamp: 2003 };
      },
    };
    const codexService = createMockService('codex', 'LGTM');

    const appendCalls = [];
    const deps = createMockDeps({ opus: opusService, codex: codexService }, appendCalls);

    for await (const _msg of routeParallel(deps, ['opus', 'codex'], 'review', 'user1', 'thread1')) {
    }

    // opus message should have toolEvents
    const opusAppend = appendCalls.find((c) => c.catId === 'opus');
    assert.ok(opusAppend, 'opus message should be appended');
    assert.ok(opusAppend.toolEvents, 'opus should have toolEvents');
    assert.equal(opusAppend.toolEvents.length, 2);
    assert.equal(opusAppend.toolEvents[0].type, 'tool_use');
    assert.equal(opusAppend.toolEvents[1].type, 'tool_result');

    // codex message should NOT have toolEvents (no tool usage)
    const codexAppend = appendCalls.find((c) => c.catId === 'codex');
    assert.ok(codexAppend, 'codex message should be appended');
    assert.ok(!codexAppend.toolEvents, 'codex should not have toolEvents');
  });

  it('persists tool-only cat (no text) in parallel mode (缅因猫 R2 P1-1)', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    // opus only yields tool events, NO text
    const toolOnlyService = {
      async *invoke(_prompt) {
        yield { type: 'tool_use', catId: 'opus', toolName: 'Grep', toolInput: { pattern: 'foo' }, timestamp: 3000 };
        yield { type: 'tool_result', catId: 'opus', content: 'found 3 matches', timestamp: 3001 };
        yield { type: 'done', catId: 'opus', timestamp: 3002 };
      },
    };
    const codexService = createMockService('codex', 'LGTM');

    const appendCalls = [];
    const deps = createMockDeps({ opus: toolOnlyService, codex: codexService }, appendCalls);

    for await (const _msg of routeParallel(deps, ['opus', 'codex'], 'search', 'user1', 'thread1')) {
    }

    // Even though opus had no text, it should still be persisted with tool events
    const opusAppend = appendCalls.find((c) => c.catId === 'opus');
    assert.ok(opusAppend, 'tool-only cat should still be persisted');
    assert.equal(opusAppend.content, '', 'content should be empty');
    assert.ok(opusAppend.toolEvents, 'should have toolEvents');
    assert.equal(opusAppend.toolEvents.length, 2);
    assert.equal(opusAppend.toolEvents[0].type, 'tool_use');
    assert.equal(opusAppend.toolEvents[1].type, 'tool_result');
  });
});

describe('routeSerial persistence context (P1-2)', () => {
  it('sets persistenceContext.failed when messageStore.append throws', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');

    const deps = createMockDeps({ opus: createMockService('opus', '结果') });
    deps.messageStore.append = async () => {
      throw new Error('Redis connection refused');
    };

    const persistenceContext = { failed: false, errors: [] };
    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1', { persistenceContext })) {
      messages.push(msg);
    }

    assert.ok(persistenceContext.failed, 'persistenceContext.failed should be true');
    assert.ok(persistenceContext.errors.length > 0, 'should record error details');
    assert.equal(persistenceContext.errors[0].catId, 'opus');
    assert.ok(persistenceContext.errors[0].error.includes('Redis'), 'error should contain original message');

    // done MUST still be yielded despite append failure
    const doneMsgs = messages.filter((m) => m.type === 'done');
    assert.ok(doneMsgs.length > 0, 'done must still be yielded');
  });

  it('does not set persistenceContext.failed on successful append', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({ opus: createMockService('opus', 'success') });

    const persistenceContext = { failed: false, errors: [] };
    for await (const _msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1', { persistenceContext })) {
      // consume
    }

    assert.equal(persistenceContext.failed, false);
    assert.equal(persistenceContext.errors.length, 0);
  });
});

describe('routeParallel persistence context (P1-2)', () => {
  it('sets persistenceContext.failed when messageStore.append throws', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    const deps = createMockDeps({
      opus: createMockService('opus', 'opus says'),
      codex: createMockService('codex', 'codex says'),
    });
    deps.messageStore.append = async () => {
      throw new Error('Redis connection refused');
    };

    const persistenceContext = { failed: false, errors: [] };
    const messages = [];
    for await (const msg of routeParallel(deps, ['opus', 'codex'], 'test', 'user1', 'thread1', {
      persistenceContext,
    })) {
      messages.push(msg);
    }

    assert.ok(persistenceContext.failed, 'persistenceContext.failed should be true');
    assert.ok(persistenceContext.errors.length >= 2, 'should record errors for both cats');

    // done MUST still be yielded for both
    const doneMsgs = messages.filter((m) => m.type === 'done');
    assert.equal(doneMsgs.length, 2);
  });

  it('does not set persistenceContext.failed on successful append', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const deps = createMockDeps({
      opus: createMockService('opus', 'opus says'),
      codex: createMockService('codex', 'codex says'),
    });

    const persistenceContext = { failed: false, errors: [] };
    for await (const _msg of routeParallel(deps, ['opus', 'codex'], 'test', 'user1', 'thread1', {
      persistenceContext,
    })) {
      // consume
    }

    assert.equal(persistenceContext.failed, false);
    assert.equal(persistenceContext.errors.length, 0);
  });
});

describe('image contentBlocks routing', () => {
  it('routeParallel passes image contentBlocks to all target cats', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const opusService = createOptionsCapturingService('opus', 'opus');
    const codexService = createOptionsCapturingService('codex', 'codex');
    const deps = createMockDeps({ opus: opusService, codex: codexService });
    const contentBlocks = [
      { type: 'text', text: '看图' },
      { type: 'image', url: '/uploads/test.png' },
    ];

    for await (const _msg of routeParallel(deps, ['opus', 'codex'], '看这张图', 'user1', 'thread1', {
      contentBlocks,
      uploadDir: '/tmp/uploads',
    })) {
      // consume
    }

    assert.equal(opusService.calls.length, 1, 'opus should be invoked once');
    assert.deepEqual(
      opusService.calls[0].options?.contentBlocks,
      contentBlocks,
      'opus should receive image contentBlocks',
    );
    assert.equal(opusService.calls[0].options?.uploadDir, '/tmp/uploads', 'opus should receive uploadDir');

    assert.equal(codexService.calls.length, 1, 'codex should be invoked once');
    assert.deepEqual(
      codexService.calls[0].options?.contentBlocks,
      contentBlocks,
      'codex should receive original image contentBlocks',
    );
    assert.equal(codexService.calls[0].options?.uploadDir, '/tmp/uploads', 'codex should receive uploadDir');
  });

  it('routeSerial passes image contentBlocks to all target cats', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const opusService = createOptionsCapturingService('opus', 'opus');
    const codexService = createOptionsCapturingService('codex', 'codex');
    const deps = createMockDeps({ opus: opusService, codex: codexService });
    const contentBlocks = [
      { type: 'text', text: '看图' },
      { type: 'image', url: '/uploads/test.png' },
    ];

    for await (const _msg of routeSerial(deps, ['opus', 'codex'], '看这张图', 'user1', 'thread1', {
      contentBlocks,
      uploadDir: '/tmp/uploads',
    })) {
      // consume
    }

    assert.equal(opusService.calls.length, 1, 'opus should be invoked once');
    assert.deepEqual(
      opusService.calls[0].options?.contentBlocks,
      contentBlocks,
      'opus should receive image contentBlocks',
    );
    assert.equal(opusService.calls[0].options?.uploadDir, '/tmp/uploads', 'opus should receive uploadDir');

    assert.equal(codexService.calls.length, 1, 'codex should be invoked once');
    assert.deepEqual(
      codexService.calls[0].options?.contentBlocks,
      contentBlocks,
      'codex should receive original image contentBlocks',
    );
    assert.equal(codexService.calls[0].options?.uploadDir, '/tmp/uploads', 'codex should receive uploadDir');
  });
});

describe('routeSerial per-cat budget', () => {
  it('uses history for context assembly when provided', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const captureService = createCapturingService('opus', 'response');
    const deps = createMockDeps({ opus: captureService });

    // Provide history in options
    const history = [
      {
        id: 'm1',
        threadId: 'thread1',
        userId: 'user1',
        catId: null,
        content: '之前说了什么',
        mentions: [],
        timestamp: Date.now() - 1000,
      },
      {
        id: 'm2',
        threadId: 'thread1',
        userId: 'user1',
        catId: 'opus',
        content: '我回复了',
        mentions: [],
        timestamp: Date.now() - 500,
      },
    ];

    for await (const _ of routeSerial(deps, ['opus'], 'new message', 'user1', 'thread1', { history })) {
    }

    // Check that prompt includes context from history
    assert.equal(captureService.calls.length, 1, 'opus should be called once');
    const prompt = captureService.calls[0];
    assert.ok(prompt.includes('对话历史'), 'prompt should include history header');
    assert.ok(prompt.includes('之前说了什么'), 'prompt should include history content');
  });

  it('falls back to legacy contextHistory when provided', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const captureService = createCapturingService('opus', 'response');
    const deps = createMockDeps({ opus: captureService });

    for await (const _ of routeSerial(deps, ['opus'], 'msg', 'user1', 'thread1', {
      contextHistory: '[对话历史] 测试上下文',
    })) {
    }

    const prompt = captureService.calls[0];
    assert.ok(prompt.includes('[对话历史] 测试上下文'), 'prompt should include legacy contextHistory');
  });
});

describe('routeParallel per-cat budget', () => {
  it('uses history for context assembly when provided', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const opusService = createCapturingService('opus', 'opus says');
    const codexService = createCapturingService('codex', 'codex says');
    const deps = createMockDeps({ opus: opusService, codex: codexService });

    const history = [
      {
        id: 'm1',
        threadId: 'thread1',
        userId: 'user1',
        catId: null,
        content: '历史消息',
        mentions: [],
        timestamp: Date.now() - 1000,
      },
    ];

    for await (const _ of routeParallel(deps, ['opus', 'codex'], 'test', 'user1', 'thread1', { history })) {
    }

    // Both cats should receive history in their prompts
    assert.ok(opusService.calls[0].includes('对话历史'), 'opus prompt should include history');
    assert.ok(codexService.calls[0].includes('历史消息'), 'codex prompt should include history content');
  });
});

describe('routeSerial degradation notification', () => {
  it('yields system_info when history exceeds budget maxMessages', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({ opus: createMockService('opus', 'response') });

    // Generate 250 messages to exceed opus default maxMessages=200
    const history = Array.from({ length: 250 }, (_, i) => ({
      id: `m${i}`,
      threadId: 'thread1',
      userId: 'user1',
      catId: i % 2 === 0 ? null : 'opus',
      content: `message ${i}`,
      mentions: [],
      timestamp: Date.now() - (250 - i) * 1000,
    }));

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1', { history })) {
      messages.push(msg);
    }

    const sysInfos = degradationSystemInfos(messages);
    assert.ok(sysInfos.length > 0, 'should yield degradation system_info');
    assert.ok(sysInfos[0].content.includes('截断'), 'degradation message should mention truncation');
  });

  it('does not yield system_info when history is within budget', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({ opus: createMockService('opus', 'response') });

    // 5 messages — well within opus maxMessages=200
    const history = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      threadId: 'thread1',
      userId: 'user1',
      catId: null,
      content: `message ${i}`,
      mentions: [],
      timestamp: Date.now() - (5 - i) * 1000,
    }));

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1', { history })) {
      messages.push(msg);
    }

    const sysInfos = degradationSystemInfos(messages);
    assert.equal(sysInfos.length, 0, 'should not yield degradation when within budget');
  });

  it('yields system_info when context is truncated by token budget (not count)', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({ opus: createMockService('opus', 'response') });

    // Override maxPromptTokens to a small value via env.
    // budgetForContext = maxPromptTokens - systemTokens - promptTokens - 200
    // With maxPromptTokens=500, budgetForContext ≈ 90 tokens → truncation.
    // Count (20) is within maxMessages (200), but total tokens exceed context budget.
    process.env.CAT_OPUS_MAX_PROMPT_TOKENS = '500';
    try {
      const history = Array.from({ length: 20 }, (_, i) => ({
        id: `m${i}`,
        threadId: 'thread1',
        userId: 'user1',
        catId: null,
        content: `message ${i} with some padding text here`,
        mentions: [],
        timestamp: Date.now() - (20 - i) * 1000,
      }));

      const messages = [];
      for await (const msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1', { history })) {
        messages.push(msg);
      }

      const sysInfos = degradationSystemInfos(messages);
      assert.ok(sysInfos.length > 0, 'should yield degradation when token budget truncates context');
      assert.ok(sysInfos[0].content.includes('截断'), 'degradation message should mention truncation');
    } finally {
      delete process.env.CAT_OPUS_MAX_PROMPT_TOKENS;
    }
  });
});

describe('routeParallel degradation notification', () => {
  it('yields system_info for each degraded cat', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const deps = createMockDeps({
      opus: createMockService('opus', 'opus says'),
      codex: createMockService('codex', 'codex says'),
    });

    // 250 messages — exceeds both opus (200) and codex (200) limits
    const history = Array.from({ length: 250 }, (_, i) => ({
      id: `m${i}`,
      threadId: 'thread1',
      userId: 'user1',
      catId: null,
      content: `message ${i}`,
      mentions: [],
      timestamp: Date.now() - (250 - i) * 1000,
    }));

    const messages = [];
    for await (const msg of routeParallel(deps, ['opus', 'codex'], 'test', 'user1', 'thread1', { history })) {
      messages.push(msg);
    }

    const sysInfos = degradationSystemInfos(messages);
    assert.ok(sysInfos.length >= 2, 'should yield degradation for both cats');
  });

  it('yields system_info when context is truncated by character budget in parallel mode', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const deps = createMockDeps({
      opus: createMockService('opus', 'opus says'),
      codex: createMockService('codex', 'codex says'),
    });

    // Count is within both cats' maxMessages (codex=200, opus=200), but token budget should force truncation.
    // Override codex maxPromptTokens to a small value so assembleContext can't fit the full history.
    process.env.CAT_CODEX_MAX_PROMPT_TOKENS = '500';
    try {
      const history = Array.from({ length: 50 }, (_, i) => ({
        id: `m${i}`,
        threadId: 'thread1',
        userId: 'user1',
        catId: null,
        content: `message ${i} ${'y'.repeat(2100)}`,
        mentions: [],
        timestamp: Date.now() - (50 - i) * 1000,
      }));

      const messages = [];
      for await (const msg of routeParallel(deps, ['opus', 'codex'], 'test', 'user1', 'thread1', { history })) {
        messages.push(msg);
      }

      const sysInfos = degradationSystemInfos(messages);
      assert.ok(sysInfos.length > 0, 'should yield at least one degradation system_info');
    } finally {
      delete process.env.CAT_CODEX_MAX_PROMPT_TOKENS;
    }
  });
});

describe('routeParallel A2A safety', () => {
  it('does not chain A2A even when mentions are detected', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        opus: createMockService('opus', '需要缅因猫帮忙\n@缅因猫 请看'),
        codex: createMockService('codex', '我来了'),
      },
      appendCalls,
    );

    const messages = [];
    for await (const msg of routeParallel(deps, ['opus', 'codex'], 'brainstorm', 'user1', 'thread1')) {
      messages.push(msg);
    }

    // Should not yield any a2a_handoff events
    const handoffs = messages.filter((m) => m.type === 'a2a_handoff');
    assert.equal(handoffs.length, 0, 'parallel mode should never chain A2A');

    // But mentions should still be stored
    const opusAppend = appendCalls.find((c) => c.catId === 'opus');
    assert.ok(opusAppend, 'opus response should be stored');
    assert.deepEqual(opusAppend.mentions, ['codex'], 'mentions should be detected and stored');
  });

  it('executes multiple cats independently and yields interleaved messages', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const deps = createMockDeps({
      opus: createMockService('opus', 'opus says'),
      codex: createMockService('codex', 'codex says'),
    });

    const messages = [];
    for await (const msg of routeParallel(deps, ['opus', 'codex'], 'test', 'user1', 'thread1')) {
      messages.push(msg);
    }

    const doneMsgs = messages.filter((m) => m.type === 'done');
    assert.equal(doneMsgs.length, 2, 'should have 2 done messages (one per cat)');

    // Last done should be marked isFinal
    const finalDone = doneMsgs.find((m) => m.isFinal === true);
    assert.ok(finalDone, 'last done should be marked isFinal');

    // Both cats should have text
    const opusText = messages.filter((m) => m.type === 'text' && m.catId === 'opus');
    const codexText = messages.filter((m) => m.type === 'text' && m.catId === 'codex');
    assert.ok(opusText.length > 0, 'opus should have text');
    assert.ok(codexText.length > 0, 'codex should have text');
  });
});

// ── P1 Bug: CLI error + empty message persistence ──

/** Mock service that yields only error + done (simulates CLI exit code 1 with no text) */
function createErrorOnlyService(catId) {
  return {
    async *invoke() {
      yield { type: 'error', catId, error: 'CLI 异常退出 (code: 1, signal: none)', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

describe('routeSerial: CLI error without text should not persist empty message (P1)', () => {
  it('persists error text when cat yields error + done with no user-visible text', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        codex: createErrorOnlyService('codex'),
      },
      appendCalls,
    );

    const messages = [];
    for await (const msg of routeSerial(deps, ['codex'], 'test', 'user1', 'thread1')) {
      messages.push(msg);
    }

    // Error should be yielded to frontend
    const errorMsgs = messages.filter((m) => m.type === 'error');
    assert.ok(errorMsgs.length > 0, 'error message should be yielded to frontend');

    // Error-only response: no cat message, error persisted as system message
    const catAppends = appendCalls.filter((c) => c.catId === 'codex');
    assert.equal(catAppends.length, 0, 'error-only should NOT persist as cat message');
    const sysAppends = appendCalls.filter((c) => c.userId === 'system' && c.catId === null);
    assert.equal(sysAppends.length, 1, 'error should be persisted as system message');
    assert.ok(sysAppends[0].content.startsWith('Error:'), 'system error should start with Error: prefix');

    // Done should still be yielded
    const doneMsgs = messages.filter((m) => m.type === 'done');
    assert.ok(doneMsgs.length > 0, 'done should still be yielded');
  });

  it('still persists message normally when cat yields text + done (no error)', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        codex: createMockService('codex', 'normal response'),
      },
      appendCalls,
    );

    for await (const _ of routeSerial(deps, ['codex'], 'test', 'user1', 'thread1')) {
    }

    const catAppends = appendCalls.filter((c) => c.catId === 'codex');
    assert.equal(catAppends.length, 1, 'normal response should be persisted');
    assert.equal(catAppends[0].content, 'normal response');
  });

  it('still persists message when cat yields error + text + done (partial response)', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        codex: {
          async *invoke() {
            yield { type: 'text', catId: 'codex', content: 'partial output before error', timestamp: Date.now() };
            yield { type: 'error', catId: 'codex', error: 'timeout', timestamp: Date.now() };
            yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          },
        },
      },
      appendCalls,
    );

    for await (const _ of routeSerial(deps, ['codex'], 'test', 'user1', 'thread1')) {
    }

    // Partial text persisted as cat message (clean, no [错误] contamination)
    const catAppends = appendCalls.filter((c) => c.catId === 'codex');
    assert.equal(catAppends.length, 1, 'partial response with text should still be persisted');
    assert.equal(
      catAppends[0].content,
      'partial output before error',
      'cat content should be clean text without error suffix',
    );
    // Error persisted separately as system message
    const sysAppends = appendCalls.filter((c) => c.userId === 'system' && c.catId === null);
    assert.equal(sysAppends.length, 1, 'error should be persisted as separate system message');
    assert.ok(sysAppends[0].content.includes('timeout'), 'system error should contain error text');
  });
});

// ---- routeSerial done-only origin tagging (砚砚 R9 regression) ----

/** Mock service that yields only done (no text, no error) */
function createDoneOnlyService(catId) {
  return {
    async *invoke() {
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

/** Mock service that yields a visible system_info notice but no text */
function createVisibleNoticeOnlyService(catId, content) {
  return {
    async *invoke() {
      yield { type: 'system_info', catId, content, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

describe('routeSerial: done-only (no text, no error)', () => {
  it('does not persist empty message when cat yields only done', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        codex: createDoneOnlyService('codex'),
      },
      appendCalls,
    );

    for await (const _ of routeSerial(deps, ['codex'], 'test', 'user1', 'thread1', {
      thinkingMode: 'play',
    })) {
    }

    const catAppends = appendCalls.filter((c) => c.catId === 'codex');
    assert.equal(catAppends.length, 0, 'done-only cat should not persist a blank message');
  });

  it('does not append silent_completion when a visible system notice already exists', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({
      codex: createVisibleNoticeOnlyService(
        'codex',
        '⚠️ Shared-state files committed but not pushed: docs/ROADMAP.md. Please `git push` soon.',
      ),
    });

    const messages = [];
    for await (const msg of routeSerial(deps, ['codex'], 'test', 'user1', 'thread1', {
      thinkingMode: 'play',
    })) {
      messages.push(msg);
    }

    const notices = messages.filter((m) => m.type === 'system_info' && m.content?.includes('Shared-state files'));
    assert.equal(notices.length, 1, 'visible notice should be forwarded exactly once');
    assert.equal(
      messages.some((m) => m.type === 'system_info' && m.content?.includes('completed without textual output')),
      false,
      'should not add a duplicate silent_completion after a visible notice',
    );
  });

  it('still yields a final done event when cat is silent', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        codex: createDoneOnlyService('codex'),
      },
      appendCalls,
    );

    const messages = [];
    for await (const msg of routeSerial(deps, ['codex'], 'test', 'user1', 'thread1', {
      thinkingMode: 'play',
    })) {
      messages.push(msg);
    }

    const doneMsgs = messages.filter((m) => m.type === 'done');
    assert.equal(doneMsgs.length, 1, 'silent cat should still produce one done event');
    assert.equal(doneMsgs[0].isFinal, true, 'silent single-cat run should mark done as final');
    const catAppends = appendCalls.filter((c) => c.catId === 'codex');
    assert.equal(catAppends.length, 0, 'silent cat should not persist blank content');
  });
});

describe('routeParallel: done-only (no text, no error)', () => {
  it('does not persist empty message when cat yields only done', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        codex: createDoneOnlyService('codex'),
      },
      appendCalls,
    );

    const messages = [];
    for await (const msg of routeParallel(deps, ['codex'], 'test', 'user1', 'thread1')) {
      messages.push(msg);
    }

    const doneMsgs = messages.filter((m) => m.type === 'done');
    assert.equal(doneMsgs.length, 1, 'silent parallel cat should still produce one done event');
    assert.equal(doneMsgs[0].isFinal, true, 'silent parallel single-cat run should mark done as final');
    const catAppends = appendCalls.filter((c) => c.catId === 'codex');
    assert.equal(catAppends.length, 0, 'silent parallel cat should not persist blank content');
  });

  it('does not append silent_completion when a visible system notice already exists', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const deps = createMockDeps({
      codex: createVisibleNoticeOnlyService(
        'codex',
        '⚠️ Shared-state files committed but not pushed: docs/ROADMAP.md. Please `git push` soon.',
      ),
    });

    const messages = [];
    for await (const msg of routeParallel(deps, ['codex'], 'test', 'user1', 'thread1')) {
      messages.push(msg);
    }

    const notices = messages.filter((m) => m.type === 'system_info' && m.content?.includes('Shared-state files'));
    assert.equal(notices.length, 1, 'visible notice should be forwarded exactly once');
    assert.equal(
      messages.some((m) => m.type === 'system_info' && m.content?.includes('completed without textual output')),
      false,
      'should not add a duplicate silent_completion after a visible notice',
    );
  });
});

// F045: Thinking persistence tests — Red→Green per 砚砚 R1 P1
describe('routeParallel thinking persistence (F045)', () => {
  it('persists thinking from system_info events alongside text content', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    // Mock service that emits thinking → text → done
    const thinkingService = {
      async *invoke(_prompt) {
        yield {
          type: 'system_info',
          catId: 'opus',
          content: JSON.stringify({ type: 'invocation_created', invocationId: 'inv-think-1' }),
          timestamp: Date.now(),
        };
        yield {
          type: 'system_info',
          catId: 'opus',
          content: JSON.stringify({ type: 'thinking', text: 'Let me reason about this...' }),
          timestamp: Date.now(),
        };
        yield { type: 'text', catId: 'opus', content: 'Here is my answer', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const appendCalls = [];
    const deps = createMockDeps({ opus: thinkingService }, appendCalls);

    const messages = [];
    for await (const msg of routeParallel(deps, ['opus'], 'test', 'user1', 'thread1')) {
      messages.push(msg);
    }

    assert.equal(appendCalls.length, 1, 'should store one message');
    const stored = appendCalls[0];
    assert.equal(stored.thinking, 'Let me reason about this...', 'thinking must be persisted');
    assert.equal(stored.content, 'Here is my answer', 'text content must be persisted');
  });

  it('concatenates multiple thinking blocks with --- separator', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    const multiThinkService = {
      async *invoke(_prompt) {
        yield {
          type: 'system_info',
          catId: 'opus',
          content: JSON.stringify({ type: 'invocation_created', invocationId: 'inv-think-2' }),
          timestamp: Date.now(),
        };
        yield {
          type: 'system_info',
          catId: 'opus',
          content: JSON.stringify({ type: 'thinking', text: 'First thought' }),
          timestamp: Date.now(),
        };
        yield {
          type: 'system_info',
          catId: 'opus',
          content: JSON.stringify({ type: 'thinking', text: 'Second thought' }),
          timestamp: Date.now(),
        };
        yield { type: 'text', catId: 'opus', content: 'done', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const appendCalls = [];
    const deps = createMockDeps({ opus: multiThinkService }, appendCalls);

    for await (const _msg of routeParallel(deps, ['opus'], 'test', 'user1', 'thread1')) {
      /* drain */
    }

    assert.equal(appendCalls[0].thinking, 'First thought\n\n---\n\nSecond thought');
  });

  it('forwards invocation_created system_info to frontend while still persisting content', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    const service = {
      async *invoke(_prompt) {
        yield {
          type: 'system_info',
          catId: 'opus',
          content: JSON.stringify({ type: 'invocation_created', invocationId: 'inv-par-forward-1' }),
          timestamp: Date.now(),
        };
        yield { type: 'text', catId: 'opus', content: 'parallel answer', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const appendCalls = [];
    const deps = createMockDeps({ opus: service }, appendCalls);

    const messages = [];
    for await (const msg of routeParallel(deps, ['opus'], 'test', 'user1', 'thread1')) {
      messages.push(msg);
    }

    const invocationCreated = messages.find(
      (m) => m.type === 'system_info' && typeof m.content === 'string' && m.content.includes('"invocation_created"'),
    );
    assert.ok(invocationCreated, 'routeParallel must forward invocation_created');
    assert.equal(appendCalls.length, 1, 'content persistence should still work');
  });
});

describe('routeSerial thinking persistence (F045)', () => {
  it('persists thinking from system_info events alongside text content', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');

    const thinkingService = {
      async *invoke(_prompt) {
        yield {
          type: 'system_info',
          catId: 'opus',
          content: JSON.stringify({ type: 'invocation_created', invocationId: 'inv-think-s1' }),
          timestamp: Date.now(),
        };
        yield {
          type: 'system_info',
          catId: 'opus',
          content: JSON.stringify({ type: 'thinking', text: 'Serial thinking...' }),
          timestamp: Date.now(),
        };
        yield { type: 'text', catId: 'opus', content: 'Serial answer', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const appendCalls = [];
    const deps = createMockDeps({ opus: thinkingService }, appendCalls);

    for await (const _msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1')) {
      /* drain */
    }

    assert.equal(appendCalls.length, 1, 'should store one message');
    assert.equal(appendCalls[0].thinking, 'Serial thinking...', 'thinking must be persisted in serial mode');
    assert.ok(appendCalls[0].content.includes('Serial answer'), 'text content must be persisted');
  });

  it('forwards invocation_created system_info to frontend while still persisting content', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');

    const service = {
      async *invoke(_prompt) {
        yield {
          type: 'system_info',
          catId: 'opus',
          content: JSON.stringify({ type: 'invocation_created', invocationId: 'inv-ser-forward-1' }),
          timestamp: Date.now(),
        };
        yield { type: 'text', catId: 'opus', content: 'serial answer', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
    };

    const appendCalls = [];
    const deps = createMockDeps({ opus: service }, appendCalls);

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1')) {
      messages.push(msg);
    }

    const invocationCreated = messages.find(
      (m) => m.type === 'system_info' && typeof m.content === 'string' && m.content.includes('"invocation_created"'),
    );
    assert.ok(invocationCreated, 'routeSerial must forward invocation_created');
    assert.equal(appendCalls.length, 1, 'content persistence should still work');
  });
});
