import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';

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

const manifest = {
  contributions: [
    { type: 'identity', id: 'identity-1' },
    { type: 'connector', id: 'connector-1', identityRef: 'identity-1' },
    {
      type: 'media-source',
      id: 'source-1',
      binding: 'identity-1',
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

async function fixture(read, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'media-source-e1b-'));
  const ledger = new FileMessagingMediaLedger(join(root, 'media'));
  const makeImporter = (extra = {}) =>
    new HostMediaSourceImporter({
      ledger,
      resolveManifest: async (instanceId) => (instanceId === input.instanceId ? manifest : undefined),
      read,
      ...options,
      ...extra,
    });
  return { root, ledger, makeImporter, close: () => rm(root, { recursive: true, force: true }) };
}

test('stream chunks materialize one durable HMR without a settlement callback', async () => {
  let reads = 0,
    released = 0;
  const bytes = Buffer.from('hello media');
  const f = await fixture(async function* (_instance, reference) {
    assert.equal(reference, input.reference);
    reads++;
    try {
      yield bytes.subarray(0, 4);
      yield bytes.subarray(4);
    } finally {
      released++;
    }
  });
  try {
    const result = await f.makeImporter().import(input);
    assert.equal(result.kind, 'imported');
    assert.equal((await f.ledger.readChunk(result.hmrId, 0, 100)).dataBase64, bytes.toString('base64'));
    assert.deepEqual(await f.makeImporter().import(input), result);
    assert.equal(reads, 1);
    assert.equal(released, 1);
    assert.equal('settle' in f.makeImporter(), false);
    const record = await readFile(join(f.root, 'media', 'records', `${result.hmrId}.json`), 'utf8');
    assert.equal(record.includes(input.reference), false);
  } finally {
    await f.close();
  }
});

test('source rejection, invalid stream bytes and byte cap map to unavailable', async () => {
  for (const [value, expected, options] of [
    [Object.assign(new Error('expired'), { code: 'MEDIA_SOURCE_UNAVAILABLE' }), 'source_expired', {}],
    ['not bytes', 'unavailable', {}],
    [Buffer.from('too big'), 'unavailable', { maxBytes: 3 }],
    [new Error('private credentials'), 'unavailable', {}],
  ]) {
    const f = await fixture(async function* () {
      if (value instanceof Error) throw value;
      yield value;
    }, options);
    try {
      assert.deepEqual(await f.makeImporter().import(input), { kind: 'unavailable', reason: expected });
    } finally {
      await f.close();
    }
  }
});

test('reader deadline aborts without materializing late bytes', async () => {
  let completeRead, signalSeen;
  const f = await fixture(
    async function* (_id, _ref, { signal }) {
      signalSeen = signal;
      await new Promise((resolve) => {
        completeRead = resolve;
      });
      yield Buffer.from('late bytes');
    },
    { timeoutMs: 10 },
  );
  try {
    assert.deepEqual(await f.makeImporter().import(input), { kind: 'unavailable', reason: 'timeout' });
    assert.equal(signalSeen.aborted, true);
    completeRead();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await f.ledger.findByImportKey('instance-1:event-1:photo', 'instance-1'), undefined);
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

test('real source stream publishes one final HMR envelope and recovery does not re-read it', async () => {
  let reads = 0;
  const f = await fixture(async function* () {
    reads++;
    yield Buffer.from('photo-bytes');
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
    let wakes = 0;
    const deps = {
      store: stage,
      messageStore,
      events,
      ledger,
      importer,
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
    assert.equal('settled' in row.media[0], false);
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
    assert.equal(wakes, 1);
    assert.equal(messageStore.size, 1);
    assert.equal(reads, 1);
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
      `const state=(globalThis[${JSON.stringify(marker)}] ??= {reads:[],released:0});
      export default {create(){return {start(){return {actions:{},streams:{async *read(reference){state.reads.push(reference); try{yield Buffer.from('real-plugin-bytes');}finally{state.released++;}}},stop(){}};}};}};`,
    );
    const messageStore = new MessageStore();
    let wakes = 0;
    runtime = createDormantPluginRuntimeComposition({
      projectRoot,
      messageStore,
      onMessagePublished: () => {
        wakes += 1;
      },
      contract: { manifestContractRange: '0.1.0', validateManifest },
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
    assert.deepEqual(state.reads, ['pmr_real-source']);
    assert.equal(state.released, 1);
  } finally {
    await runtime?.shutdown();
    delete globalThis[marker];
    await rm(projectRoot, { recursive: true, force: true });
    await rm(packageRoot, { recursive: true, force: true });
  }
});
