import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { AgentRegistry } from '../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { createPluginConversationDelivery } from '../dist/domains/plugin/host-surface/plugin-conversation-delivery.js';
import './helpers/setup-cat-registry.js';

let createMessagingDomain;
let createPluginMessagingHost;
let MessageStore;
let ThreadStore;
let MemoryConnectorThreadBindingStore;

const PLUGIN_ID = 'dev.clowder.messaging-fixture';
const INSTANCE_ID = 'instance-messaging-1';
const OWNER = 'owner-1';

beforeEach(async () => {
  ({ createMessagingDomain } = await import('../dist/domains/messaging/index.js'));
  ({ createPluginMessagingHost } = await import('../dist/domains/plugin/host-surface/plugin-messaging-host.js'));
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
  ({ ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js'));
  ({ MemoryConnectorThreadBindingStore } = await import(
    '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js'
  ));
});

function manifest(options = {}) {
  const extraIdentities = options.extraIdentities ?? [];
  const externalContribution =
    options.externalKind === 'message-subscription'
      ? {
          type: 'message-subscription',
          id: 'fixture-im',
          binding: 'fixture-identity',
          action: { method: 'fixture.outbound' },
        }
      : options.externalKind === 'none'
        ? undefined
        : {
            type: 'connector',
            id: 'fixture-im',
            identityRef: 'fixture-identity',
            inboundMethod: 'fixture.inbound',
            outboundMethod: 'fixture.outbound',
          };
  return {
    pluginId: PLUGIN_ID,
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Messaging fixture',
    contributions: [
      { type: 'identity', id: 'fixture-identity', displayName: 'Fixture IM', icon: 'fixture-icon' },
      ...extraIdentities,
      ...(externalContribution === undefined ? [] : [externalContribution]),
    ],
    features: [
      {
        id: 'messaging',
        name: 'Messaging',
        resources: [],
        contributions: [
          { type: 'identity', id: 'fixture-identity' },
          ...(externalContribution === undefined ? [] : [{ type: externalContribution.type, id: 'fixture-im' }]),
        ],
        capabilities: ['messaging.send'],
      },
    ],
    runtime: { transport: 'builtin', entrypoint: 'dist/index.js' },
  };
}

function draft(threadId, overrides = {}) {
  return {
    threadId,
    idempotencyKey: overrides.idempotencyKey ?? 'send-1',
    payload: {
      provenance: {
        epistemicStatus: 'observation',
        ...(overrides.origin === undefined ? {} : { origin: overrides.origin }),
      },
      elements: [{ elementId: 'text-1', kind: 'text', payload: { text: overrides.text ?? 'hello' } }],
    },
    ...(overrides.wake === undefined ? {} : { wake: overrides.wake }),
    ...(overrides.sender === undefined ? {} : { sender: overrides.sender }),
    ...(overrides.contentBlocks === undefined ? {} : { contentBlocks: overrides.contentBlocks }),
    ...(overrides.replyTo === undefined ? {} : { replyTo: overrides.replyTo }),
    ...(overrides.response === undefined ? {} : { response: overrides.response }),
    ...(overrides.identity === undefined ? {} : { identity: overrides.identity }),
    ...(overrides.url === undefined ? {} : { url: overrides.url }),
    ...(overrides.meta === undefined ? {} : { meta: overrides.meta }),
  };
}

async function fixture(options = {}) {
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const bindings = new MemoryConnectorThreadBindingStore();
  const wakes = [];
  const broadcasts = [];
  const agents = new AgentRegistry();
  for (const catId of ['codex', 'opus'])
    agents.register(catId, {
      async *invoke() {
        throw Error('no provider IO');
      },
    });
  const router = new AgentRouter({
    agentRegistry: agents,
    registry: new InvocationRegistry(),
    messageStore: messages,
    threadStore: threads,
    addressedPlugins: options.addressedPlugins,
  });
  const queue = new InvocationQueue(undefined, { resolveTargets: (...args) => router.resolveSendTargets(...args) });
  const delivery = createPluginConversationDelivery({ messageStore: messages, queue, router });
  const messaging = createMessagingDomain({
    messageStore: messages,
    invokeTrigger: {
      async trigger(...args) {
        if (options.triggerOutcome) {
          wakes.push(args);
          return options.triggerOutcome;
        }
        const outcome = await delivery.trigger(...args);
        const entry =
          queue
            .list(args[0], args[2])
            .find((row) => row.payload.sourceId === args[4] || row.payload.sourceRecordId === args[4]) ??
          queue.list(args[0], args[2]).at(-1);
        wakes.push([args[0], entry?.targets[0], ...args.slice(2)]);
        return outcome;
      },
    },
    socketManager: {
      broadcastToRoom(...args) {
        broadcasts.push(args);
        options.afterPublish?.();
      },
    },
    isKnownCatId: (catId) => ['codex', 'opus', 'disabled-cat'].includes(catId),
  });
  const host = createPluginMessagingHost({
    pluginId: PLUGIN_ID,
    pluginInstanceId: INSTANCE_ID,
    ownerUserId: OWNER,
    manifest: options.manifest ?? manifest(),
    assertCurrent: options.assertCurrent,
    assertAdmissionCurrent: options.assertAdmissionCurrent,
    threadStore: threads,
    messageStore: messages,
    bindingStore: bindings,
    readMessageTargets: async (threadId, messageId) => {
      const rows = await queue.getDurableEntriesForMessages(threadId, [messageId]);
      return (rows.get(messageId) ?? []).flatMap((row) => row.targets);
    },
    messaging,
  });
  return { host, messages, threads, bindings, messaging, wakes, broadcasts, router, queue, agents };
}

describe('F202 C1 — plugin Host messaging.send', () => {
  test('live plugin replies retain the persisted reply link and attachments without replaying the broadcast', async () => {
    const { host, messages, threads, broadcasts, wakes } = await fixture();
    const thread = await threads.create(OWNER, 'Reply delivery');
    const source = await messages.append({
      threadId: thread.id,
      userId: OWNER,
      from: { kind: 'user', userId: OWNER },
      content: '@fixture hello',
      mentions: [],
      timestamp: Date.now(),
    });
    const contentBlocks = [{ type: 'image', url: '/uploads/fixture.png', alt: 'reply attachment' }];
    const input = draft(thread.id, { replyTo: source.id, contentBlocks });
    const receipt = await host.send(input);
    const stored = await messages.getById(receipt.messageId);
    assert.equal(stored.replyTo, source.id);
    assert.equal(broadcasts.length, 1);
    const [room, event, envelope] = broadcasts[0];
    assert.equal(room, `thread:${thread.id}`);
    assert.equal(event, 'connector_message');
    assert.equal(envelope.message.id, stored.id);
    assert.deepEqual(envelope.message.from, stored.from);
    assert.equal(envelope.message.replyTo, stored.replyTo, 'live publication must preserve reply ownership');
    assert.deepEqual(envelope.message.contentBlocks, stored.contentBlocks);
    assert.deepEqual(await host.send(input), receipt);
    assert.equal(broadcasts.length, 1);
    assert.equal(wakes.length, 0);
  });

  test('explicit plugin response lifecycle survives partial content, completion and late acknowledgement', async () => {
    const { host, messages, threads, broadcasts } = await fixture();
    const thread = await threads.create(OWNER, 'Target response');
    const source = await messages.append({
      threadId: thread.id,
      userId: OWNER,
      from: { kind: 'user', userId: OWNER },
      content: 'hello',
      mentions: [],
      timestamp: 1,
    });
    const deliveryId = 'ad_fixture-response';
    const carrier = await messages.append({
      threadId: thread.id,
      userId: 'system',
      from: { kind: 'system', service: 'plugin_delivery' },
      content: 'delivery',
      mentions: [],
      timestamp: 2,
      idempotencyKey: `plugin-addressed:${deliveryId}`,
      extra: {
        pluginAddressedReceipt: { targetId: INSTANCE_ID, inputMessageId: source.id, accepted: true, phase: 'accepted' },
        targetResponse: {
          v: 1,
          revision: 1,
          inputMessageId: source.id,
          targetId: INSTANCE_ID,
          execution: { kind: 'plugin', id: deliveryId },
          status: 'waiting',
          startedAt: 2,
          updatedAt: 2,
        },
      },
    });
    await messages.advanceLifecycleInputDispatch(source.id, {
      orderKey: source.id,
      targetId: INSTANCE_ID,
      statusMessageId: carrier.id,
      phase: 'dispatched',
      dispatchedAt: 2,
    });
    const partial = await host.send(
      draft(thread.id, {
        idempotencyKey: 'partial',
        replyTo: source.id,
        response: { deliveryId, status: 'processing' },
        text: 'partial',
      }),
    );
    assert.equal(messages.getById(carrier.id).extra.targetResponse.status, 'processing');
    assert.equal(messages.getById(carrier.id).extra.targetResponse.resultMessageId, partial.messageId);
    const complete = draft(thread.id, {
      idempotencyKey: 'complete',
      replyTo: source.id,
      response: { deliveryId, status: 'completed' },
      text: 'finished',
    });
    const result = await host.send(complete);
    assert.equal(messages.getById(carrier.id).extra.targetResponse.status, 'completed');
    assert.equal(messages.getById(carrier.id).extra.targetResponse.resultMessageId, result.messageId);
    assert.equal(
      broadcasts.filter(([, event]) => event === 'connector_message').at(-1)[2].message.extra.targetResponseResult
        .status,
      'completed',
    );
    assert.deepEqual(await host.send(complete), result);
    const beforeRetry = broadcasts.length;
    assert.deepEqual(
      await host.send(
        draft(thread.id, {
          idempotencyKey: 'partial',
          replyTo: source.id,
          response: { deliveryId, status: 'processing' },
          text: 'partial',
        }),
      ),
      partial,
    );
    assert.equal(broadcasts.length, beforeRetry, 'accepted replay must not republish content or reopen the outcome');
    // A broad metadata update cannot overwrite the dedicated response CAS field.
    messages.updateExtra(carrier.id, { targetResponse: { ...carrier.extra.targetResponse, status: 'waiting' } });
    assert.equal(messages.getById(carrier.id).extra.targetResponse.status, 'completed');
    await assert.rejects(
      host.send(
        draft(thread.id, {
          idempotencyKey: 'wrong',
          replyTo: source.id,
          response: { deliveryId: 'another', status: 'completed' },
        }),
      ),
    );
    await assert.rejects(
      host.send(
        draft(thread.id, {
          idempotencyKey: 'reopen',
          replyTo: source.id,
          response: { deliveryId, status: 'processing' },
        }),
      ),
    );
  });

  test('upgrades only an exact legacy delivery and rejects ambiguous source targets', async () => {
    const { host, messages, threads } = await fixture();
    const thread = await threads.create(OWNER, 'Legacy response');
    const source = await messages.append({
      threadId: thread.id,
      userId: OWNER,
      from: { kind: 'user', userId: OWNER },
      content: 'legacy input',
      mentions: [],
      timestamp: 1,
    });
    const deliveryId = 'ad_legacy-response';
    const carrier = await messages.append({
      threadId: thread.id,
      userId: 'system',
      from: { kind: 'system', service: 'plugin_delivery' },
      content: 'receipt',
      mentions: [],
      timestamp: 2,
      idempotencyKey: `plugin-addressed:${deliveryId}`,
      extra: {
        pluginAddressedReceipt: { targetId: INSTANCE_ID, inputMessageId: source.id, accepted: true, phase: 'accepted' },
      },
    });
    await messages.advanceLifecycleInputDispatch(source.id, {
      orderKey: source.id,
      targetId: INSTANCE_ID,
      statusMessageId: carrier.id,
      phase: 'dispatched',
      dispatchedAt: 2,
    });
    await assert.rejects(
      host.send(
        draft(thread.id, {
          idempotencyKey: 'wrong-legacy',
          replyTo: source.id,
          response: { deliveryId: 'unowned', status: 'completed' },
        }),
      ),
    );
    assert.equal(messages.getById(carrier.id).extra.targetResponse, undefined);
    const result = await host.send(
      draft(thread.id, {
        idempotencyKey: 'legacy-complete',
        replyTo: source.id,
        response: { deliveryId, status: 'completed' },
      }),
    );
    const migrated = messages.getById(carrier.id).extra.targetResponse;
    assert.equal(migrated.status, 'completed');
    assert.equal(migrated.execution.id, deliveryId);
    assert.equal(migrated.resultMessageId, result.messageId);
    const sourceState = messages.getById(source.id);
    // Ambiguous target references may not grant a second delivery authority.
    sourceState.lifecycle.dispatchRefs.push({ ...sourceState.lifecycle.dispatchRefs[0], statusMessageId: 'other' });
    await assert.rejects(
      host.send(
        draft(thread.id, {
          idempotencyKey: 'ambiguous',
          replyTo: source.id,
          response: { deliveryId, status: 'completed' },
        }),
      ),
    );
  });

  function addressedPlugins() {
    const targets = [
      { id: INSTANCE_ID, alias: 'dot', kind: 'plugin' },
      { id: 'instance-other-plugin', alias: 'helper', kind: 'plugin' },
    ];
    return {
      list: async () => targets,
      isInstanceId: async (id) => targets.some((target) => target.id === id),
    };
  }

  for (const [text, expected] of [
    ['@dot here — can someone review this?', ['codex']],
    ['@dot @opus please inspect', ['opus']],
    ['@dot @helper please inspect', ['instance-other-plugin']],
    ['Can someone review this?', ['codex']],
  ]) {
    test(`plugin auto wake excludes its own instance while preserving ordinary routing: ${text}`, async () => {
      const { host, messages, threads, queue } = await fixture({ addressedPlugins: addressedPlugins() });
      const thread = await threads.create(OWNER, 'Plugin question');
      threads.updateParticipantActivity(thread.id, 'codex', true);
      const receipt = await host.send(draft(thread.id, { text, wake: 'auto' }));
      const source = await messages.getById(receipt.messageId);
      assert.deepEqual(source.from, { kind: 'plugin', instanceId: INSTANCE_ID });
      assert.equal(source.content, text, 'routing must not rewrite published speech');
      assert.deepEqual(
        queue.list(thread.id, OWNER).flatMap((entry) => entry.targets),
        expected,
      );
    });
  }

  test('external IM ingress may explicitly address another plugin through the ordinary queue', async () => {
    const { host, threads, bindings, queue, messages } = await fixture({
      manifest: manifest({ externalKind: 'message-subscription' }),
      addressedPlugins: addressedPlugins(),
    });
    const thread = await threads.create(OWNER, 'IM explicit plugin');
    await bindings.bind(PLUGIN_ID, 'group-addressed', thread.id, OWNER);
    const receipt = await host.send(
      draft(thread.id, {
        text: '@helper please inspect',
        origin: {
          kind: 'external',
          connectorId: 'fixture-im',
          sourceAddress: { connectorId: 'fixture-im', chatId: 'group-addressed', messageId: 'external-addressed' },
        },
        wake: 'auto',
        sender: { id: 'person-9', name: 'Ada' },
      }),
    );
    assert.deepEqual(
      queue.list(thread.id, OWNER).flatMap((entry) => entry.targets),
      ['instance-other-plugin'],
    );
    assert.equal((await messages.getById(receipt.messageId)).extra.pluginMessage.presentation.connector, 'fixture-im');
  });

  test('a module can narrow its send admission after handle preparation without granting a new identity', async () => {
    const { host, messages, threads, messaging, wakes } = await fixture();
    const thread = await threads.create(OWNER, 'Bounded operator request');
    let active = true;
    const ensure = messaging.ensureThreadHandle.bind(messaging);
    messaging.ensureThreadHandle = async (...args) => {
      const value = await ensure(...args);
      active = false;
      return value;
    };
    assert.equal(typeof host.sendWithAdmission, 'function');
    await assert.rejects(
      host.sendWithAdmission(draft(thread.id, { wake: { catId: 'opus', exact: true } }), () => {
        if (!active) throw new Error('operator_window_closed');
      }),
      /operator_window_closed/,
    );
    assert.equal((await messages.getByThread(thread.id)).length, 0);
    assert.equal(wakes.length, 0);
  });

  test('a module admission expiring during publication preserves the original message but never wakes', async () => {
    let active = true;
    const { host, messages, threads, wakes } = await fixture({
      afterPublish() {
        active = false;
      },
    });
    const thread = await threads.create(OWNER, 'Published bounded request');
    assert.equal(typeof host.sendWithAdmission, 'function');
    await assert.rejects(
      host.sendWithAdmission(draft(thread.id, { wake: { catId: 'opus', exact: true } }), () => {
        if (!active) throw new Error('operator_window_closed');
      }),
      /operator_window_closed/,
    );
    assert.equal((await messages.getByThread(thread.id)).length, 1);
    assert.equal(wakes.length, 0);
  });

  test('a false module predicate is a rejection, never a successful authorization check', async () => {
    const { host, messages, threads, wakes } = await fixture();
    const thread = await threads.create(OWNER, 'Invalid module predicate');
    assert.equal(typeof host.sendWithAdmission, 'function');
    await assert.rejects(
      host.sendWithAdmission(draft(thread.id), () => false),
      /admission/,
    );
    await assert.rejects(
      host.sendWithAdmission(draft(thread.id), async () => {}),
      /synchronously/,
    );
    assert.equal((await messages.getByThread(thread.id)).length, 0);
    assert.equal(wakes.length, 0);
  });

  test('module admission preserves the original Host execution lease and activation checks', async () => {
    const { host, messages, threads, wakes } = await fixture({
      assertAdmissionCurrent: async () => {
        throw new Error('member_lease_expired');
      },
    });
    const thread = await threads.create(OWNER, 'Expired original lease');
    await assert.rejects(
      host.sendWithAdmission(draft(thread.id), () => {}),
      /member_lease_expired/,
    );
    assert.equal((await messages.getByThread(thread.id)).length, 0);
    assert.equal(wakes.length, 0);
  });

  test('settled receipts remain read-only when the additional admission has expired', async () => {
    const { host, messages, threads, wakes } = await fixture();
    const thread = await threads.create(OWNER, 'Settled bounded request');
    const input = draft(thread.id, { wake: { catId: 'opus', exact: true } });
    const receipt = await host.sendWithAdmission(input, () => {});
    assert.deepEqual(
      await host.sendWithAdmission(input, () => {
        throw new Error('operator_window_closed');
      }),
      receipt,
    );
    assert.equal(messages.messages.length, 1, 'Queue admission hides its original input from timeline reads');
    assert.equal(wakes.length, 1);
  });

  test('exact wake holds the chosen recipient and durable lookup survives temporary ledger expiry', async () => {
    const { host, messages, threads, wakes, queue, agents, router } = await fixture();
    const thread = await threads.create(OWNER, 'Exact game request');
    agents.markUnavailable('opus', { code: 'rejected-account-binding', message: 'unavailable fixture' });
    router.refreshFromRegistry(agents);
    const input = draft(thread.id, { wake: { catId: 'opus', exact: true } });
    await assert.rejects(() => host.send(input), /explicit plugin recipient/);
    assert.equal(wakes.length, 0);
    assert.equal(queue.size(thread.id, OWNER), 0);
    agents.register('opus', {
      async *invoke() {
        throw new Error('no provider IO');
      },
    });
    router.refreshFromRegistry(agents);
    const sent = await host.send(input);
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0][1], 'opus');
    assert.equal(messages.messages.length, 1);
    const now = Date.now;
    try {
      Date.now = () => now() + 8 * 24 * 3600 * 1000;
      const found = await host.findSent({ threadId: thread.id, idempotencyKey: input.idempotencyKey });
      assert.equal(found.messageId, sent.messageId);
      assert.deepEqual(found.routedCatIds, ['opus']);
      assert.equal(found.content, 'hello');
      assert.equal(wakes.length, 1);
    } finally {
      Date.now = now;
    }
  });
  for (const target of ['unknown-cat', 'removed-cat', 'disabled-cat']) {
    test(`${target} uses ordinary conversation routing to the recent healthy member`, async () => {
      const { host, messages, threads, wakes, broadcasts } = await fixture();
      const thread = await threads.create(OWNER, 'Notification target');
      threads.updateParticipantActivity(thread.id, 'codex', true);
      const input = draft(thread.id, { wake: { catId: target } });
      const first = await host.send(input);
      assert.equal(first.messageId, messages.messages[0].id);
      assert.deepEqual(await host.send(input), first);
      assert.equal(messages.messages.length, 1);
      assert.equal(messages.messages[0].content, 'hello');
      assert.equal(messages.messages[0].threadId, thread.id);
      assert.deepEqual(messages.messages[0].mentions, []);
      assert.equal(broadcasts.length, 1);
      assert.equal(wakes.length, 1);
      assert.equal(wakes[0][1], 'codex');
    });
  }

  test('forwards the complete accepted receipt so packages can observe pendingPublication', async () => {
    const { host, messaging, threads } = await fixture();
    const thread = await threads.create(OWNER, 'Pending media');
    const accepted = {
      messageId: '0000000000000001-000001-deadbeef',
      threadId: thread.id,
      revision: 1,
      messageHandle: { kind: 'message', token: 'mh_accepted' },
      pendingPublication: true,
    };
    messaging.sendFromHost = async () => accepted;
    assert.deepEqual(await host.send(draft(thread.id)), accepted);
  });

  test('plugin speech uses the declared identity and preserves content blocks without waking', async () => {
    const { host, messages, threads, wakes, broadcasts } = await fixture();
    const thread = await threads.create(OWNER, 'Target');
    const contentBlocks = [{ type: 'image', url: '/uploads/fixture.png', alt: 'fixture' }];

    const receipt = await host.send(
      draft(thread.id, {
        sender: { id: 'bot-7', name: 'Fixture Bot' },
        contentBlocks,
      }),
    );

    assert.equal(receipt.threadId, thread.id);
    assert.equal(receipt.revision, 1);
    assert.equal(receipt.messageHandle.kind, 'message');
    assert.equal(typeof receipt.publishSequence, 'number');
    const stored = await messages.getById(receipt.messageId);
    assert.deepEqual(stored.extra.pluginMessage.presentation, {
      connector: 'fixture-identity',
      label: 'Fixture IM',
      icon: 'fixture-icon',
      sender: { id: 'bot-7', name: 'Fixture Bot' },
    });
    assert.deepEqual(stored.from, { kind: 'plugin', instanceId: INSTANCE_ID });
    assert.equal(stored.source, undefined, 'plugin sender must not masquerade as external identity');
    assert.deepEqual(broadcasts[0][2].message.from, stored.from);
    assert.deepEqual(stored.contentBlocks, contentBlocks);
    assert.deepEqual(stored.mentions, []);
    assert.equal(wakes.length, 0);
    assert.equal(broadcasts.length, 1);
  });

  test('external auto wake resolves the declared message-subscription binding and reaches the shared trigger', async () => {
    const { host, messages, threads, bindings, wakes } = await fixture({
      manifest: manifest({ externalKind: 'message-subscription' }),
    });
    const thread = await threads.create(OWNER, 'External');
    await bindings.bind(PLUGIN_ID, 'group-42', thread.id, OWNER);

    const receipt = await host.send(
      draft(thread.id, {
        idempotencyKey: 'external-1',
        text: '@opus please inspect',
        origin: {
          kind: 'external',
          connectorId: 'fixture-im',
          sourceAddress: { connectorId: 'fixture-im', chatId: 'group-42', messageId: 'external-message-1' },
        },
        wake: 'auto',
        sender: { id: 'person-9', name: 'Ada' },
        contentBlocks: [{ type: 'text', text: '@opus please inspect' }],
      }),
    );

    const stored = await messages.getById(receipt.messageId);
    assert.equal(stored.extra.pluginMessage.presentation.connector, 'fixture-im');
    assert.equal(stored.extra.pluginMessage.presentation.label, 'Messaging fixture');
    assert.deepEqual(stored.mentions, []);
    assert.deepEqual(wakes, [
      [
        thread.id,
        'opus',
        OWNER,
        '@opus please inspect',
        receipt.messageId,
        [{ type: 'text', text: '@opus please inspect' }],
        undefined,
        { id: 'person-9', name: 'Ada' },
      ],
    ]);
    await assert.rejects(
      () =>
        host.send(
          draft(thread.id, {
            idempotencyKey: 'external-wrong-identity',
            identity: 'other-identity',
            origin: {
              kind: 'external',
              connectorId: 'fixture-im',
              sourceAddress: { connectorId: 'fixture-im', chatId: 'group-42' },
            },
          }),
        ),
      (error) => error?.code === 'VALIDATION' && /does not use identity other-identity/.test(error.message),
    );
  });

  test('legacy connector declarations remain valid during cutover', async () => {
    const { host, messages, threads, bindings } = await fixture();
    const thread = await threads.create(OWNER, 'Legacy external');
    await bindings.bind(PLUGIN_ID, 'legacy-group', thread.id, OWNER);

    const receipt = await host.send(
      draft(thread.id, {
        idempotencyKey: 'legacy-external',
        origin: {
          kind: 'external',
          connectorId: 'fixture-im',
          sourceAddress: { connectorId: 'fixture-im', chatId: 'legacy-group' },
        },
      }),
    );

    assert.equal((await messages.getById(receipt.messageId))?.extra.pluginMessage.presentation.connector, 'fixture-im');
  });

  test('external provenance rejects an undeclared subscription or connector', async () => {
    const { host, threads, bindings } = await fixture({ manifest: manifest({ externalKind: 'none' }) });
    const thread = await threads.create(OWNER, 'Undeclared external');
    await bindings.bind(PLUGIN_ID, 'missing-group', thread.id, OWNER);

    await assert.rejects(
      () =>
        host.send(
          draft(thread.id, {
            idempotencyKey: 'undeclared-external',
            origin: {
              kind: 'external',
              connectorId: 'fixture-im',
              sourceAddress: { connectorId: 'fixture-im', chatId: 'missing-group' },
            },
          }),
        ),
      (error) => error?.code === 'PERMISSION' && /not declared by this plugin/.test(error.message),
    );
  });

  test('queue full remains a retryable wake failure after preserving the message', async () => {
    const { host, threads } = await fixture({ triggerOutcome: 'full' });
    const thread = await threads.create(OWNER, 'Explicit');

    await assert.rejects(
      () => host.send(draft(thread.id, { idempotencyKey: 'full-1', wake: { catId: 'opus' } })),
      (error) => error?.code === 'RETRYABLE_INFLIGHT' && /queue is full/.test(error.message),
    );
  });

  test('external provenance uses plugin-selected thread without a Host binding ACL', async () => {
    const { host, threads, bindings, messages } = await fixture();
    const bound = await threads.create(OWNER, 'Bound');
    const forged = await threads.create(OWNER, 'Forged');
    await bindings.bind(PLUGIN_ID, 'group-42', bound.id, OWNER);

    const receipt = await host.send(
      draft(forged.id, {
        idempotencyKey: 'selected-thread',
        origin: {
          kind: 'external',
          connectorId: 'fixture-im',
          sourceAddress: { connectorId: 'fixture-im', chatId: 'group-42' },
        },
        wake: 'auto',
      }),
    );
    assert.equal(receipt.threadId, forged.id);
    assert.equal(messages.messages.length, 1);
  });

  test('a reinstalled plugin can send to a legacy system-owned thread through its durable binding', async () => {
    const { messages, threads, bindings, messaging } = await fixture();
    const thread = await threads.ensureThread('legacy-plugin-thread', 'Legacy');
    await threads.updatePluginOwnership(thread.id, { v: 1, pluginInstanceId: 'instance-before-reinstall' });
    await bindings.bind(PLUGIN_ID, 'group-42', thread.id, OWNER);
    const reinstalled = createPluginMessagingHost({
      pluginId: PLUGIN_ID,
      pluginInstanceId: 'instance-after-reinstall',
      ownerUserId: OWNER,
      manifest: manifest(),
      threadStore: threads,
      bindingStore: bindings,
      messaging,
    });

    const receipt = await reinstalled.send(draft(thread.id, { idempotencyKey: 'after-reinstall' }));

    assert.equal(receipt.threadId, thread.id);
    assert.equal((await messages.getById(receipt.messageId))?.threadId, thread.id);
  });

  test('selects one declared identity and preserves metadata without a hidden navigation URL', async () => {
    const secondIdentity = {
      type: 'identity',
      id: 'release-bot',
      displayName: 'Release Bot',
      icon: 'release-icon',
    };
    const { host, messages, threads } = await fixture({ manifest: manifest({ extraIdentities: [secondIdentity] }) });
    const thread = await threads.create(OWNER, 'Target');

    await assert.rejects(
      () => host.send(draft(thread.id, { idempotencyKey: 'missing-identity' })),
      (error) => error?.code === 'VALIDATION' && /identity/.test(error.message),
    );
    const receipt = await host.send(
      draft(thread.id, {
        idempotencyKey: 'selected-identity',
        identity: 'release-bot',
        meta: { conversationLabel: 'Release room', nested: { ok: true } },
      }),
    );

    assert.deepEqual((await messages.getById(receipt.messageId))?.extra.pluginMessage.presentation, {
      connector: 'release-bot',
      label: 'Release Bot',
      icon: 'release-icon',
      meta: { conversationLabel: 'Release room', nested: { ok: true } },
    });

    await assert.rejects(
      () =>
        host.send(
          draft(thread.id, {
            idempotencyKey: 'retired-hidden-url',
            identity: 'release-bot',
            url: 'https://example.test/pull/42',
          }),
        ),
      (error) => error?.code === 'VALIDATION' && /unsupported fields: url/.test(error.message),
    );
  });

  test('rejects non-JSON metadata and Host-owned metadata keys', async () => {
    const { host, threads } = await fixture();
    const thread = await threads.create(OWNER, 'Target');
    const cyclic = {};
    cyclic.self = cyclic;

    await assert.rejects(
      () => host.send(draft(thread.id, { idempotencyKey: 'cyclic-meta', meta: cyclic })),
      (error) => error?.code === 'VALIDATION' && /meta/.test(error.message),
    );
    await assert.rejects(
      () => host.send(draft(thread.id, { idempotencyKey: 'reserved-meta', meta: { externalChatId: 'forged' } })),
      (error) => error?.code === 'VALIDATION' && /externalChatId/.test(error.message),
    );
    await assert.rejects(
      () => host.send(draft(thread.id, { idempotencyKey: 'oversized-meta', meta: { text: 'x'.repeat(17_000) } })),
      (error) => error?.code === 'VALIDATION' && /at most/.test(error.message),
    );
  });
});

