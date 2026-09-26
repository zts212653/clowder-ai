import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { HandleService } = await import('../dist/domains/messaging/handles.js');
const { MessagingLedger } = await import('../dist/domains/messaging/ledger.js');
const { PendingMediaPublication } = await import('../dist/domains/messaging/media-pending-publication.js');
const { FileMessagingMediaLedger } = await import('../dist/domains/messaging/media-ledger.js');
const { createHostMediaPostProcessor } = await import('../dist/domains/messaging/media-post-processing.js');
const { MemoryMediaStagingStore, FileMediaStagingStore, mediaSourceMatchesIngress } = await import(
  '../dist/domains/messaging/media-staging.js'
);
const { SendService } = await import('../dist/domains/messaging/send-service.js');
const stores = await import('../dist/domains/messaging/stores/memory.js');

const ctx = { pluginInstanceId: 'media-instance' };
const source = { connector: 'identity-1', label: 'Media ingress', icon: 'message' };

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function harness({
  importer,
  postProcess,
  staging = new MemoryMediaStagingStore(),
  clock = () => Date.now(),
  deadlineMs = 120_000,
} = {}) {
  const messageStore = new MessageStore();
  const handleStore = new stores.MemoryHandleStore();
  const cursors = new stores.MemoryCursorStore();
  let pending;
  const handles = new HandleService(handleStore, cursors, {
    isUnpublished: (messageId) => pending.isUnpublished(messageId),
  });
  const ledger = new MessagingLedger(new stores.MemoryLedgerStore());
  const events = new stores.MemoryEventLogStore();
  const published = [];
  pending = new PendingMediaPublication({
    store: staging,
    messageStore,
    ledger,
    events,
    importer,
    postProcess,
    now: clock,
    deadlineMs,
    onPublished: (threadId) => published.push(threadId),
  });
  const service = new SendService({
    messageStore,
    handles,
    ledger,
    events,
    mediaPending: pending,
    mediaSources: {
      resolve: async (instance, sourceId, identity) =>
        instance === ctx.pluginInstanceId && sourceId === 'source-1' && identity === 'identity-1',
    },
  });
  const { handleId } = await handles.issueThreadHandle({
    pluginInstanceId: ctx.pluginInstanceId,
    threadId: 'thread-media',
    userId: 'owner',
    scope: { canSend: true, canSubscribe: true },
  });
  const draft = {
    address: { kind: 'thread_handle', handle: handleId },
    idempotencyKey: 'idem-1',
    sourceEventId: 'event-1',
    payload: {
      provenance: { epistemicStatus: 'observation' },
      elements: [
        { elementId: 'caption', kind: 'text', payload: { text: 'caption' } },
        {
          elementId: 'photo',
          kind: 'media_ref',
          payload: { type: 'image', reference: 'pmr_opaque', sourceId: 'source-1', fileName: 'photo.png' },
        },
      ],
    },
  };
  return { service, draft, pending, messageStore, events, published, handles, staging, ledger, handleId };
}

async function until(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('asynchronous media publication did not finish');
}

test('media-source binding resolves only through a declared ingress identity', () => {
  const manifest = {
    contributions: [
      { type: 'identity', id: 'approved-identity' },
      { type: 'connector', id: 'approved-connector', identityRef: 'approved-identity' },
      { type: 'message-subscription', id: 'approved-subscription', binding: 'approved-identity' },
      { type: 'media-source', id: 'approved-source', binding: 'approved-identity' },
      { type: 'media-source', id: 'other-source', binding: 'other-identity' },
    ],
  };
  assert.equal(mediaSourceMatchesIngress(manifest, 'approved-source', 'approved-connector'), true);
  assert.equal(mediaSourceMatchesIngress(manifest, 'approved-source', 'approved-subscription'), true);
  assert.equal(mediaSourceMatchesIngress(manifest, 'approved-source', 'approved-identity'), true);
  assert.equal(mediaSourceMatchesIngress(manifest, 'other-source', 'approved-connector'), false);
  assert.equal(mediaSourceMatchesIngress(manifest, 'missing-source', 'approved-connector'), false);
  assert.equal(mediaSourceMatchesIngress(manifest, 'other-source', 'other-identity'), false);
});

