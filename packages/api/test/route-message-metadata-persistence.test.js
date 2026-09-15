import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const OPENAI_METADATA = {
  provider: 'openai',
  model: 'gpt-6-astra',
};

const APP_SERVER_DIAGNOSTICS = {
  appServerLifecycle: {
    stage: 'child_spawned',
    lastActivityAt: 1_788_617_379_563,
  },
};

const TERMINAL_USAGE = {
  inputTokens: 203_338,
  outputTokens: 171,
  cacheReadTokens: 202_624,
};

function createDeferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createHydratingMessageStore() {
  let sequence = 0;
  const stored = [];
  const clone = (value) => structuredClone(value);

  return {
    append: async (input) => {
      const message = clone({
        id: `message-${++sequence}`,
        ...input,
        threadId: input.threadId ?? 'default',
      });
      stored.push(message);
      return clone(message);
    },
    getById: async (id) => clone(stored.find((message) => message.id === id) ?? null),
    getRecent: () => clone(stored),
    getMentionsFor: () => [],
    getRecentMentionsFor: () => [],
    getBefore: () => [],
    getByThread: (threadId) => clone(stored.filter((message) => message.threadId === threadId)),
    getByThreadAfter: () => [],
    getByThreadBefore: () => [],
  };
}

function createRouteDeps(services, messageStore, { parallel = false } = {}) {
  let invocationSequence = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({
          invocationId: `invocation-${++invocationSequence}`,
          callbackToken: `token-${invocationSequence}`,
        }),
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: parallel
        ? {
            get: async () => null,
            getParticipantsWithActivity: async () => [],
            updateParticipantActivity: async () => {},
          }
        : null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore,
    draftStore: {
      delete: () => Promise.resolve(),
      touch: () => Promise.resolve(),
      upsert: () => Promise.resolve(),
    },
    socketManager: {
      broadcastToRoom: () => {},
    },
  };
}

function createMetadataService(catId, options = {}) {
  return {
    async *invoke() {
      yield {
        type: 'status',
        catId,
        content: 'Codex app-server 已启动',
        metadata: { ...OPENAI_METADATA, diagnostics: APP_SERVER_DIAGNOSTICS },
        timestamp: Date.now(),
      };
      if (options.pause) {
        options.pause.entered.resolve();
        await options.pause.resume.promise;
      }
      yield { type: 'text', catId, content: `${catId} answer`, timestamp: Date.now() };
      yield {
        type: 'done',
        catId,
        metadata: { ...OPENAI_METADATA, usage: TERMINAL_USAGE },
        timestamp: Date.now(),
      };
    },
  };
}

function assertHydratedMetadata(message) {
  assert.deepEqual(message.metadata?.diagnostics, APP_SERVER_DIAGNOSTICS);
  assert.deepEqual(message.metadata?.usage, TERMINAL_USAGE);
  assert.equal(
    message.metadata?.usage?.costUsd,
    undefined,
    'Codex usage must not invent cost without provider truth or verified pricing provenance',
  );
}

describe('F306 OpenAI usage metadata persistence', () => {
  it('serial hydration retains lifecycle diagnostics and terminal usage after a suspended turn resumes', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const pause = { entered: createDeferred(), resume: createDeferred() };
    const messageStore = createHydratingMessageStore();
    const deps = createRouteDeps({ opus: createMetadataService('opus', { pause }) }, messageStore);

    const run = (async () => {
      for await (const _message of routeSerial(deps, ['opus'], 'work', 'user-1', 'thread-serial')) {
        // Drain through the same suspended invocation after the owner answer resumes it.
      }
    })();

    await pause.entered.promise;
    assert.equal(messageStore.getByThread('thread-serial').length, 0, 'no partial message is persisted while waiting');
    pause.resume.resolve();
    await run;

    const hydrated = messageStore.getByThread('thread-serial');
    assert.equal(hydrated.length, 1);
    assertHydratedMetadata(hydrated[0]);
  });

  it('parallel hydration retains the same lifecycle and terminal usage semantics', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const messageStore = createHydratingMessageStore();
    const deps = createRouteDeps(
      {
        opus: createMetadataService('opus'),
        kimi: createMetadataService('kimi'),
      },
      messageStore,
      { parallel: true },
    );

    for await (const _message of routeParallel(deps, ['opus', 'kimi'], 'compare', 'user-1', 'thread-parallel')) {
      // Drain both providers.
    }

    const hydrated = messageStore.getByThread('thread-parallel');
    assert.equal(hydrated.length, 2);
    for (const message of hydrated) assertHydratedMetadata(message);
  });
});
