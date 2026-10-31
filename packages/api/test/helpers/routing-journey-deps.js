import { InMemoryTurnExecutionStore } from '../../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';

export function routingJourneyDeps(preflight, observer, provider) {
  let invocation = 0;
  const messages = [];
  const deps = {
    services: { opus: provider },
    routingDispatchPreflight: preflight,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `journey-${++invocation}`, callbackToken: `token-${invocation}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3102',
      turnExecutionStore: new InMemoryTurnExecutionStore(),
      routingDispatchSignalObserver: observer,
    },
    messageStore: {
      append: async (input) => {
        const message = { ...input, id: `message-${messages.length}` };
        messages.push(message);
        return message;
      },
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getById: async (id) => messages.find((message) => message.id === id) ?? null,
      getByThread: (threadId) => messages.filter((message) => message.threadId === threadId),
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
  return { deps, messages };
}
