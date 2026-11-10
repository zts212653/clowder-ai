/**
 * Dropped-ball guard wiring for final replies. A reply is already on screen, so nothing can
 * stop it; and only an explicit mention reaches the owner's mailbox (2026-10-10 decision), so
 * nothing is added for the cat. Instead the cat gets a next-turn reminder, and when the owner
 * is not in the thread it is woken once to decide or mention him. Detector coverage lives in
 * `owner-ask-detect.test.js`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const ASK = '两版都画好了。\n\n你点头我就交给小太阳开工。';

function textService(catId, content, tool) {
  return {
    async *invoke() {
      if (tool) {
        yield { type: 'tool_use', catId, toolName: tool.name, toolInput: tool.input, timestamp: Date.now() };
      }
      yield { type: 'text', catId, content, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createDeps({ content, history = [], trigger = null, tool = null }) {
  const appendCalls = [];
  const feedbackWrites = [];
  const deliveries = [];
  let invocationSeq = 0;
  let messageSeq = 0;
  const deps = {
    services: { opus: textService('opus', content, tool) },
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        async getParticipantsWithActivity() {
          return [];
        },
        async get(threadId) {
          return {
            id: threadId,
            title: 'Test Thread',
            createdBy: 'user1',
            participants: [],
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            projectPath: 'default',
          };
        },
        async consumeMentionRoutingFeedback() {
          return null;
        },
        async setMentionRoutingFeedback(threadId, catId, payload) {
          feedbackWrites.push({ threadId, catId, payload });
        },
        async getVotingState() {
          return null;
        },
        async updateVotingState() {},
        async updateParticipantActivity() {},
      },
      apiUrl: 'http://127.0.0.1:3004',
      ownerAskCorrectionDeliver: async (opts) => {
        deliveries.push(opts);
        return `delivered-${deliveries.length}`;
      },
    },
    messageStore: {
      append: async (msg) => {
        appendCalls.push(msg);
        return { ...msg, id: `msg-${++messageSeq}`, threadId: msg.threadId ?? 'default' };
      },
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => history,
      getById: async (id) => (trigger && trigger.id === id ? trigger : null),
    },
  };
  return { deps, appendCalls, feedbackWrites, deliveries };
}

async function run(content, threadId, setup = {}, options = {}) {
  const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
  const { deps, appendCalls, feedbackWrites, deliveries } = createDeps({ content, ...setup });
  for await (const _msg of routeSerial(deps, ['opus'], '继续', 'user1', threadId, options)) {
  }
  const reply = appendCalls.find((msg) => msg.from?.catId === 'opus');
  assert.ok(reply, 'the cat reply is persisted');
  const reasons = feedbackWrites.flatMap((write) => write.payload.items.map((item) => item.reason));
  return { reply, reasons, deliveries };
}

describe('route-serial: a final reply that waits for the owner without a mention', () => {
  it('does not add it to the mailbox, reminds the cat, and wakes it once while the owner is away', async () => {
    const { reply, reasons, deliveries } = await run(ASK, 'thread-owner-ask-1');
    assert.ok(!reply.mentionsUser, 'only an explicit mention enters the mailbox');
    assert.ok(reasons.includes('owner_ask_unaddressed'));
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].targetCatId, 'opus');
    assert.equal(deliveries[0].threadId, 'thread-owner-ask-1');
    assert.equal(deliveries[0].source.connector, 'owner-ask-check');
    assert.equal(deliveries[0].ownerAuthProvenance, 'unknown');
    assert.match(deliveries[0].privateContent, /掉球检查/);
    assert.match(deliveries[0].privateContent, /你点头我就交给小太阳开工/);
  });

  it('only reminds the cat when the owner spoke in the thread a few minutes ago', async () => {
    const history = [
      { id: 'h1', from: { kind: 'user', userId: 'user1' }, content: '那就这样', timestamp: Date.now() - 2 * 60 * 1000 },
    ];
    const { reasons, deliveries } = await run(ASK, 'thread-owner-ask-2', { history });
    assert.ok(reasons.includes('owner_ask_unaddressed'));
    assert.equal(deliveries.length, 0);
  });

  it('wakes the cat when the only recent owner message is the instruction that started the turn', async () => {
    const instruction = {
      id: 'human-1',
      from: { kind: 'user', userId: 'user1' },
      content: '把这两版都画出来',
      timestamp: Date.now() - 5000,
    };
    const { deliveries } = await run(
      ASK,
      'thread-owner-ask-8',
      { history: [instruction] },
      { currentUserMessageId: 'human-1' },
    );
    assert.equal(deliveries.length, 1);
  });

  it('leaves the text alone when this turn already opened an approval card', async () => {
    const { reasons, deliveries } = await run(
      '开线卡已经发出。\n\n我开了一张执行线程的提议卡，请你批准。',
      'thread-owner-ask-9',
      {
        tool: { name: 'cat_cafe_propose_thread', input: { title: '执行线程' } },
      },
    );
    assert.equal(reasons.includes('owner_ask_unaddressed'), false);
    assert.equal(deliveries.length, 0);
  });

  it('does not ask for another correction from the correction turn itself', async () => {
    const trigger = {
      id: 'check-1',
      from: { kind: 'system', service: 'owner-ask-check' },
      source: { connector: 'owner-ask-check', label: '掉球检查' },
      content: '上一条在等你决定或动手，但没有 @ 你。',
      timestamp: Date.now() - 1000,
    };
    const { deliveries } = await run(ASK, 'thread-owner-ask-3', { trigger }, { currentUserMessageId: 'check-1' });
    assert.equal(deliveries.length, 0);
  });

  it('wakes the cat for an interactive card left in the reply', async () => {
    const card = {
      id: 'pick-2',
      kind: 'interactive',
      v: 1,
      interactiveType: 'select',
      title: '用哪一张？',
      options: [
        { id: 'a', label: '第一张' },
        { id: 'b', label: '第二张' },
      ],
    };
    const content = `两张形象图在卡里。\n\n\`\`\`cc_rich\n${JSON.stringify({ v: 1, blocks: [card] })}\n\`\`\``;
    const { reply, deliveries } = await run(content, 'thread-owner-ask-4');
    assert.equal(reply.extra?.rich?.blocks?.[0]?.kind, 'interactive');
    assert.equal(deliveries.length, 1);
  });
});

describe('route-serial: replies the guard leaves alone', () => {
  it('an explicit line-start mention goes to the mailbox as before', async () => {
    const { reply, reasons, deliveries } = await run(
      '测试通过。\n\n@co-creator\n你点头我就合入。',
      'thread-owner-ask-5',
    );
    assert.equal(reply.mentionsUser, true);
    assert.equal(reasons.includes('owner_ask_unaddressed'), false);
    assert.equal(deliveries.length, 0);
  });

  it('a reply routed to a cat stays with that cat', async () => {
    const { reply, reasons, deliveries } = await run(
      '@codex\n等co-creator点头之后，请把三样接进样机。',
      'thread-owner-ask-6',
    );
    assert.ok(!reply.mentionsUser);
    assert.equal(reasons.includes('owner_ask_unaddressed'), false);
    assert.equal(deliveries.length, 0);
  });

  it('an ordinary report', async () => {
    const { reasons, deliveries } = await run('测试全部通过，已经合入。', 'thread-owner-ask-7');
    assert.equal(reasons.includes('owner_ask_unaddressed'), false);
    assert.equal(deliveries.length, 0);
  });
});