test('PMR send returns a pending receipt while no message/event exists, then publishes one final envelope', async () => {
  const gate = deferred();
  let imports = 0;
  const h = await harness({
    importer: {
      import: () => {
        imports += 1;
        return gate.promise;
      },
    },
  });
  const receipt = await h.service.send(ctx, h.draft, { source });
  assert.equal(receipt.pendingPublication, true);
  assert.equal(receipt.publishSequence, undefined);
  assert.equal(h.messageStore.size, 0);
  assert.deepEqual(await h.events.readAfter('thread-media', 0, 10), []);
  await assert.rejects(h.handles.resolveForAppend(ctx.pluginInstanceId, receipt.messageHandle), {
    code: 'MESSAGE_NOT_PUBLISHED',
  });
  assert.deepEqual(await h.service.send(ctx, h.draft, { source }), receipt);
  assert.equal((await h.staging.list()).length, 1);
  assert.equal(typeof (await h.staging.list())[0].createdAt, 'number');
  gate.resolve({ kind: 'imported', hmrId: 'hmr_host-owned' });
  await until(() => h.messageStore.size === 1 && h.published.length === 1);
  const message = h.messageStore.getById(receipt.messageId);
  assert.ok(message);
  assert.equal(message.content, 'caption\n[media_ref:photo]');
  assert.equal(message.extra.pluginMessage.elements[1].payload.reference, 'hmr_host-owned');
  assert.equal(message.extra.pluginMessage.elements[1].payload.sourceId, undefined);
  assert.equal((await h.events.readAfter('thread-media', 0, 10)).length, 1);
  assert.equal((await h.staging.list())[0].published, true);
  assert.equal(imports, 1);
});

test('a terminal importer failure publishes text with a typed unavailable element', async () => {
  const h = await harness({ importer: { import: async () => ({ kind: 'unavailable', reason: 'source_expired' }) } });
  const receipt = await h.service.send(ctx, h.draft, { source });
  await until(() => h.messageStore.size === 1 && h.published.length === 1);
  const stored = h.messageStore.getById(receipt.messageId);
  assert.equal(stored.extra.pluginMessage.elements[1].kind, 'media_unavailable');
  assert.equal(stored.extra.pluginMessage.elements[1].payload.reason, 'source_expired');
  assert.equal(stored.content.startsWith('caption'), true);
  assert.equal((await h.events.readAfter('thread-media', 0, 10)).length, 1);
});

test('post-processing enriches the one durable publication before wake without losing the HMR', async () => {
  const processed = [];
  const hmrId = `hmr_${'a'.repeat(32)}`;
  const h = await harness({
    importer: { import: async () => ({ kind: 'imported', hmrId }) },
    postProcess: async (imported) => {
      processed.push(imported);
      return {
        warnings: [
          {
            elementId: 'warning-photo',
            kind: 'media_warning',
            payload: { mediaElementId: 'photo', stage: 'preview', reason: 'processing_failed' },
          },
        ],
        contentBlocks: [{ type: 'image', url: `hmr:${hmrId}` }],
        transcript: 'recognized speech',
      };
    },
  });
  const receipt = await h.service.send(ctx, h.draft, { source });
  await until(() => h.messageStore.size === 1 && h.published.length === 1);
  const stored = h.messageStore.getById(receipt.messageId);
  assert.deepEqual(processed, [[{ elementId: 'photo', hmrId, type: 'image', fileName: 'photo.png' }]]);
  assert.equal(stored.extra.pluginMessage.elements[1].payload.reference, hmrId);
  assert.deepEqual(stored.extra.pluginMessage.elements.at(-1), {
    elementId: 'warning-photo',
    kind: 'media_warning',
    payload: { mediaElementId: 'photo', stage: 'preview', reason: 'processing_failed' },
  });
  assert.deepEqual(stored.contentBlocks, [{ type: 'image', url: `hmr:${hmrId}` }]);
  assert.equal(stored.content.endsWith('\nrecognized speech'), true);
  assert.equal((await h.events.readAfter('thread-media', 0, 10)).length, 1);
});

