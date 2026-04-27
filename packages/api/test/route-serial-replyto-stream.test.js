import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function createMockService(catId, text) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, appendCalls) {
  let invocationSeq = 0;
  let messageSeq = 0;
  const storedById = new Map();

  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = {
          id: `msg-${++messageSeq}`,
          userId: msg.userId,
          catId: msg.catId,
          content: msg.content,
          mentions: msg.mentions,
          timestamp: msg.timestamp,
          threadId: msg.threadId ?? 'default',
          ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
        };
        appendCalls.push(msg);
        storedById.set(stored.id, stored);
        return stored;
      },
      getById: async (id) => storedById.get(id) ?? null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

describe('routeSerial replyTo on stream messages', () => {
  it('attaches replyTo + replyPreview to CLI A2A stream responses', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        opus: createMockService('opus', '我先看一下\n@缅因猫 帮忙复核'),
        codex: createMockService('codex', '收到，我来复核'),
      },
      appendCalls,
    );

    const yielded = [];
    for await (const msg of routeSerial(deps, ['opus'], 'check this', 'user1', 'thread1')) {
      yielded.push(msg);
    }

    assert.equal(appendCalls.length, 2, 'should persist both opus and codex stream messages');
    assert.equal(appendCalls[0].replyTo, undefined, 'originating cat should not reply to anything');
    assert.equal(appendCalls[1].replyTo, 'msg-1', 'A2A stream reply should persist replyTo to trigger message');

    const codexText = yielded.find((msg) => msg.type === 'text' && msg.catId === 'codex');
    assert.ok(codexText, 'should yield codex stream text');
    assert.equal(codexText.replyTo, 'msg-1', 'stream text should carry replyTo for live ReplyPill rendering');
    assert.deepEqual(codexText.replyPreview, {
      senderCatId: 'opus',
      content: '我先看一下\n@缅因猫 帮忙复核',
    });
  });
});
