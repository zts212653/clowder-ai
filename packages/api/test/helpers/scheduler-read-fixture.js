import assert from 'node:assert/strict';
import Fastify from 'fastify';
import './setup-cat-registry.js';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { PersistedQueueDelivery } from '../../dist/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { createDeliverFn } from '../../dist/infrastructure/scheduler/delivery.js';
import { reportAlphaFailures } from '../../dist/infrastructure/scheduler/templates/alpha-browser-reporting.js';
import { notifyAlphaRepair } from '../../dist/infrastructure/scheduler/templates/alpha-repair-notification.js';
import { callbacksRoutes } from '../../dist/routes/callbacks.js';
import { fixture as alphaFixture } from './alpha-browser-template-fixture.js';

export const OWNER = 'scheduler-read-owner';
export const CAT = 'opus';

/** Real publishers, Queue admission, stores and callback authentication; no native execution or inference. */
export async function schedulerReadFixture(t) {
  const messages = new MessageStore(),
    threads = new ThreadStore(),
    tasks = new TaskStore();
  const thread = threads.create(OWNER, 'Scheduler source');
  const caller = threads.create(OWNER, 'Exact-read caller');
  const registry = new InvocationRegistry(),
    queue = new InvocationQueue();
  const stats = { reads: 0, adoptions: 0 };
  const delivery = new PersistedQueueDelivery({ messages, queue, progress: async () => 'owned_deferred_busy' });
  const deliver = createDeliverFn({
    messageStore: messages,
    persistedQueueDelivery: delivery,
    socketManager: { broadcastToRoom() {}, emitToUser() {} },
  });
  const answer = messages.append({
    from: { kind: 'user', userId: OWNER },
    userId: OWNER,
    threadId: thread.id,
    content: 'The piano was discussed earlier.',
    mentions: [],
    timestamp: Date.now() - 1000,
  });
  let duringSearch = () => {};
  const evidenceStore = {
    search: async () => [],
    getByAnchor: async () => null,
    readMessagePassageState: () => ({ current: true, suppressThreadTitle: false }),
    searchMessagePassages: async () => {
      stats.reads++;
      await duringSearch();
      return {
        passages: [
          {
            docAnchor: `thread-${thread.id}`,
            passageId: `msg-${answer.id}`,
            threadId: thread.id,
            messageId: answer.id,
            content: answer.content,
            match: 'lexical',
          },
        ],
        meta: { effectiveMode: 'lexical', candidateLimit: 2000, truncated: false, freshness: 'unknown' },
      };
    },
  };
  const app = Fastify();
  t.after(() => app.close());
  await app.register(callbacksRoutes, {
    registry,
    messageStore: messages,
    threadStore: threads,
    invocationQueue: queue,
    evidenceStore,
    queueProcessor: {
      adoptExposedQueuedEntries: async () => {
        stats.adoptions++;
        return { outcome: 'rejected' };
      },
    },
    socketManager: { broadcastAgentMessage() {}, getMessages: () => [] },
    reflectionService: { reflect: async () => '' },
    markerQueue: { submit: async () => ({}), list: async () => [], transition: async () => {} },
  });
  async function auth(source, user = OWNER, cat = CAT) {
    const invocation = await registry.create(
      user,
      cat,
      source?.threadId ?? caller.id,
      undefined,
      undefined,
      undefined,
      source?.id,
    );
    return { 'x-invocation-id': invocation.invocationId, 'x-callback-token': invocation.callbackToken };
  }
  const readHeaders = await auth();
  async function publish(producer = 'repair', dispatched = true) {
    const options = { ownerUserId: OWNER, messages, queue, tasks };
    if (producer === 'repair') {
      const task = tasks.create({
        threadId: thread.id,
        userId: OWNER,
        createdBy: 'system',
        title: 'Synthetic Alpha repair',
        ownerCatId: CAT,
      });
      await notifyAlphaRepair(options, { deliver }, task, CAT);
    } else {
      const f = alphaFixture(),
        drafts = await f.runtime.alphaBrowserFailureTasks();
      await reportAlphaFailures(
        { ...f.options, ...options, resolveCat: (id) => (id === CAT ? id : null) },
        { alphaBrowserFailureTasks: async () => drafts.map((d) => ({ ...d, ownerCatId: CAT })) },
        'synthetic-subscription',
        thread.id,
        CAT,
        { deliver },
        {},
      );
    }
    const entry = queue.list(thread.id, OWNER).at(-1);
    assert.ok(entry?.payload?.messageId, 'the actual producer admitted a durable conversation input');
    const message = messages.getById(entry.payload.messageId);
    if (dispatched) {
      dispatch(message);
      await queue.terminalizeEntryDurable(thread.id, OWNER, entry.id);
    }
    return messages.getById(message.id);
  }
  function dispatch(message) {
    const response = messages.append({
      from: { kind: 'agent', catId: CAT },
      userId: OWNER,
      threadId: message.threadId,
      content: 'Synthetic native response',
      mentions: [],
      timestamp: Date.now(),
    });
    const result = messages.advanceLifecycleInputDispatch(message.id, {
      orderKey: message.lifecycle.orderKey,
      targetId: CAT,
      phase: 'dispatched',
      statusMessageId: response.id,
      dispatchedAt: Date.now(),
    });
    assert.equal(result.kind, 'applied');
    messages.markDelivered(message.id, Date.now());
  }
  const read = (message, mode = 'full', extra = '') =>
    app.inject({
      url: `/api/callbacks/get-message?messageId=${message.id}&mode=${mode}${extra}`,
      headers: readHeaders,
    });
  const search = (headers, extra = '') =>
    app.inject({ headers, url: `/api/callbacks/search-evidence?q=piano&resultUnit=message&mode=lexical${extra}` });
  return {
    app,
    messages,
    threads,
    tasks,
    thread,
    caller,
    registry,
    queue,
    stats,
    answer,
    publish,
    dispatch,
    auth,
    read,
    search,
    setDuringSearch: (f) => {
      duringSearch = f;
    },
  };
}