test('file and video publish filename/type placeholders without exposing either reference', async () => {
  const h = await harness({ importer: { import: async () => ({ kind: 'imported', hmrId: `hmr_${'f'.repeat(32)}` }) } });
  const draft = {
    ...h.draft,
    payload: {
      ...h.draft.payload,
      elements: [
        h.draft.payload.elements[0],
        {
          elementId: 'file-1',
          kind: 'media_ref',
          payload: { type: 'file', fileName: 'notes.pdf', reference: 'pmr_file', sourceId: 'source-1' },
        },
        {
          elementId: 'video-1',
          kind: 'media_ref',
          payload: { type: 'video', fileName: 'demo.mp4\npmr_secret', reference: 'pmr_video', sourceId: 'source-1' },
        },
      ],
    },
  };
  const receipt = await h.service.send(ctx, draft, { source });
  await until(() => h.messageStore.size === 1 && h.published.length === 1);
  const stored = h.messageStore.getById(receipt.messageId);
  assert.match(stored.content, /\[file: notes\.pdf\]/);
  assert.match(stored.content, /\[video: demo\.mp4 \[redacted\]\]/);
  assert.equal(stored.content.includes('[media_ref:file-1]'), false);
  assert.equal(stored.content.includes('[media_ref:video-1]'), false);
  assert.equal(stored.content.includes('pmr_'), false);
  assert.equal(stored.content.includes('hmr_'), false);
  assert.equal((await h.events.readAfter('thread-media', 0, 10)).length, 1);
});

test('post-processing timeout retains HMR with warning and publishes only once', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f202-e2-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const media = new FileMessagingMediaLedger(join(root, 'media'));
  const hmrId = await media.register(Buffer.from('audio bytes'));
  const h = await harness({
    importer: { import: async () => ({ kind: 'imported', hmrId }) },
    postProcess: createHostMediaPostProcessor({
      ledger: media,
      privateDir: join(root, 'private'),
      stageTimeoutMs: 10,
      sttProvider: { transcribe: async () => new Promise(() => {}) },
    }),
  });
  const draft = {
    ...h.draft,
    payload: {
      ...h.draft.payload,
      elements: [
        h.draft.payload.elements[0],
        {
          elementId: 'voice',
          kind: 'media_ref',
          payload: { type: 'audio', reference: 'pmr_voice', sourceId: 'source-1' },
        },
      ],
    },
  };
  const receipt = await h.service.send(ctx, draft, { source });
  await until(() => h.messageStore.size === 1 && h.published.length === 1);
  const stored = h.messageStore.getById(receipt.messageId);
  assert.equal(stored.extra.pluginMessage.elements[1].payload.reference, hmrId);
  assert.deepEqual(stored.extra.pluginMessage.elements[2].payload, {
    mediaElementId: 'voice',
    stage: 'transcription',
    reason: 'timeout',
  });
  assert.equal((await h.events.readAfter('thread-media', 0, 10)).length, 1);
  assert.deepEqual(await readdir(join(root, 'private')), []);
});

test('an unavailable source is settled only after the unavailable message is durably published', async () => {
  const settlements = [];
  let h;
  h = await harness({
    importer: {
      import: async () => ({ kind: 'unavailable', reason: 'source_expired' }),
      settle: async (_input, outcome) =>
        settlements.push({
          outcome,
          published: (await h.staging.list())[0].published,
          messages: h.messageStore.size,
        }),
    },
  });
  await h.service.send(ctx, h.draft, { source });
  await until(() => settlements.length === 1);
  assert.deepEqual(settlements, [{ outcome: 'unavailable', published: true, messages: 1 }]);
});

