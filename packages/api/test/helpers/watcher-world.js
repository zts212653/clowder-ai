import { CallbackAuthTurnExecutionLifecycle } from '../../dist/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionLifecycle.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { routeParallel } from '../../dist/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../../dist/domains/cats/services/agents/routing/route-serial.js';
import { InMemoryTurnExecutionStore } from '../../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { DraftStore } from '../../dist/domains/cats/services/stores/ports/DraftStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { SessionChainStore } from '../../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';

export async function watcherWorld() {
  const registry = new InvocationRegistry();
  const executions = new CallbackAuthTurnExecutionLifecycle(new InMemoryTurnExecutionStore(), registry);
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const thread = await threads.create('watcher-owner');
  const sessions = new SessionChainStore();
  const deps = {
    services: {},
    messageStore: messages,
    draftStore: new DraftStore(),
    invocationDeps: {
      registry,
      turnExecutionStore: executions,
      threadStore: threads,
      sessionManager: { get: async () => null, getOrCreate: async () => ({}), resolveWorkingDirectory: () => '/tmp' },
      apiUrl: 'http://127.0.0.1:3102',
    },
  };
  async function work(
    text,
    { route = 'serial', targets = ['codex'], observe, failure, cancel, currentUserMessageId } = {},
  ) {
    const prior = await executions.settledHead('watcher-owner', thread.id);
    const abort = new AbortController();
    for (const catId of targets)
      deps.services[catId] = {
        async *invoke() {
          if (observe) await observe(catId);
          if (text) yield { type: 'text', catId, content: text, timestamp: Date.now() };
          if (cancel) {
            abort.abort(new DOMException('fixture cancellation', 'AbortError'));
            throw abort.signal.reason;
          }
          if (failure) throw failure;
          yield { type: 'done', catId, timestamp: Date.now() };
        },
      };
    for await (const _event of (route === 'parallel' ? routeParallel : routeSerial)(
      deps,
      targets,
      text || 'tool-only',
      'watcher-owner',
      thread.id,
      {
        parentInvocationId: `parent-${crypto.randomUUID()}`,
        ownerAuthProvenance: 'strict',
        signal: abort.signal,
        ...(currentUserMessageId ? { currentUserMessageId } : {}),
      },
    )) {
      /* drain the real route */
    }
    return (await executions.listSettled({ userId: 'watcher-owner', threadId: thread.id, afterSequence: prior }))
      .records;
  }
  return { registry, executions, messages, sessions, threads, thread, deps, work };
}
