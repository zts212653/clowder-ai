/**
 * F202 Train C1 — the whole journey, driven the way a real package drives it.
 *
 * The package owns its own addressing: it keeps its chat-to-thread mapping in plugin state,
 * creates threads through the thread API, and falls back to a thread derived from its own
 * identity when it is bound to nothing. None of that is the Host's business, so none of it is
 * simulated here by Host code — the package simply sends.
 *
 * WHAT THE HOST DOES OWN, AND WHY IT CANNOT MOVE INTO THE SDK:
 *  - the address it issues at activation carries relayed-human authority. A package speaking in
 *    its own voice never gains wake power from its text (frozen v0 security property), so a
 *    human mentioning a cat from Feishu can only wake it through an address the Host verified.
 *    An SDK cannot grant itself that;
 *  - deciding which subscribers are owed a thread's messages, because a package can only see its
 *    own subscription, and filtering after delivery is not filtering;
 *  - putting a cat's reply on the stream at all: cats write through the Host's own store, and no
 *    SDK can make those messages appear.
 *
 * THE ECHO IS THE DANGEROUS CASE. The package that relayed a message inward is also subscribed
 * to the thread it landed in, so handing it back would have it relay it outward again — one
 * inbound "hi" becoming an endless conversation on somebody's real platform.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

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
const FIXED_THREAD = 'thread-feishu-system';
const RELAY_PACKAGE = 'connector:feishu';
const FRONT_DESK = 'inst-front-desk';
const DEFAULT_CAT = 'opus';

beforeEach(async () => {
  const [messagingService, factory, publishing, subscriptionDelivery, moduleInvocation, storePort] = await Promise.all([
    import('../dist/domains/messaging/messaging-service.js'),
    import('../dist/domains/messaging/stores/factory.js'),
    import('../dist/domains/messaging/publishing-message-store.js'),
    import('../dist/domains/messaging/subscription-delivery.js'),
    import('../dist/domains/plugin/builtin-runtime/module-host-invocation.js'),
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

  messaging = messagingService.createMessagingDomain({
    messageStore,
    stores,
    invokeTrigger: {
      async trigger(threadId, catId, _userId, message, messageId) {
        wakes.push({ threadId, catId, message, messageId });
        return 'dispatched';
      },
    },
    threadStore: {
      async getParticipantsWithActivity() {
        return [];
      },
    },
    getDefaultCatId: () => DEFAULT_CAT,
    getMentionPatterns: () => new Map([[DEFAULT_CAT, ['@opus']]]),
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
    threadId: FIXED_THREAD,
    userId: 'user-1',
    catId: DEFAULT_CAT,
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
