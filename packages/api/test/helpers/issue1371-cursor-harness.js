import { InMemoryFreshnessClosureStore } from '../../dist/domains/cats/services/freshness/closure/FreshnessClosureStore.js';
import { FreshnessOutputCommitCoordinator } from '../../dist/domains/cats/services/freshness/glass-box/FreshnessOutputCommitCoordinator.js';
import { DeliveryCursorStore } from '../../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { adaptMessageStore } from './message-from-fixtures.js';

export function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export async function cursorHarness(services, messageStore = new MessageStore()) {
  let sequence = 0;
  const canonicalMessageStore = adaptMessageStore(messageStore);
  const source = await canonicalMessageStore.append({
    userId: 'user-1',
    threadId: 'thread-cursor',
    catId: null,
    content: '@opus @codex independently answer',
    mentions: ['opus', 'codex'],
    timestamp: Date.now(),
  });
  const boundaries = new Map();
  const deliveryCursorStore = new DeliveryCursorStore();
  const deps = {
    services,
    messageStore: canonicalMessageStore,
    deliveryCursorStore,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `child-${++sequence}`, callbackToken: 'test-token' }),
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: new ThreadStore(),
      apiUrl: 'http://127.0.0.1:3102',
    },
    freshnessOutputCommitCoordinator: new FreshnessOutputCommitCoordinator({
      messageStore: canonicalMessageStore,
      closureStore: new InMemoryFreshnessClosureStore(),
    }),
    socketManager: { broadcastToRoom() {} },
  };
  const options = {
    currentUserMessageId: source.id,
    cursorBoundaries: boundaries,
    thinkingMode: 'play',
    persistenceContext: { failed: false, errors: [] },
  };
  return { deps, source, boundaries, options };
}
