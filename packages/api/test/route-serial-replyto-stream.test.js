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

  it('attaches replyTo from explicit A2A trigger route option for queue-dispatched initial target', async () => {
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

    const yielded = [];
    for await (const msg of routeSerial(deps, ['codex'], '@缅因猫 帮忙复核', 'user1', 'thread1', {
      a2aTriggerMessageId: 'msg-trigger',
    })) {
      yielded.push(msg);
    }

    assert.equal(appendCalls.length, 1, 'should persist queue-dispatched codex stream message');
    assert.equal(appendCalls[0].replyTo, 'msg-trigger', 'queue-dispatched A2A stream should persist trigger replyTo');

    const codexText = yielded.find((msg) => msg.type === 'text' && msg.catId === 'codex');
    assert.ok(codexText, 'should yield codex stream text');
    assert.equal(codexText.replyTo, 'msg-trigger', 'live stream text should carry trigger replyTo');
    assert.deepEqual(codexText.replyPreview, {
      senderCatId: 'opus',
      content: '@缅因猫 帮忙复核',
    });
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

  it('passes explicit trigger id into deferred queue dispatch when fairness gate defers text-scan A2A', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const deferred = [];
    const deps = createMockDeps(
      {
        opus: createMockService('opus', '我先看一下\n@缅因猫 帮忙复核'),
      },
      appendCalls,
    );

    const yielded = [];
    for await (const msg of routeSerial(deps, ['opus'], 'check this', 'user1', 'thread1', {
      queueHasQueuedMessages: () => true,
      deferA2AEnqueue: (entry) => deferred.push(entry),
    })) {
      yielded.push(msg);
    }

    assert.ok(yielded.find((msg) => msg.type === 'text' && msg.catId === 'opus'));
    assert.equal(deferred.length, 1, 'should enqueue deferred A2A target instead of extending worklist');
    assert.equal(deferred[0].targetCats[0], 'codex');
    assert.equal(
      deferred[0].a2aTriggerMessageId,
      'msg-1',
      'deferred queue entry should keep the stored trigger message id',
    );
  });
});
