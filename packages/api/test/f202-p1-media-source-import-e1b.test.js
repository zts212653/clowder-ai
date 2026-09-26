import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';

const { FileMessagingMediaLedger } = await import('../dist/domains/messaging/media-ledger.js');
const { HostMediaSourceImporter } = await import('../dist/domains/plugin/media-source-importer.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { HandleService } = await import('../dist/domains/messaging/handles.js');
const { MessagingLedger } = await import('../dist/domains/messaging/ledger.js');
const { PendingMediaPublication } = await import('../dist/domains/messaging/media-pending-publication.js');
const { MemoryMediaStagingStore } = await import('../dist/domains/messaging/media-staging.js');
const { SendService } = await import('../dist/domains/messaging/send-service.js');
const stores = await import('../dist/domains/messaging/stores/memory.js');
const { createDormantPluginRuntimeComposition, createPluginManagerRuntimeComposition } = await import(
  '../dist/domains/plugin/index.js'
);
const { MemoryMeetingIntakeStore, MemorySignalRouteStore } = await import('../dist/domains/signal-intake/index.js');

const manifest = {
  contributions: [
    { type: 'identity', id: 'identity-1' },
    { type: 'connector', id: 'connector-1', identityRef: 'identity-1' },
    {
      type: 'media-source',
      id: 'source-1',
      binding: 'identity-1',
      readAction: { method: 'media.source.read' },
      settleAction: { method: 'media.source.settle' },
    },
  ],
};
const input = {
  instanceId: 'instance-1',
  sourceEventId: 'event-1',
  elementId: 'photo',
  reference: 'pmr_opaque',
  sourceId: 'source-1',
  ingressIdentity: 'connector-1',
  requestId: 'request-123',
  type: 'image',
  fileName: 'photo.png',
};

async function fixture(invoke, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'media-source-e1b-'));
  const ledger = new FileMessagingMediaLedger(join(root, 'media'));
  const makeImporter = (extra = {}) =>
    new HostMediaSourceImporter({
      ledger,
      resolveManifest: async (instanceId) => (instanceId === input.instanceId ? manifest : undefined),
      invoke,
      ...options,
      ...extra,
    });
  return { root, ledger, makeImporter, close: () => rm(root, { recursive: true, force: true }) };
}

test('real media-source chunks materialize one durable hmr and settle with the same request id', async () => {
  const calls = [];
  const bytes = Buffer.from('hello media');
  const f = await fixture(async (_instanceId, method, params) => {
    calls.push({ method, params });
    if (method.endsWith('settle')) return { ok: true };
    const chunk = bytes.subarray(params.offset, params.offset + 4);
    const done = params.offset + chunk.length >= bytes.length;
    return {
      kind: 'chunk',
      requestId: params.requestId,
      offset: params.offset,
      dataBase64: chunk.toString('base64'),
      ...(done ? {} : { nextOffset: params.offset + chunk.length }),
      done,
    };
  });
  try {
    const result = await f.makeImporter({ chunkBytes: 4 }).import(input);
    assert.equal(result.kind, 'imported');
    assert.match(result.hmrId, /^hmr_[A-Za-z0-9_-]{32}$/);
    assert.equal((await f.ledger.readChunk(result.hmrId, 0, 524288)).dataBase64, bytes.toString('base64'));
    assert.deepEqual(
      calls.filter((call) => call.method.endsWith('read')).map((call) => call.params.offset),
      [0, 4, 8],
    );
    assert.equal(
      calls.every((call) => call.params.requestId === input.requestId),
      true,
    );
    await f.makeImporter().settle(input, 'imported');
    assert.deepEqual(calls.at(-1), {
      method: 'media.source.settle',
      params: {
        requestId: input.requestId,
        reference: input.reference,
        outcome: 'imported',
      },
    });
    const again = await f.makeImporter().import(input);
    assert.deepEqual(again, result);
    assert.equal(calls.filter((call) => call.method.endsWith('read')).length, 3);
    const record = await readFile(join(f.root, 'media', 'records', `${result.hmrId}.json`), 'utf8');
    assert.equal(record.includes(input.reference), false);
    assert.equal(record.includes(bytes.toString()), false);
  } finally {
    await f.close();
  }
});

