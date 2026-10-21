/** Actual ingress, conversation admission and outbound subscription; external provider IO is a fixture. */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { AgentRegistry } from '../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { createPluginConversationDelivery } from '../dist/domains/plugin/host-surface/plugin-conversation-delivery.js';

let messaging;
let messageStore;
let delivery;
let loadedModules;
let wakes;
let outboundCalls;
let publishFailures;

const CONNECTOR = 'feishu';
const CONVERSATION = 'oc_group_1';
/** The thread a package falls back to when bound to nothing — derived from its own identity. */
let FIXED_THREAD;
const RELAY_PACKAGE = 'connector:feishu';
const FRONT_DESK = 'inst-front-desk';
const DEFAULT_CAT = 'opus';

beforeEach(async () => {
  const [messagingService, factory, publishing, subscriptionDelivery, moduleInvocation, storePort] = await Promise.all([
    import('../dist/domains/messaging/messaging-service.js'),
    import('../dist/domains/messaging/stores/factory.js'),
    import('../dist/domains/messaging/publishing-message-store.js'),
    import('../dist/domains/messaging/subscription-delivery.js'),
    import('../dist/domains/plugin/builtin-runtime/carriers/module-host-invocation.js'),
    import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
  ]);

  wakes = [];
  outboundCalls = [];
  publishFailures = [];
  loadedModules = new Map();
  const stores = factory.createMessagingStores();

  messageStore = publishing.createPublishingMessageStore(new storePort.MessageStore(), {
    events: stores.events,
    onPublishFailure: (error, stored) => publishFailures.push({ error, stored }),
  });

  const threadStore = new ThreadStore();
  FIXED_THREAD = threadStore.create('user-1', 'IM conversation').id;
  const agentRegistry = new AgentRegistry();
  for (const catId of ['opus', 'codex'])
    agentRegistry.register(catId, {
      async *invoke() {
        throw Error('no model IO');
      },
    });
  const router = new AgentRouter({ agentRegistry, registry: new InvocationRegistry(), messageStore, threadStore });
  const queue = new InvocationQueue(undefined, { resolveTargets: (...args) => router.resolveSendTargets(...args) });
  const ingress = createPluginConversationDelivery({ messageStore, queue, router });

  messaging = messagingService.createMessagingDomain({
    messageStore,
    stores,
    invokeTrigger: {
      async trigger(threadId, catId, userId, message, messageId) {
        const result = await ingress.trigger(threadId, catId, userId, message, messageId);
        const entry = queue.list(threadId, userId).find((row) => row.payload.sourceRecordId === messageId);
        wakes.push({ threadId, catId: entry.targets[0], userId, message, messageId });
        return result;
      },
    },
  });

  const invocation = moduleInvocation.createModuleHostInvocation({
    runtime: { actions: (id) => loadedModules.get(id) },
  });
  delivery = subscriptionDelivery.createSubscriptionDelivery({
    messaging,
    presentation: async (threadId, actor) => ({
      actor: { displayName: actor.id, emoji: '🐱' },
      thread: { shortId: threadId },
    }),
    delivery: {
      deliver: (targetId, input) => invocation.invoke(targetId, 'host.messaging.deliver', input),
    },
  });
});

function loadPackage(instanceId, methodName) {
  loadedModules.set(instanceId, {
    async 'host.messaging.deliver'(input) {
      outboundCalls.push({ instanceId, method: methodName, envelope: input.envelope });
      return { deliveryId: input.deliveryId };
    },
  });
}

/** What activation hands a relaying package: an address carrying relayed-human authority. */
async function relayAddress() {
  const { handleId } = await messaging.issueConnectorBindingHandle({
    pluginInstanceId: RELAY_PACKAGE,
    threadId: FIXED_THREAD,
    userId: 'user-1',
    scope: { canSend: true, canSubscribe: false },
    connectorId: CONNECTOR,
    externalChatId: CONVERSATION,
  });
  return handleId;
}

/** The package relaying one external message inward — an ordinary send, nothing Host-side. */
async function relayInbound(text, providerMessageId = 'om_1') {
  const handle = await relayAddress();
  return messaging.send(
    { pluginInstanceId: RELAY_PACKAGE },
    {
      address: { kind: 'connector_binding', handle },
      idempotencyKey: providerMessageId,
      payload: {
        provenance: {
          epistemicStatus: 'user_intent',
          origin: {
            kind: 'external',
            connectorId: CONNECTOR,
            sourceAddress: { connectorId: CONNECTOR, chatId: CONVERSATION, messageId: providerMessageId },
          },
        },
        elements: [{ elementId: 'el-1', kind: 'text', payload: { text } }],
      },
    },
  );
}

