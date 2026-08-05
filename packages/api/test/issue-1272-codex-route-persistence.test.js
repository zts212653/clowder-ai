import assert from 'node:assert/strict';
import { test } from 'node:test';

const CAT = 'codex';

function createCodexEventService(transformCodexEvent, finalizeCodexStream) {
  return {
    async *invoke() {
      const state = {
        hadPriorTextTurn: false,
        signatureIdentity: '砚砚',
        canonicalSignature: '[砚砚/gpt-5.6-sol🐾]',
      };
      const events = [
        ...Array.from({ length: 16 }, (_, index) => ({
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: `第 ${index + 1} 段不同进度。 \`[砚砚/gpt-5.6-sol🐾]\``,
          },
        })),
        { type: 'turn.completed', usage: {} },
      ];
      for (const event of events) {
        const result = transformCodexEvent(event, CAT, state);
        if (result === null) continue;
        for (const msg of Array.isArray(result) ? result : [result]) yield msg;
      }
      const finalSignature = finalizeCodexStream(state, CAT);
      if (finalSignature) yield finalSignature;
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
        create: () => ({ invocationId: 'inv-1272-codex', callbackToken: 'tok-1272-codex' }),
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

test('#1272: Codex live final text and refreshed persisted message contain one signature', async () => {
  const { finalizeCodexStream, transformCodexEvent } = await import(
    '../dist/domains/cats/services/agents/providers/codex-event-transform.js'
  );
  const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
  const appendCalls = [];
  const deps = createMockDeps(createCodexEventService(transformCodexEvent, finalizeCodexStream), appendCalls);

  const yielded = [];
  for await (const msg of routeSerial(deps, [CAT], '排查重复回复', 'user-1272', 'thread-1272')) {
    yielded.push(msg);
  }

  assert.equal(appendCalls.length, 1, 'route persists one cat message');
  const expected = `${Array.from({ length: 16 }, (_, index) => `第 ${index + 1} 段不同进度。`).join(
    '\n\n',
  )}\n\n[砚砚/gpt-5.6-sol🐾]`;
  assert.equal(appendCalls[0].content, expected);

  const liveText = yielded
    .filter((msg) => msg.type === 'text' && msg.catId === CAT)
    .map((msg) => msg.content)
    .join('');
  assert.equal(liveText, expected, 'live accumulated content matches the finalized message');

  const refreshed = await deps.messageStore.getById('msg-1');
  assert.equal(refreshed?.content, expected, 'F5/read path returns exactly the stored finalized content');
});
