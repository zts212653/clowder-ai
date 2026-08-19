import assert from 'node:assert/strict';
import { test } from 'node:test';

const CAT = 'opus';

function createClaudeEventService(transformClaudeEvent) {
  return {
    async *invoke() {
      const state = {
        currentMessageId: undefined,
        partialTextMessageIds: new Set(),
        lastTurnInputTokens: undefined,
        thinkingBuffer: '',
      };
      const events = [
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg-1272-route' } } },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '持久化正文。' } },
        },
        {
          type: 'assistant',
          message: {
            id: 'msg-1272-route',
            content: [{ type: 'thinking', thinking: 'thinking snapshot' }],
          },
        },
        {
          type: 'assistant',
          message: {
            id: 'msg-1272-route',
            content: [{ type: 'text', text: '持久化正文。' }],
          },
        },
        { type: 'result', subtype: 'success' },
      ];
      for (const event of events) {
        const result = transformClaudeEvent(event, CAT, state);
        if (result === null) continue;
        for (const msg of Array.isArray(result) ? result : [result]) yield msg;
      }
      yield { type: 'done', catId: CAT, timestamp: Date.now() };
    },
  };
}

function createMockDeps(service, appendCalls) {
  let messageSeq = 0;
  const storedById = new Map();
  return {
    services: { [CAT]: service },
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: 'inv-1272-claude', callbackToken: 'tok-1272-claude' }),
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
      append: async (input) => {
        const stored = { id: `msg-${++messageSeq}`, ...input, threadId: input.threadId ?? 'thread-1272' };
        appendCalls.push(input);
        storedById.set(stored.id, stored);
        return stored;
      },
      getById: async (id) => storedById.get(id) ?? null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
    },
  };
}

test('#1272: Claude live final text and refreshed persisted message contain one streamed body', async () => {
  const { transformClaudeEvent } = await import(
    '../dist/domains/cats/services/agents/providers/claude-ndjson-parser.js'
  );
  const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
  const appendCalls = [];
  const deps = createMockDeps(createClaudeEventService(transformClaudeEvent), appendCalls);

  const yielded = [];
  for await (const msg of routeSerial(deps, [CAT], '排查重复回复', 'user-1272', 'thread-1272')) {
    yielded.push(msg);
  }

  assert.equal(appendCalls.length, 1, 'route persists one cat message');
  assert.equal(appendCalls[0].content, '持久化正文。');

  const liveText = yielded
    .filter((msg) => msg.type === 'text' && msg.catId === CAT)
    .map((msg) => msg.content)
    .join('');
  assert.equal(liveText, '持久化正文。', 'live accumulated text contains no final-snapshot replay');

  const refreshed = await deps.messageStore.getById('msg-1');
  assert.equal(refreshed?.content, '持久化正文。', 'F5/read path returns exactly the stored parser output');
});
