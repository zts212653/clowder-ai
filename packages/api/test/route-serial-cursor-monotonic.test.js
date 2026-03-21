import assert from 'node:assert/strict';
import { test } from 'node:test';

const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');

function createMockDeps(services) {
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
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async () => ({
        id: `msg-${counter}`,
        userId: '',
        catId: null,
        content: '',
        mentions: [],
        timestamp: 0,
      }),
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

test('routeSerial keeps newest cursor boundary when same cat re-enters in one chain', async () => {
  const cursorOld = '0000000000000001-000001-aaaaaaaa';
  const newUserMsgId = '0000000000000002-000001-bbbbbbbb';
  const streamOnlyMsgId = '0000000000000003-000001-cccccccc';

  let opusCalls = 0;
  const opusService = {
    async *invoke() {
      opusCalls += 1;
      if (opusCalls === 1) {
        yield {
          type: 'text',
          catId: 'opus',
          content: '初稿完成\n@缅因猫 请看',
          timestamp: Date.now(),
        };
      } else {
        yield {
          type: 'text',
          catId: 'opus',
          content: '收到，我来收尾',
          timestamp: Date.now(),
        };
      }
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    },
  };
  const codexService = {
    async *invoke() {
      yield {
        type: 'text',
        catId: 'codex',
        content: '给出建议\n@布偶猫 回看',
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    },
  };

  const deps = createMockDeps({ opus: opusService, codex: codexService });
  deps.deliveryCursorStore = {
    getCursor: async () => cursorOld,
    ackCursor: async () => {},
  };

  let afterCursorCalls = 0;
  deps.messageStore.getByThreadAfter = async () => {
    afterCursorCalls += 1;
    if (afterCursorCalls === 1) {
      return [
        {
          id: newUserMsgId,
          threadId: 'thread-1',
          userId: 'user-1',
          catId: null,
          content: '新用户消息',
          mentions: [],
          timestamp: Date.now(),
        },
      ];
    }
    return [
      {
        id: streamOnlyMsgId,
        threadId: 'thread-1',
        userId: 'user-1',
        catId: 'codex',
        content: 'codex stream internal',
        mentions: [],
        origin: 'stream',
        timestamp: Date.now(),
      },
    ];
  };

  const cursorBoundaries = new Map();
  for await (const _ of routeSerial(deps, ['opus'], '当前用户消息', 'user-1', 'thread-1', {
    currentUserMessageId: newUserMsgId,
    thinkingMode: 'play',
    cursorBoundaries,
  })) {
  }

  assert.equal(
    cursorBoundaries.get('opus'),
    newUserMsgId,
    'opus boundary should keep newest unseen user message instead of regressing',
  );
});