test('source rejection, malformed nonterminal chunk, byte cap and callback failure map to unavailable', async () => {
  for (const [reply, expected, options] of [
    [{ kind: 'rejected', requestId: input.requestId, code: 'MEDIA_SOURCE_UNAVAILABLE' }, 'source_expired', {}],
    [
      { kind: 'chunk', requestId: input.requestId, offset: 0, dataBase64: '', nextOffset: 0, done: false },
      'unavailable',
      {},
    ],
    [
      {
        kind: 'chunk',
        requestId: input.requestId,
        offset: 0,
        dataBase64: Buffer.from('too big').toString('base64'),
        done: true,
      },
      'unavailable',
      { maxBytes: 3 },
    ],
    [new Error('private credentials: secret'), 'unavailable', {}],
  ]) {
    const f = await fixture(async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    }, options);
    try {
      assert.deepEqual(await f.makeImporter().import(input), { kind: 'unavailable', reason: expected });
    } finally {
      await f.close();
    }
  }
});

test('an empty final chunk is legal; discontinuous offsets and foreign request ids are not', async () => {
  const cases = [
    {
      replies: [
        { kind: 'chunk', requestId: input.requestId, offset: 0, dataBase64: 'YQ==', nextOffset: 1, done: false },
        { kind: 'chunk', requestId: input.requestId, offset: 1, dataBase64: '', done: true },
      ],
      expected: 'imported',
    },
    {
      replies: [
        { kind: 'chunk', requestId: input.requestId, offset: 0, dataBase64: 'YQ==', nextOffset: 2, done: false },
      ],
      expected: 'unavailable',
    },
    {
      replies: [{ kind: 'chunk', requestId: 'foreign', offset: 0, dataBase64: 'YQ==', done: true }],
      expected: 'unavailable',
    },
  ];
  for (const { replies, expected } of cases) {
    let index = 0;
    const f = await fixture(async () => replies[index++]);
    try {
      const result = await f.makeImporter().import(input);
      assert.equal(result.kind, expected);
      if (expected === 'imported') {
        assert.equal((await f.ledger.readChunk(result.hmrId, 0, 10)).dataBase64, 'YQ==');
      }
    } finally {
      await f.close();
    }
  }
});

