import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

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
  const messaging = createMessagingDomain({
    messageStore: messages,
    invokeTrigger: {
      async trigger(...args) {
        wakes.push(args);
        return options.triggerOutcome ?? 'dispatched';
      },
    },
    socketManager: {
      broadcastToRoom(...args) {
        broadcasts.push(args);
      },
    },
    threadStore: threads,
    getDefaultCatId: () => 'codex',
    getMentionPatterns: () => new Map([['opus', ['@opus']]]),
    isKnownCatId: (catId) => catId === 'codex' || catId === 'opus',
  });
  const host = createPluginMessagingHost({
    pluginId: PLUGIN_ID,
    pluginInstanceId: INSTANCE_ID,
    ownerUserId: OWNER,
    effectiveGrants: ['messaging.send'],
    manifest: options.manifest ?? manifest(),
    threadStore: threads,
    bindingStore: bindings,
    messaging,
  });
  return { host, messages, threads, bindings, messaging, wakes, broadcasts };
}

describe('F202 C1 — plugin Host messaging.send', () => {
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
    assert.deepEqual(stored.source, {
      connector: 'fixture-identity',
      label: 'Fixture IM',
      icon: 'fixture-icon',
      sender: { id: 'bot-7', name: 'Fixture Bot' },
    });
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
    assert.equal(stored.source.connector, 'fixture-im');
    assert.equal(stored.source.label, 'Fixture IM');
    assert.deepEqual(stored.mentions, ['opus']);
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

    assert.equal((await messages.getById(receipt.messageId))?.source.connector, 'fixture-im');
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

  test('an explicit wake target is Host-validated and queue full is surfaced as retryable', async () => {
    const { host, threads } = await fixture({ triggerOutcome: 'full' });
    const thread = await threads.create(OWNER, 'Explicit');

    await assert.rejects(
      () => host.send(draft(thread.id, { idempotencyKey: 'full-1', wake: { catId: 'opus' } })),
      (error) => error?.code === 'RETRYABLE_INFLIGHT' && /queue is full/.test(error.message),
    );
    await assert.rejects(
      () => host.send(draft(thread.id, { idempotencyKey: 'unknown-1', wake: { catId: 'not-a-cat' } })),
      (error) => error?.code === 'VALIDATION' && /unknown cat/.test(error.message),
    );
  });

  test('external provenance cannot claim a chat bound to another thread', async () => {
    const { host, threads, bindings, messages } = await fixture();
    const bound = await threads.create(OWNER, 'Bound');
    const forged = await threads.create(OWNER, 'Forged');
    await bindings.bind(PLUGIN_ID, 'group-42', bound.id, OWNER);

    await assert.rejects(
      () =>
        host.send(
          draft(forged.id, {
            idempotencyKey: 'forged-1',
            origin: {
              kind: 'external',
              connectorId: 'fixture-im',
              sourceAddress: { connectorId: 'fixture-im', chatId: 'group-42' },
            },
            wake: 'auto',
          }),
        ),
      (error) => error?.code === 'PERMISSION' && /not bound to thread/.test(error.message),
    );
    assert.equal(messages.messages.length, 0);
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

    assert.deepEqual((await messages.getById(receipt.messageId))?.source, {
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
