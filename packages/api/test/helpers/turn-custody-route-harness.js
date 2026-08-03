import { catRegistry } from '@cat-cafe/shared';

function createSequenceService(texts) {
  let callCount = 0;
  return {
    async *invoke() {
      const content = texts[Math.min(callCount, texts.length - 1)] ?? '';
      callCount += 1;
      yield {
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({ type: 'invocation_created', invocationId: `provider-inv-${callCount}` }),
        timestamp: Date.now(),
      };
      yield { type: 'text', catId: 'codex', content, timestamp: Date.now() };
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, triggerMessage, projection) {
  let sequence = 0;
  let projectionOpenCount = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `outer-inv-${++sequence}`, callbackToken: `tok-${sequence}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        get: async () => null,
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (message) => ({
        id: `stored-${++sequence}`,
        userId: message.userId ?? '',
        catId: message.catId ?? null,
        content: message.content ?? '',
        mentions: message.mentions ?? [],
        timestamp: message.timestamp ?? 0,
        source: message.source,
        origin: message.origin,
        mentionsUser: message.mentionsUser,
        toolEvents: message.toolEvents,
        extra: message.extra,
      }),
      getById: async (messageId) => (messageId === triggerMessage.id ? triggerMessage : null),
      getRecent: async () => [],
      getMentionsFor: async () => [],
      getBefore: async () => [],
      getByThread: async () => [],
      getByThreadAfter: async () => [],
      getByThreadBefore: async () => [],
      augmentStreamMetadata: async () => true,
    },
    draftStore: {
      upsert: () => {},
      touch: () => {},
      delete: async () => {},
      deleteByThread: () => {},
      getByThread: () => [],
    },
    socketManager: { broadcastToRoom: () => {} },
    turnCustodyProjectionService: {
      async open() {
        projectionOpenCount += 1;
        if (projectionOpenCount > 1) return undefined;
        return { state: projection.state, evidenceRefs: projection.evidenceRefs };
      },
      async close() {
        return projection;
      },
    },
  };
}

export async function runTurnCustodyRoute({ output, triggerMessage, wake, projection }) {
  const original = catRegistry.getAllConfigs();
  const { loadCatConfig, toAllCatConfigs } = await import('../../dist/config/cat-config-loader.js');
  const { routeSerial } = await import('../../dist/domains/cats/services/agents/routing/route-serial.js');
  catRegistry.reset();
  for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig()))) {
    catRegistry.register(id, config);
  }
  try {
    const services = {
      codex: createSequenceService(output),
      opus: createSequenceService(['@co-creator']),
    };
    const deps = createMockDeps(services, triggerMessage, projection);
    for await (const _message of routeSerial(
      deps,
      ['codex'],
      'turn custody evidence test',
      'user1',
      triggerMessage.threadId,
      {
        currentUserMessageId: triggerMessage.id,
        invocationController: new AbortController(),
        trackA2ASlot: () => true,
        completeA2ASlots: () => {},
        turnCustodyWake: wake,
      },
    )) {
      // Exhaust the real route so its pending Phase T close emits evidence.
    }
  } finally {
    catRegistry.reset();
    for (const [id, config] of Object.entries(original)) {
      catRegistry.register(id, config);
    }
  }
}

export function turnCustodyTriggerMessage(id, threadId, effectClass) {
  return {
    id,
    threadId,
    catId: 'opus',
    content: 'typed trigger',
    extra: {
      crossPost: {
        sourceThreadId: `source-${threadId}`,
        ...(effectClass ? { effectClass } : {}),
      },
    },
  };
}