describe('F202 C1 — generic messaging.get', () => {
  test('reads body revision and persisted publication facts without private extra', async () => {
    const f = await fixture({});
    const thread = await f.threads.create(OWNER, 'Source');
    const message = await f.messages.append({
      timestamp: Date.now(),
      userId: OWNER,
      threadId: thread.id,
      from: { kind: 'agent', catId: 'codex' },
      content: 'result',
      mentions: [],
      origin: 'callback',
      contentBlocks: [{ type: 'text', text: 'result' }],
      extra: {
        stream: { invocationId: 'parent', turnInvocationId: 'turn', cliStdout: 'private' },
        causal: { kind: 'invocation_reply', triggerMessageId: 'source' },
        privateAuthority: 'never-return',
      },
    });
    const value = await f.host.get(message.id);
    assert.equal(value.threadId, thread.id);
    assert.equal(value.catId, 'codex');
    assert.equal(value.origin, 'callback');
    assert.deepEqual(value.extra.stream, { invocationId: 'parent', turnInvocationId: 'turn' });
    assert.equal(value.extra.causal.triggerMessageId, 'source');
    assert.match(value.sourceRevision, /^sha256:[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(value).includes('private'), false);
    value.contentBlocks[0].text = 'local change';
    assert.equal((await f.host.get(message.id)).contentBlocks[0].text, 'result');
    message.content = 'edited';
    assert.notEqual((await f.host.get(message.id)).sourceRevision, value.sourceRevision);
  });

  test('uses existing owner and thread readability', async () => {
    const f = await fixture({});
    const foreign = await f.threads.create('foreign', 'Foreign');
    const message = await f.messages.append({
      timestamp: Date.now(),
      userId: OWNER,
      threadId: foreign.id,
      from: { kind: 'user', userId: OWNER },
      content: 'owned source',
      mentions: [],
    });
    assert.equal((await f.host.get(message.id)).content, 'owned source');
    await f.bindings.bind(PLUGIN_ID, 'readable', foreign.id, OWNER);
    assert.equal((await f.host.get(message.id)).content, 'owned source');
    message.userId = 'foreign';
    assert.equal(await f.host.get(message.id), null);
    message.userId = OWNER;
    foreign.deletedAt = 1;
    assert.equal(await f.host.get(message.id), null);
  });

  test('missing, deleted, recalled, tombstoned and canceled sources are unavailable', async () => {
    const f = await fixture({});
    const thread = await f.threads.create(OWNER, 'Source');
    assert.equal(await f.host.get('missing'), null);
    for (const state of [
      { deletedAt: 1 },
      { _tombstone: true },
      { recall: { recalledAt: 1 } },
      { deliveryStatus: 'canceled' },
      { sourceParseFailure: true },
    ]) {
      const message = await f.messages.append({
        timestamp: Date.now(),
        userId: OWNER,
        threadId: thread.id,
        from: { kind: 'user', userId: OWNER },
        content: 'body',
        mentions: [],
      });
      Object.assign(message, state);
      assert.equal(await f.host.get(message.id), null);
    }
    await assert.rejects(() => f.host.get({ id: 'missing' }), /messageId/);
  });

  test('direct reads retain owner input and its revision across Queue admission', async () => {
    const f = await fixture({});
    const thread = await f.threads.create(OWNER, 'Source');
    for (const source of [undefined, { connector: 'example', label: 'Example' }]) {
      const message = await f.messages.append({
        timestamp: Date.now(),
        userId: OWNER,
        threadId: thread.id,
        from: { kind: 'user', userId: OWNER },
        content: 'original input',
        mentions: [],
        ...(source ? { source, from: { kind: 'external', connectorId: source.connector } } : {}),
      });
      const original = await f.host.get(message.id);
      assert.equal(f.messages.prepareQueueAdmission(message.id).kind, 'prepared');
      const queued = await f.host.get(message.id);
      assert.equal(queued?.content, original.content);
      assert.equal(queued.sourceRevision, original.sourceRevision);
      assert.equal(queued.deliveryStatus, 'queued');
      assert.equal('queueCustody' in queued, false);
      message.recall = { recalledAt: 1 };
      assert.equal(await f.host.get(message.id), null);
    }
    assert.equal(f.wakes.length, 0);
  });

  test('queued reads retain owner, thread and non-input visibility boundaries', async () => {
    const f = await fixture({});
    const thread = await f.threads.create(OWNER, 'Source');
    const _foreign = await f.threads.create('foreign', 'Foreign');
    for (const overrides of [
      { userId: 'foreign' },
      { origin: 'briefing' },
      { catId: 'codex' },
      { userId: 'scheduler' },
      { userId: 'system' },
      { deletedAt: 1 },
      { _tombstone: true },
      { sourceParseFailure: true },
    ]) {
      const message = await f.messages.append({
        timestamp: Date.now(),
        userId: OWNER,
        threadId: thread.id,
        from: { kind: 'user', userId: OWNER },
        content: 'hidden input',
        mentions: [],
      });
      assert.equal(f.messages.prepareQueueAdmission(message.id).kind, 'prepared');
      Object.assign(message, overrides);
      assert.equal(await f.host.get(message.id), null, JSON.stringify(overrides));
    }
  });

  test('works with asynchronous stores inside the existing verifier context', async () => {
    const { withPluginTransportPurpose } = await import('../dist/domains/plugin/carrier/plugin-transport-context.js');
    const f = await fixture({});
    const thread = await f.threads.create(OWNER, 'Source');
    const message = await f.messages.append({
      timestamp: Date.now(),
      userId: OWNER,
      threadId: thread.id,
      from: { kind: 'user', userId: OWNER },
      content: 'original source',
      mentions: [],
    });
    const get = f.messages.getById.bind(f.messages);
    f.messages.getById = async (id) => get(id);
    const value = await withPluginTransportPurpose('verifier', () => f.host.get(message.id));
    assert.equal(value.content, 'original source');
    assert.equal(f.wakes.length, 0);
  });
});

test('stopped plugin client cannot send or read through retained messaging methods', async () => {
  let active = true;
  const h = await fixture({
    assertCurrent: () => {
      if (!active) throw new Error('activation stopped');
    },
  });
  const thread = await h.threads.create(OWNER, 'ordinary thread');
  active = false;
  await assert.rejects(() => h.host.send(draft(thread.id)), /activation stopped/);
  await assert.rejects(() => h.host.sendWithAdmission(draft(thread.id), () => {}), /activation stopped/);
  await assert.rejects(() => h.host.get('missing'), /activation stopped/);
  assert.equal(h.messages.getByThread(thread.id, 100, OWNER).length, 0);
});
