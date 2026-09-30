/**
 * F202 W2-3 h3c-2 — both cloud return entries (the Remote MCP callback and the polled ingest) over
 * one message store and one grant store, with the cloud cat configured under any id.
 *
 * Each store can be paused at the step where the two entries could interleave — the append, and the
 * grant commit after it — so a race is driven through a chosen order instead of left to timing.
 */
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { AgentKeyRegistry } from '../../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { CloudAssistantReturnIngestService } from '../../dist/domains/cats/services/cloud-bridge/cloud-assistant-return-ingest.js';
import { MemoryCloudReturnGrantStore } from '../../dist/domains/cats/services/cloud-bridge/cloud-return-grant.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';

const TEMPLATE = catRegistry.getAllConfigs();
const CLOUD_CONFIG = TEMPLATE['gpt-pro'];

/**
 * The template's cats, with the cloud cat's configuration moved to the given ids (or none); `extra`
 * adds cats or replaces template ones.
 */
export function configureCats(cloudCatIds, extra = {}) {
  catRegistry.reset();
  for (const [catId, config] of Object.entries(TEMPLATE)) {
    if (catId !== 'gpt-pro' && !cloudCatIds.includes(catId) && !Object.hasOwn(extra, catId)) {
      catRegistry.register(catId, config);
    }
  }
  for (const catId of cloudCatIds) catRegistry.register(catId, { ...CLOUD_CONFIG, id: catId });
  for (const [catId, config] of Object.entries(extra)) catRegistry.register(catId, config);
}

export { CLOUD_CONFIG };

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Wraps `target` so the next call of `method` announces itself and waits until released.
 * `pause()` returns `{ reached, release }`; nothing pauses unless armed.
 */
function pausable(target, method) {
  let armed;
  const proxy = new Proxy(target, {
    get(object, property) {
      if (property === method) {
        return async (...args) => {
          const gate = armed;
          armed = undefined;
          if (gate) {
            gate.reached.resolve();
            await gate.released.promise;
          }
          return object[method](...args);
        };
      }
      const value = Reflect.get(object, property, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
  const pause = () => {
    armed = { reached: deferred(), released: deferred() };
    const gate = armed;
    // A path that never gets to the paused step fails the test rather than hanging it.
    const reached = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} was never reached`)), 5_000);
      gate.reached.promise.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return { reached, release: () => gate.released.resolve() };
  };
  return { proxy, pause };
}

export async function cloudReturnHarness() {
  process.env.DEFAULT_OWNER_USER_ID = 'alice';
  const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');
  const messages = pausable(new MessageStore(), 'appendIdempotent');
  const grants = pausable(new MemoryCloudReturnGrantStore(Date.now, { historyBoundary: 0 }), 'commit');
  const messageStore = messages.proxy;
  const grantStore = grants.proxy;
  const agentKeyRegistry = new AgentKeyRegistry({ ttlMs: 86_400_000 });
  // `onNextThreadRead(fn)` runs fn when a route next reads a thread — after authentication, before
  // the route decides anything — so a configuration change can land exactly in that gap.
  let beforeThreadRead;
  const threadStore = new Proxy(new ThreadStore(), {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (property !== 'get' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(object) : value;
      }
      return async (...args) => {
        const hook = beforeThreadRead;
        beforeThreadRead = undefined;
        hook?.();
        return value.apply(object, args);
      };
    },
  });
  const thread = await threadStore.create('alice', 'h3c-2 cloud return');
  const otherThread = await threadStore.create('alice', 'h3c-2 other thread');
  let clock = 1_000;
  const append = (content, threadId = thread.id) =>
    messageStore.append({ userId: 'alice', catId: 'codex', threadId, content, mentions: [], timestamp: clock++ });
  const source = append('look at this');
  const unGranted = append('no grant for this one');
  const scope = (targetCatId, sourceMessageId = source.id, threadId = thread.id) => ({
    threadId,
    userId: 'alice',
    sourceMessageId,
    targetCatId,
  });
  const grant = (targetCatId, sourceMessageId = source.id, threadId = thread.id) =>
    grantStore.issue({ ...scope(targetCatId, sourceMessageId, threadId), dispatchInvocationId: 'inv' });
  const broadcasts = [];
  const socketManager = { broadcastAgentMessage: (message, threadId) => broadcasts.push({ message, threadId }) };
  const warnings = [];
  const ingestService = new CloudAssistantReturnIngestService({
    messageStore,
    grantStore,
    socketManager,
    logger: { error() {}, warn: (context, message) => warnings.push({ context, message }) },
    cats: catRegistry,
  });
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry: new InvocationRegistry(),
    agentKeyRegistry,
    cloudReturnGrantStore: grantStore,
    messageStore,
    threadStore,
    socketManager,
  });
  const post = (secret, payload) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: { threadId: thread.id, ...payload },
    });
  const get = (secret, url) => app.inject({ method: 'GET', url, headers: { 'x-agent-key-secret': secret } });
  const ingest = (sourceMessageId, content) => ingestService.ingest({ provider: 'chatgpt', sourceMessageId, content });
  const repliesTo = async (sourceMessageId) =>
    (await messageStore.getByThread(thread.id)).filter((message) => message.replyTo === sourceMessageId);
  const posted = async (content) =>
    (await messageStore.getByThread(thread.id)).filter((message) => message.content === content);
  return {
    app,
    agentKeyRegistry,
    messageStore,
    grantStore,
    thread,
    otherThread,
    source,
    unGranted,
    append,
    scope,
    grant,
    post,
    get,
    probe: (secret) => get(secret, '/api/callbacks/auth-probe'),
    readContext: (secret) => get(secret, `/api/callbacks/thread-context?threadId=${thread.id}`),
    ingest,
    repliesTo,
    posted,
    broadcasts,
    warnings,
    pauseAppend: messages.pause,
    pauseCommit: grants.pause,
    onNextThreadRead: (hook) => {
      beforeThreadRead = hook;
    },
  };
}