async function subscribe(instanceId, filter) {
  const { handleId } = await messaging.issueThreadHandle({
    pluginInstanceId: instanceId,
    threadId: FIXED_THREAD,
    userId: 'user-1',
    scope: { canSend: false, canSubscribe: true },
  });
  await delivery.register({
    subscriberId: instanceId,
    threadId: FIXED_THREAD,
    handleId,
    ...(filter === undefined ? {} : { filter }),
  });
}

async function catReplies(text) {
  await messageStore.append({
    from: { kind: 'agent', catId: DEFAULT_CAT },
    threadId: FIXED_THREAD,
    userId: 'user-1',

    content: text,
    timestamp: Date.now(),
  });
}

describe('F202 C1 — a package relays inward, a cat replies outward', () => {
  test('case 1: a relayed human mention wakes a cat and the reply reaches the package', async () => {
    await relayInbound('@opus 看一下');

    assert.equal(wakes.length, 1, 'a relayed human mention must wake a cat');
    assert.equal(wakes[0].catId, DEFAULT_CAT);
    assert.equal(wakes[0].threadId, FIXED_THREAD);

    loadPackage(RELAY_PACKAGE, 'outbound');
    await subscribe(RELAY_PACKAGE);

    await catReplies('看完了');
    await delivery.drain(FIXED_THREAD);

    assert.equal(outboundCalls.length, 1, "the cat's reply must reach the relaying package");
    assert.equal(outboundCalls[0].envelope.payload.elements[0].payload.text, '看完了');
    assert.deepEqual(publishFailures, []);
  });

  test('case 2: a package declaring nothing is still not handed back its own message', async () => {
    // Subscribing BEFORE the inbound arrives is load-bearing: a subscription starts at the
    // current head, so registering afterwards would skip it for the wrong reason.
    loadPackage(RELAY_PACKAGE, 'outbound');
    await subscribe(RELAY_PACKAGE);

    await relayInbound('hi');
    await delivery.drain(FIXED_THREAD);

    assert.deepEqual(outboundCalls, [], 'echoing it back would loop on a real platform');

    await catReplies('好的');
    await delivery.drain(FIXED_THREAD);
    assert.equal(outboundCalls.length, 1, 'suppressing the echo must not suppress the reply');
  });

  test('case 3: a second, unrelated subscriber gets the same reply', async () => {
    await relayInbound('hi');
    loadPackage(FRONT_DESK, 'deliver');
    await subscribe(FRONT_DESK);

    await catReplies('好的');
    await delivery.drain(FIXED_THREAD);

    const forFrontDesk = outboundCalls.filter((call) => call.instanceId === FRONT_DESK);
    assert.equal(forFrontDesk.length, 1, 'a front-desk package is the identical path');
    assert.equal(forFrontDesk[0].method, 'deliver');
  });

  test('case 4: a subscriber that deliberately asks for its own echo receives it', async () => {
    loadPackage(RELAY_PACKAGE, 'outbound');
    await subscribe(RELAY_PACKAGE, { includeOwnMessages: true });

    await relayInbound('hi');
    await delivery.drain(FIXED_THREAD);

    assert.equal(outboundCalls.length, 1, 'opting in must actually deliver the echo');
  });

  // `filter` is an untyped pocket that validates anything, so each of these reaches the Host.
  for (const [label, filter] of [
    ['a misspelled opt-in key', { includeOwnMessage: true }],
    ['a string where a boolean was meant', { includeOwnMessages: 'true' }],
    ['an opt-in explicitly set false', { includeOwnMessages: false }],
  ]) {
    test(`case 5: ${label} falls back to suppression`, async () => {
      loadPackage(RELAY_PACKAGE, 'outbound');
      await subscribe(RELAY_PACKAGE, filter);

      await relayInbound('hi');
      await delivery.drain(FIXED_THREAD);

      assert.deepEqual(outboundCalls, [], 'an unchecked key must degrade to silence, not a flood');
    });
  }
});