test('unknown or mismatched media-source fails before staging', async () => {
  const h = await harness();
  await assert.rejects(
    h.service.send(
      ctx,
      {
        ...h.draft,
        payload: {
          ...h.draft.payload,
          elements: [
            h.draft.payload.elements[0],
            {
              ...h.draft.payload.elements[1],
              payload: { ...h.draft.payload.elements[1].payload, sourceId: 'unknown' },
            },
          ],
        },
      },
      { source },
    ),
    { code: 'VALIDATION' },
  );
  await assert.rejects(
    h.service.send(
      ctx,
      { ...h.draft, idempotencyKey: 'idem-2' },
      { source: { ...source, connector: 'other-identity' } },
    ),
    { code: 'VALIDATION' },
  );
  assert.deepEqual(await h.staging.list(), []);
});

test('distinct send idempotency keys keep separate staged messages for one source event', async () => {
  const h = await harness();
  const first = await h.service.send(ctx, h.draft, { source });
  const second = await h.service.send(ctx, { ...h.draft, idempotencyKey: 'another-send' }, { source });
  assert.notEqual(first.messageId, second.messageId);
  assert.equal((await h.staging.list()).length, 2);
  for (const row of await h.staging.list()) await h.pending.expire(row.key);
  assert.equal(h.messageStore.size, 2);
  assert.equal((await h.events.readAfter('thread-media', 0, 10)).length, 2);
});

test('a staged retry returns its accepted receipt even after the address handle is revoked', async () => {
  const h = await harness();
  const settle = h.ledger.settleSend.bind(h.ledger);
  let failOnce = true;
  h.ledger.settleSend = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('simulated crash before receipt settlement');
    }
    return settle(...args);
  };
  await assert.rejects(h.service.send(ctx, h.draft, { source }), /simulated crash/);
  const accepted = (await h.staging.list())[0].receipt;
  await h.handles.revoke(h.handleId);
  assert.deepEqual(await h.service.send(ctx, h.draft, { source }), accepted);
  assert.equal((await h.staging.list()).length, 1);
});

test('deadline publishes timeout once; a late importer cannot rewrite it', async () => {
  const gate = deferred();
  let now = Date.now();
  const h = await harness({ importer: { import: () => gate.promise }, clock: () => now, deadlineMs: 1000 });
  const receipt = await h.service.send(ctx, h.draft, { source });
  now += 1001;
  await h.pending.expire((await h.staging.list())[0].key);
  gate.resolve({ kind: 'imported', hmrId: 'hmr_too_late' });
  await until(() => h.messageStore.size === 1);
  const stored = h.messageStore.getById(receipt.messageId);
  assert.equal(stored.extra.pluginMessage.elements[1].kind, 'media_unavailable');
  assert.equal(stored.extra.pluginMessage.elements[1].payload.reason, 'timeout');
  assert.equal((await h.events.readAfter('thread-media', 0, 10)).length, 1);
});

test('without the e1b importer, the deadline timer reaches an honest unavailable terminal state', async () => {
  const h = await harness({ deadlineMs: 20 });
  const receipt = await h.service.send(ctx, h.draft, { source });
  await until(() => h.messageStore.size === 1 && h.published.length === 1);
  assert.equal(h.messageStore.getById(receipt.messageId).extra.pluginMessage.elements[1].payload.reason, 'timeout');
  assert.equal((await h.events.readAfter('thread-media', 0, 10)).length, 1);
});

