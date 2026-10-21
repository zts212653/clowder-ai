import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { AgentRegistry } from '../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { createPluginConversationDelivery } from '../dist/domains/plugin/host-surface/plugin-conversation-delivery.js';

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
      },
    },
    isKnownCatId: (catId) => ['codex', 'opus', 'disabled-cat'].includes(catId),
  });
  const host = createPluginMessagingHost({
    pluginId: PLUGIN_ID,
    pluginInstanceId: INSTANCE_ID,
    ownerUserId: OWNER,
    effectiveGrants: options.grants ?? ['messaging.send'],
    manifest: options.manifest ?? manifest(),
    assertCurrent: options.assertCurrent,
    threadStore: threads,
    messageStore: messages,
    bindingStore: bindings,
    messaging,
  });
  return { host, messages, threads, bindings, messaging, wakes, broadcasts, router, queue, agents };
}

describe('F202 C1 — plugin Host messaging.send', () => {
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
      effectiveGrants: ['messaging.send'],
      manifest: manifest(),
      threadStore: threads,
      bindingStore: bindings,
      messaging,
    });

    const receipt = await reinstalled.send(draft(thread.id, { idempotencyKey: 'after-reinstall' }));

    assert.equal(receipt.threadId, thread.id);
    assert.equal((await messages.getById(receipt.messageId))?.threadId, thread.id);
  });

  test('selects one declared identity and preserves bounded url and metadata', async () => {
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
        url: 'https://example.test/pull/42',
        meta: { conversationLabel: 'Release room', nested: { ok: true } },
      }),
    );

    assert.deepEqual((await messages.getById(receipt.messageId))?.extra.pluginMessage.presentation, {
      connector: 'release-bot',
      label: 'Release Bot',
      icon: 'release-icon',
      url: 'https://example.test/pull/42',
      meta: { conversationLabel: 'Release room', nested: { ok: true } },
    });
  });

  test('rejects unsafe source urls, non-JSON metadata, and Host-owned metadata keys', async () => {
    const { host, threads } = await fixture();
    const thread = await threads.create(OWNER, 'Target');
    const cyclic = {};
    cyclic.self = cyclic;

    await assert.rejects(
      () => host.send(draft(thread.id, { idempotencyKey: 'bad-url', url: 'file:///tmp/secret' })),
      (error) => error?.code === 'VALIDATION' && /url/.test(error.message),
    );
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
    const f = await fixture({ grants: ['thread.readContent'] });
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

  test('uses existing content grant, owner and thread readability', async () => {
    const noGrant = await fixture();
    await assert.rejects(() => noGrant.host.get('unknown'), /thread.readContent/);
    const f = await fixture({ grants: ['thread.readContent'] });
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
    const f = await fixture({ grants: ['thread.readContent'] });
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
    const f = await fixture({ grants: ['thread.readContent'] });
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
    const f = await fixture({ grants: ['thread.readContent'] });
    const thread = await f.threads.create(OWNER, 'Source');
    const foreign = await f.threads.create('foreign', 'Foreign');
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
    const f = await fixture({ grants: ['thread.readContent'] });
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
    grants: ['messaging.send', 'thread.readContent'],
    assertCurrent: () => {
      if (!active) throw new Error('activation stopped');
    },
  });
  const thread = await h.threads.create(OWNER, 'ordinary thread');
  active = false;
  await assert.rejects(() => h.host.send(draft(thread.id)), /activation stopped/);
  await assert.rejects(() => h.host.get('missing'), /activation stopped/);
  assert.equal(h.messages.getByThread(thread.id, 100, OWNER).length, 0);
});