test('callback deadline maps to timeout without materializing late bytes', async () => {
  let completeRead;
  const f = await fixture(
    () =>
      new Promise((resolve) => {
        completeRead = resolve;
      }),
    { timeoutMs: 10 },
  );
  try {
    assert.deepEqual(await f.makeImporter().import(input), { kind: 'unavailable', reason: 'timeout' });
    completeRead({
      kind: 'chunk',
      requestId: input.requestId,
      offset: 0,
      dataBase64: Buffer.from('late bytes').toString('base64'),
      done: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(await f.ledger.findByImportKey('instance-1:event-1:photo', 'instance-1'), undefined);
  } finally {
    await f.close();
  }
});

test('missing or mismatched binding never invokes plugin', async () => {
  let invokes = 0;
  const f = await fixture(async () => {
    invokes += 1;
  });
  try {
    assert.deepEqual(await f.makeImporter().import({ ...input, ingressIdentity: 'foreign' }), {
      kind: 'unavailable',
      reason: 'unavailable',
    });
    assert.equal(invokes, 0);
  } finally {
    await f.close();
  }
});

test('real source callback publishes one final HMR envelope and settle retries after publication', async () => {
  const callbacks = [];
  let failSettle = true;
  const f = await fixture(async (_instanceId, method, params) => {
    callbacks.push({ method, params });
    if (method.endsWith('settle')) {
      if (failSettle) {
        failSettle = false;
        throw new Error('private settle token');
      }
      return { ok: true };
    }
    return {
      kind: 'chunk',
      requestId: params.requestId,
      offset: params.offset,
      dataBase64: Buffer.from('photo-bytes').toString('base64'),
      done: true,
    };
  });
  try {
    const importer = f.makeImporter();
    const messageStore = new MessageStore();
    const stage = new MemoryMediaStagingStore();
    const handleStore = new stores.MemoryHandleStore();
    const cursors = new stores.MemoryCursorStore();
    let pending;
    const handles = new HandleService(handleStore, cursors, {
      isUnpublished: (messageId) => pending.isUnpublished(messageId),
    });
    const events = new stores.MemoryEventLogStore();
    const ledger = new MessagingLedger(new stores.MemoryLedgerStore());
    const failures = [];
    let wakes = 0;
    const deps = {
      store: stage,
      messageStore,
      events,
      ledger,
      importer,
      onSettleFailure: (fields) => failures.push(fields),
      onPublished: () => {
        wakes += 1;
      },
    };
    pending = new PendingMediaPublication(deps);
    const service = new SendService({
      messageStore,
      handles,
      events,
      ledger,
      mediaPending: pending,
      mediaSources: {
        resolve: async (instanceId, sourceId, ingressIdentity) =>
          instanceId === input.instanceId && sourceId === input.sourceId && ingressIdentity === input.ingressIdentity,
      },
    });
    const { handleId } = await handles.issueThreadHandle({
      pluginInstanceId: input.instanceId,
      threadId: 'thread-media-e1b',
      userId: 'owner',
      scope: { canSend: true, canSubscribe: true },
    });
    const draft = {
      address: { kind: 'thread_handle', handle: handleId },
      idempotencyKey: 'idempotent-send',
      sourceEventId: input.sourceEventId,
      payload: {
        provenance: { epistemicStatus: 'observation' },
        elements: [
          { elementId: 'caption', kind: 'text', payload: { text: 'caption' } },
          {
            elementId: input.elementId,
            kind: 'media_ref',
            payload: {
              type: input.type,
              reference: input.reference,
              sourceId: input.sourceId,
            },
          },
        ],
      },
    };
    const context = { pluginInstanceId: input.instanceId };
    const receipt = await service.send(context, draft, {
      source: { connector: input.ingressIdentity, label: 'Media ingress', icon: 'message' },
    });
    assert.equal(receipt.pendingPublication, true);
    for (let i = 0; i < 100 && !(await stage.list())[0]?.published; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const row = (await stage.list())[0];
    assert.equal(row.published, true);
    assert.equal(row.media[0].settled, undefined);
    assert.equal(row.media[0].settleFailures, 1);
    assert.equal(failures.length, 1);
    assert.deepEqual(Object.keys(failures[0]).sort(), ['elementId', 'messageId']);
    assert.equal(wakes, 1);
    assert.equal(messageStore.size, 1);
    assert.equal((await events.readAfter('thread-media-e1b', 0, 10)).length, 1);
    const stored = messageStore.getById(receipt.messageId);
    assert.equal(stored.extra.pluginMessage.elements[0].kind, 'text');
    assert.equal(stored.extra.pluginMessage.elements[1].payload.sourceId, undefined);
    assert.match(stored.extra.pluginMessage.elements[1].payload.reference, /^hmr_/);
    assert.equal(
      (await f.ledger.readChunk(stored.extra.pluginMessage.elements[1].payload.reference, 0, 100)).dataBase64,
      Buffer.from('photo-bytes').toString('base64'),
    );
    await new PendingMediaPublication(deps).recover();
    assert.equal((await stage.list())[0].media[0].settled, true);
    assert.equal(wakes, 1);
    assert.equal(messageStore.size, 1);
    const reads = callbacks.filter((item) => item.method.endsWith('read'));
    const settles = callbacks.filter((item) => item.method.endsWith('settle'));
    assert.equal(reads.length, 1);
    assert.equal(settles.length, 2);
    assert.equal(settles[0].params.requestId, row.media[0].input.requestId);
    assert.deepEqual(settles[0].params, settles[1].params);
    assert.equal(settles[0].params.outcome, 'imported');
  } finally {
    await f.close();
  }
});

test('an admitted in-test media-source plugin is invoked through the production carrier and publishes once', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'media-source-e1b-project-'));
  const packageRoot = await mkdtemp(join(tmpdir(), 'media-source-e1b-package-'));
  const marker = `__mediaSourceE1b_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let runtime;
  try {
    const pluginId = 'dev.clowder.media-source-e1b-fixture';
    const contributions = [
      { type: 'identity', id: 'identity-1', displayName: 'Media fixture' },
      {
        type: 'connector',
        id: 'connector-1',
        identityRef: 'identity-1',
        inboundMethod: 'fixture.inbound',
        outboundMethod: 'fixture.outbound',
      },
      {
        type: 'media-source',
        id: 'source-1',
        binding: 'identity-1',
        readAction: { method: 'fixture.media.read' },
        settleAction: { method: 'fixture.media.settle' },
      },
    ];
    const packageManifest = {
      pluginId,
      version: '1.0.0',
      contractVersion: '0.1.0',
      name: 'Media source E2E fixture',
      features: [
        {
          id: 'main',
          name: 'Main',
          resources: [],
          contributions: contributions.map((item) => ({ type: item.type, id: item.id })),
          capabilities: ['plugin.state.get', 'plugin.state.set'],
        },
      ],
      contributions,
      runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
    };
    assert.equal(validateManifest(packageManifest).valid, true, JSON.stringify(validateManifest(packageManifest)));
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    await writeFile(join(packageRoot, 'manifest.json'), JSON.stringify(packageManifest));
    await writeFile(
      join(packageRoot, 'dist/plugin.js'),
      [
        `const state = (globalThis[${JSON.stringify(marker)}] ??= { reads: [], settles: [] });`,
        'export default { create() { return { start() { return { actions: {',
        "  'fixture.media.read': async (input) => { state.reads.push(input); const bytes = Buffer.from('real-plugin-bytes');",
        '    const chunk = bytes.subarray(input.offset, input.offset + 5); const done = input.offset + chunk.length >= bytes.length;',
        "    return { kind: 'chunk', requestId: input.requestId, offset: input.offset, dataBase64: chunk.toString('base64'),",
        '      ...(done ? {} : { nextOffset: input.offset + chunk.length }), done }; },',
        "  'fixture.media.settle': async (input) => { state.settles.push(input); return { ok: true }; },",
        '}, stop() {} }; } }; } };',
      ].join('\n'),
    );
    const messageStore = new MessageStore();
    let wakes = 0;
    runtime = createDormantPluginRuntimeComposition({
      projectRoot,
      routes: new MemorySignalRouteStore(),
      intakes: new MemoryMeetingIntakeStore(),
      messageStore,
      onMessagePublished: () => {
        wakes += 1;
      },
      contract: { manifestContractVersions: ['0.1.0'], validateEffectiveGrants, validateManifest },
    });
    const manager = createPluginManagerRuntimeComposition({
      runtime,
      catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
      catalogManifests: [],
    }).manager;
    const installed = await manager.install({ source: { kind: 'local-directory', path: packageRoot } });
    const beforeEnable = (await manager.get(installed.pluginId)).plugin;
    await manager.setEnabled(installed.pluginId, { enabled: true, expectedRevision: beforeEnable.lifecycleRevision });
    const { handleId } = await runtime.messaging.issueConnectorBindingHandle({
      pluginInstanceId: installed.pluginInstanceId,
      threadId: 'thread-real-source',
      userId: 'owner',
      connectorId: 'connector-1',
      externalChatId: 'external-chat-1',
      scope: { canSend: true, canSubscribe: true },
    });
    const receipt = await runtime.messaging.send(
      { pluginInstanceId: installed.pluginInstanceId },
      {
        address: { kind: 'connector_binding', handle: handleId },
        idempotencyKey: 'real-source-send',
        sourceEventId: 'event-real-source',
        payload: {
          provenance: { epistemicStatus: 'observation' },
          elements: [
            { elementId: 'caption', kind: 'text', payload: { text: 'caption' } },
            {
              elementId: 'photo',
              kind: 'media_ref',
              payload: { type: 'image', reference: 'pmr_real-source', sourceId: 'source-1' },
            },
          ],
        },
      },
    );
    assert.equal(receipt.pendingPublication, true);
    for (let i = 0; i < 200 && wakes < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(wakes, 1);
    assert.equal(messageStore.size, 1);
    const stored = messageStore.getById(receipt.messageId);
    const hmrId = stored.extra.pluginMessage.elements[1].payload.reference;
    assert.match(hmrId, /^hmr_/);
    assert.equal(
      (await runtime.mediaLedger.readChunk(hmrId, 0, 100)).dataBase64,
      Buffer.from('real-plugin-bytes').toString('base64'),
    );
    const state = globalThis[marker];
    for (let i = 0; i < 200 && state.settles.length < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(
      state.reads.map((item) => item.offset),
      [0, 5, 10, 15],
    );
    assert.deepEqual(
      state.settles.map((item) => item.outcome),
      ['imported'],
    );
    assert.equal(state.settles[0].requestId, state.reads[0].requestId);
  } finally {
    await runtime?.shutdown();
    delete globalThis[marker];
    await rm(projectRoot, { recursive: true, force: true });
    await rm(packageRoot, { recursive: true, force: true });
  }
});