test('file staging survives service reconstruction; uninstall finalizes an unavailable element', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-stage-e1a-'));
  try {
    const path = join(root, 'staging.json');
    const h = await harness({ staging: new FileMediaStagingStore(path) });
    const receipt = await h.service.send(ctx, h.draft, { source });
    assert.equal(h.messageStore.size, 0);
    assert.equal((await readFile(path, 'utf8')).includes(receipt.messageId), true);
    const resumed = new PendingMediaPublication({
      store: new FileMediaStagingStore(path),
      messageStore: h.messageStore,
      ledger: new MessagingLedger(new stores.MemoryLedgerStore()),
      events: h.events,
      onPublished: (threadId) => h.published.push(threadId),
    });
    await resumed.uninstall(ctx.pluginInstanceId);
    assert.equal(
      h.messageStore.getById(receipt.messageId).extra.pluginMessage.elements[1].payload.reason,
      'unavailable',
    );
    await resumed.recover();
    assert.equal(h.messageStore.size, 1);
    assert.equal(h.published.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('file staging resumes an unfinished import under the same reserved message id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'media-stage-recover-'));
  try {
    const path = join(root, 'staging.json');
    const h = await harness({ staging: new FileMediaStagingStore(path) });
    const receipt = await h.service.send(ctx, h.draft, { source });
    const resumed = new PendingMediaPublication({
      store: new FileMediaStagingStore(path),
      messageStore: h.messageStore,
      ledger: h.ledger,
      events: h.events,
      importer: { import: async () => ({ kind: 'imported', hmrId: 'hmr_after_restart' }) },
      onPublished: (threadId) => h.published.push(threadId),
    });
    await resumed.recover();
    await until(
      async () =>
        h.messageStore.size === 1 &&
        h.published.length === 1 &&
        (await resumed.get((await h.staging.list())[0].key))?.published === true,
    );
    assert.equal(
      h.messageStore.getById(receipt.messageId).extra.pluginMessage.elements[1].payload.reference,
      'hmr_after_restart',
    );
    assert.equal((await h.events.readAfter('thread-media', 0, 10)).length, 1);
    assert.deepEqual(h.published, ['thread-media']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovery wakes downstream delivery after a crash between publish event and drain', async () => {
  const h = await harness();
  const receipt = await h.service.send(ctx, h.draft, { source });
  const stage = (await h.staging.list())[0];
  await h.staging.update(stage.key, (row) => ({
    ...row,
    media: row.media.map((media) => ({ ...media, result: { kind: 'imported', hmrId: 'hmr_recovered' } })),
  }));
  const crashy = new PendingMediaPublication({
    store: h.staging,
    messageStore: h.messageStore,
    ledger: h.ledger,
    events: h.events,
    onPublished: () => {
      throw new Error('simulated crash before drain');
    },
  });
  await assert.rejects(crashy.finalize(stage.key), /simulated crash/);
  assert.equal(h.messageStore.size, 1);
  assert.equal((await h.events.readAfter('thread-media', 0, 10)).length, 1);
  assert.equal((await h.staging.list())[0].published, false);
  const recovered = new PendingMediaPublication({
    store: h.staging,
    messageStore: h.messageStore,
    ledger: h.ledger,
    events: h.events,
    onPublished: (threadId) => h.published.push(threadId),
  });
  await recovered.recover();
  assert.equal(
    h.messageStore.getById(receipt.messageId).extra.pluginMessage.elements[1].payload.reference,
    'hmr_recovered',
  );
  assert.deepEqual(h.published, ['thread-media']);
  assert.equal((await h.events.readAfter('thread-media', 0, 10)).length, 1);
  assert.equal((await h.staging.list())[0].published, true);
});

test('recovery publishes a reserved message after a crash between message append and event append', async () => {
  const h = await harness();
  const receipt = await h.service.send(ctx, h.draft, { source });
  const stage = (await h.staging.list())[0];
  await h.staging.update(stage.key, (row) => ({
    ...row,
    media: row.media.map((media) => ({ ...media, result: { kind: 'imported', hmrId: 'hmr_after_append' } })),
  }));
  const append = h.messageStore.append.bind(h.messageStore);
  let failOnce = true;
  h.messageStore.append = (input) => {
    const stored = append(input);
    if (failOnce) {
      failOnce = false;
      throw new Error('simulated crash after message append');
    }
    return stored;
  };
  await assert.rejects(h.pending.finalize(stage.key), /simulated crash/);
  assert.equal(h.messageStore.size, 1);
  assert.deepEqual(await h.events.readAfter('thread-media', 0, 10), []);
  await h.pending.recover();
  assert.equal(h.messageStore.size, 1);
  assert.equal((await h.events.readAfter('thread-media', 0, 10)).length, 1);
  assert.deepEqual(h.published, ['thread-media']);
  assert.equal(
    h.messageStore.getById(receipt.messageId).extra.pluginMessage.elements[1].payload.reference,
    'hmr_after_append',
  );
});
