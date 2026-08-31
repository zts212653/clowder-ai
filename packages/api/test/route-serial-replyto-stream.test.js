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

function createMockDeps(services, appendCalls, initialMessages = []) {
  let invocationSeq = 0;
  let messageSeq = 0;
  const storedById = new Map();

  for (const msg of initialMessages) storedById.set(msg.id, msg);

  return {
    services,
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
  it('attaches replyTo and persists trigger provenance for queue-dispatched initial target', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        codex: createMockService('codex', '收到，我来复核'),
      },
      appendCalls,
      [
        {
          id: 'msg-trigger',
          userId: 'user1',
          catId: 'opus',
          content: '@缅因猫 帮忙复核',
          mentions: ['codex'],
          timestamp: 123,
          threadId: 'thread1',
        },
      ],
    );
    const registryCreateCalls = [];
    deps.invocationDeps.registry.create = (...args) => {
      registryCreateCalls.push(args);
      return { invocationId: 'inv-queue-trigger', callbackToken: 'tok-queue-trigger' };
    };

    const yielded = [];
    for await (const msg of routeSerial(deps, ['codex'], '@缅因猫 帮忙复核', 'user1', 'thread1', {
      a2aTriggerMessageId: 'msg-trigger',
    })) {
      yielded.push(msg);
    }

    const streamAppends = appendCalls.filter((call) => call.catId === 'codex');
    assert.equal(streamAppends.length, 1, 'should persist queue-dispatched codex stream message');
    assert.equal(streamAppends[0].replyTo, 'msg-trigger', 'queue-dispatched A2A stream should persist trigger replyTo');

    const codexText = yielded.find((msg) => msg.type === 'text' && msg.catId === 'codex');
    assert.ok(codexText, 'should yield codex stream text');
    assert.equal(codexText.replyTo, 'msg-trigger', 'live stream text should carry trigger replyTo');
    assert.deepEqual(codexText.replyPreview, {
      senderCatId: 'opus',
      content: '@缅因猫 帮忙复核',
    });
    assert.equal(
      registryCreateCalls[0]?.[4],
      'msg-trigger',
      'queue trigger provenance must reach the invocation auth record for terminal ACK resolution',
    );
  });

  it('does not treat currentUserMessageId as stream replyTo without explicit A2A trigger', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deps = createMockDeps(
      {
        codex: createMockService('codex', '普通排队消息回复'),
      },
      appendCalls,
      [
        {
          id: 'msg-user',
          userId: 'user1',
          catId: null,
          content: '普通用户消息',
          mentions: ['codex'],
          timestamp: 123,
          threadId: 'thread1',
        },
      ],
    );

    const yielded = [];
    for await (const msg of routeSerial(deps, ['codex'], '普通用户消息', 'user1', 'thread1', {
      currentUserMessageId: 'msg-user',
    })) {
      yielded.push(msg);
    }

    assert.equal(appendCalls.length, 1, 'should persist normal queued stream message');
    assert.equal(appendCalls[0].replyTo, undefined, 'normal queue stream must not reply to currentUserMessageId');

    const codexText = yielded.find((msg) => msg.type === 'text' && msg.catId === 'codex');
    assert.ok(codexText, 'should yield codex stream text');
    assert.equal(codexText.replyTo, undefined, 'live stream must not carry a bogus user-message replyTo');
  });
});
