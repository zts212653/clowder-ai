import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { appendTestLifecycleResponseSource } from './helpers/message-from-fixtures.js';

const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');

function depsFor(services) {
  let invocations = 0;
  const messageStore = new MessageStore();
  const stored = [];
  const append = messageStore.append.bind(messageStore);
  messageStore.append = (input) => {
    const row = append(input);
    stored.push(row);
    return row;
  };
  return {
    services,
    stored,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `cancel-notice-${++invocations}`, callbackToken: 'fixture-token' }),
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        consumeMentionRoutingFeedback: async () => null,
        updateParticipantActivity: async () => {},
      },
      apiUrl: 'http://127.0.0.1:3102',
    },
    messageStore,
    draftStore: { delete: async () => {}, touch: async () => {}, upsert: async () => {} },
    toolEventLog: { append: async () => {}, updateSummary: async () => {} },
    socketManager: { broadcastToRoom: () => {} },
  };
}

function toolMessages(catId) {
  return [
    {
      type: 'tool_use',
      catId,
      toolUseId: 'read-1',
      toolName: 'Read',
      toolInput: { path: 'README.md' },
      timestamp: Date.now(),
    },
    {
      type: 'tool_result',
      catId,
      toolUseId: 'read-1',
      toolName: 'Read',
      content: 'read-only workspace',
      toolResultStatus: 'ok',
      timestamp: Date.now(),
    },
  ];
}

function silentNotices(messages, catId) {
  return messages.filter((message) => {
    if (message.catId !== catId || message.type !== 'system_info' || !message.content) return false;
    try {
      return JSON.parse(message.content).type === 'silent_completion';
    } catch {
      return false;
    }
  });
}

async function collect(route, deps, catIds, threadId, tracker) {
  const batch = tracker.startAll(threadId, catIds, 'user1');
  const messages = [];
  for await (const message of route(deps, catIds, 'read this workspace', 'user1', threadId, {
    signal: batch.signal,
    onLifecycleInvocationStarted: async (input) => {
      const row = await appendTestLifecycleResponseSource(deps.messageStore, {
        ...input,
        timestamp: input.startedAt,
      });
      return {
        responseMessageId: row.id,
        priorFrontierMessageId: null,
        activeRun: {
          threadId,
          targetId: input.catId,
          invocationId: input.invocationId,
          responseMessageId: row.id,
          inputEntryIds: [],
          inputMessageIds: [],
          privateInputEntryIds: [],
          startedAt: input.startedAt,
        },
      };
    },
    signalForCat: (catId) => tracker.getController(threadId, catId)?.signal,
  }))
    messages.push(message);
  return messages;
}

for (const [name, route] of [
  ['serial', routeSerial],
  ['parallel', routeParallel],
]) {
  describe(`${name}: cancellation is not silent successful completion`, () => {
    for (const hadTools of [false, true]) {
      test(`Stop after ${hadTools ? 'a completed tool' : 'a buffered start'} emits no completion notice and preserves siblings`, async () => {
        const tracker = new InvocationTracker();
        const threadId = `cancel-notice-${name}-${hadTools}`;
        let stopped = false;
        const deps = depsFor({
          opus: {
            async *invoke() {
              if (hadTools) yield* toolMessages('opus');
              await new Promise(setImmediate);
              tracker.cancel(threadId, 'opus', 'user1', 'user_cancel');
              stopped = true;
              // Like AGY, the terminal only becomes available after cleanup. The host
              // must keep its late-output suppression without diagnosing this as success.
              await new Promise(setImmediate);
              yield { type: 'done', catId: 'opus', errorCode: 'AGY_CANCELLED', timestamp: Date.now() };
            },
          },
          codex: {
            async *invoke() {
              yield { type: 'text', catId: 'codex', content: 'Sibling finished.', timestamp: Date.now() };
              yield { type: 'done', catId: 'codex', timestamp: Date.now() };
            },
          },
        });
        const messages = await collect(route, deps, ['opus', 'codex'], threadId, tracker);
        assert.equal(stopped, true, 'exercise Stop during the running service');
        const stoppedResponse = deps.stored
          .map((row) => deps.messageStore.getById(row.id))
          .find((row) => row.lifecycle?.kind === 'response' && row.lifecycle.targetId === 'opus');
        assert.equal(stoppedResponse?.lifecycle?.status, 'canceled', 'Stop closes the exact admitted response');
        assert.equal(silentNotices(messages, 'opus').length, 0, 'canceled turn must never say completed without text');
        assert.equal(
          messages.some((message) => message.catId === 'opus' && message.type === 'error'),
          false,
          'user Stop must not become a provider error bubble',
        );
        assert.ok(
          messages.some((message) => message.catId === 'codex' && message.content === 'Sibling finished.'),
          'per-cat cancellation must preserve the sibling',
        );
        assert.ok(
          deps.stored
            .map((row) => deps.messageStore.getById(row.id))
            .some((message) => message.catId === 'codex' && message.content === 'Sibling finished.'),
          'sibling result remains durable',
        );
        if (hadTools)
          assert.ok(
            deps.stored
              .map((row) => deps.messageStore.getById(row.id))
              .some((message) => message.catId === 'opus' && message.toolEvents?.length),
            'completed pre-cancel tool evidence remains durable',
          );
      });
    }

    for (const hadTools of [false, true]) {
      test(`natural ${hadTools ? 'tool-only' : 'empty'} completion retains its diagnostic`, async () => {
        const tracker = new InvocationTracker();
        const deps = depsFor({
          opus: {
            async *invoke() {
              if (hadTools) yield* toolMessages('opus');
              yield { type: 'done', catId: 'opus', timestamp: Date.now() };
            },
          },
        });
        const messages = await collect(route, deps, ['opus'], `natural-notice-${name}-${hadTools}`, tracker);
        assert.equal(
          silentNotices(messages, 'opus').length,
          0,
          'the terminal response replaces a separate silent-completion notice',
        );
        const response = deps.stored
          .map((row) => deps.messageStore.getById(row.id))
          .find((row) => row.lifecycle?.kind === 'response');
        assert.equal(
          response?.lifecycle?.status,
          'completed',
          'natural completion remains visible on its fixed response',
        );
        if (hadTools) assert.ok(response.toolEvents?.length, 'tool-only completion retains its audit evidence');
      });
    }
  });
}
