/**
 * F202 W2-5b — a Host message's audio / file / gallery blocks reach the plugin stream as Host
 * media references, published exactly once after materialization; the Hub never waits.
 *
 * Ledger acceptance items covered here: (1) refs per kind, one per gallery image, stable ids;
 * (2) same import key → same hmr; (3) append does not wait; (4) speech budget → card, still one
 * publish; (5) both crash windows converge on one event; (7) no locator in the envelope;
 * (8) external https → explicit text link; (9) snapshot: pending left to the stream, published
 * projected with the same media. (6) lives in f202-p1-media-delivery-b2; (10) is the cross-repo
 * gate slice.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';

let createPublishingMessageStore;
let createMessagingStores;
let createMessagingDomain;
let MessageStore;
let FileMessagingMediaLedger;
let MemoryOutboundMediaStore;
let OutboundMediaPublication;
let createHostMediaPathResolver;

const THREAD = 'thread-1';
let root;
let stores;
let inner;
let outbound;
let ledger;
let speech;
let publication;
let seam;
let failures;

function speechThat(behavior) {
  return {
    calls: 0,
    async synthesize(text, voice, signal) {
      this.calls += 1;
      return behavior(text, voice, signal);
    },
  };
}

function build({ speechBudgetMs = 1_000, synthesizer, retentionCount } = {}) {
  speech = synthesizer ?? speechThat(async () => ({ path: join(root, 'tts', 'voice-1.wav') }));
  publication = new OutboundMediaPublication({
    store: outbound,
    messages: inner,
    events: stores.events,
    ledger,
    resolvePath: createHostMediaPathResolver({
      uploadDir: join(root, 'uploads'),
      ttsCacheDir: join(root, 'tts'),
      connectorMediaDir: join(root, 'connector-media'),
      webPublicDir: join(root, 'web'),
    }),
    speech,
    speechBudgetMs,
    ...(retentionCount === undefined ? {} : { retentionCount }),
    onPublishFailure: (error) => failures.push(error),
  });
  seam = createPublishingMessageStore(inner, {
    events: stores.events,
    publications: stores.publications,
    outboundMedia: () => publication,
    onPublishFailure: (error) => failures.push(error),
  });
}

function catReply(blocks, overrides = {}) {
  return {
    threadId: THREAD,
    userId: 'user-1',
    catId: 'opus',
    content: 'here you go',
    timestamp: Date.now(),
    extra: { rich: { v: 1, blocks } },
    ...overrides,
  };
}

async function published() {
  return (await stores.events.readAfter(THREAD, 0, 50)).filter((e) => e.type === 'message.publish');
}

async function appendAndSettle(input) {
  const stored = await seam.append(input);
  await publication.schedule(stored.id);
  return stored;
}

/**
 * The settlement write (`publishing` → `published`) fails once — a crash or a disk error right
 * after the publish event landed. The row stays `publishing`; nothing past that write runs.
 */
function failSettlementOnce() {
  const update = outbound.update.bind(outbound);
  let failed = false;
  outbound.update = async (messageId, next) => {
    const current = await outbound.get(messageId);
    if (!failed && current && next(current).state === 'published') {
      failed = true;
      throw new Error('settlement write failed');
    }
    return update(messageId, next);
  };
}

beforeEach(async () => {
  ({ createPublishingMessageStore } = await import('../dist/domains/messaging/publishing-message-store.js'));
  ({ createMessagingStores } = await import('../dist/domains/messaging/stores/factory.js'));
  ({ createMessagingDomain } = await import('../dist/domains/messaging/messaging-service.js'));
  ({ MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js'));
  ({ FileMessagingMediaLedger } = await import('../dist/domains/messaging/media-ledger.js'));
  ({ MemoryOutboundMediaStore } = await import('../dist/domains/messaging/outbound-media/store.js'));
  ({ OutboundMediaPublication } = await import('../dist/domains/messaging/outbound-media/publication.js'));
  ({ createHostMediaPathResolver } = await import('../dist/domains/messaging/outbound-media/host-media-paths.js'));

  root = await mkdtemp(join(tmpdir(), 'f202-w2-5b-'));
  for (const dir of ['uploads', 'tts', 'connector-media', 'web']) await mkdir(join(root, dir));
  await writeFile(join(root, 'uploads', 'song.mp3'), 'song bytes');
  await writeFile(join(root, 'uploads', 'report.pdf'), 'pdf bytes');
  await writeFile(join(root, 'uploads', 'a.png'), 'png a');
  await writeFile(join(root, 'uploads', 'b.png'), 'png b');
  await writeFile(join(root, 'tts', 'voice-1.wav'), 'wav bytes');
  stores = createMessagingStores();
  inner = new MessageStore();
  outbound = new MemoryOutboundMediaStore();
  ledger = new FileMessagingMediaLedger(join(root, 'media'));
  failures = [];
  build();
});

describe('F202 W2-5b — outbound media for Host messages', () => {
  test('(1) audio, file and every gallery image become Host media refs with stable element ids', async () => {
    const stored = await appendAndSettle(
      catReply([
        { id: 'song', kind: 'audio', v: 1, url: '/uploads/song.mp3' },
        { id: 'note', kind: 'card', v: 1, title: 'note' },
        { id: 'doc', kind: 'file', v: 1, url: '/uploads/report.pdf', fileName: 'report.pdf' },
        {
          id: 'pics',
          kind: 'media_gallery',
          v: 1,
          items: [{ url: '/uploads/a.png' }, { url: '/uploads/b.png', alt: 'b' }],
        },
      ]),
    );

    const events = await published();
    assert.equal(events.length, 1);
    const elements = events[0].envelope.payload.elements;
    const id = stored.id;
    assert.deepEqual(
      elements.map((e) => [e.elementId, e.kind, e.payload.type ?? e.payload.kind ?? 'text']),
      [
        [`el_${id}_0`, 'text', 'text'],
        [`el_${id}_1`, 'media_ref', 'audio'],
        [`el_${id}_2`, 'rich_block', 'card'],
        [`el_${id}_3`, 'media_ref', 'file'],
        [`el_${id}_4_0`, 'media_ref', 'image'],
        [`el_${id}_4_1`, 'media_ref', 'image'],
      ],
    );
    for (const element of elements.filter((e) => e.kind === 'media_ref')) {
      assert.match(element.payload.reference, /^hmr_[A-Za-z0-9_-]{32}$/);
      assert.equal(element.payload.sourceId, undefined);
    }
    assert.equal(elements[3].payload.fileName, 'report.pdf');
    assert.deepEqual(failures, []);
  });

  test('(2) re-materializing the same block yields the same hmr', async () => {
    const stored = await appendAndSettle(
      catReply([{ id: 'doc', kind: 'file', v: 1, url: '/uploads/report.pdf', fileName: 'report.pdf' }]),
    );
    const first = (await outbound.get(stored.id)).elements;

    await outbound.update(stored.id, (row) => ({ ...row, state: 'pending', elements: undefined }));
    await publication.schedule(stored.id);

    assert.deepEqual((await outbound.get(stored.id)).elements, first);
    assert.equal((await published()).length, 1, 'the deterministic event key dedupes the second publish');
  });

  test('(3) the append returns before materialization; the stream waits, the Hub does not', async () => {
    let release;
    build({ synthesizer: speechThat(() => new Promise((resolve) => (release = resolve))) });

    const stored = await seam.append(catReply([{ id: 'voice', kind: 'audio', v: 1, url: '', text: 'hello there' }]));

    assert.equal((await inner.getById(stored.id)).content, 'here you go', 'the Hub reads it at once');
    assert.equal(stored.extra.mediaPublication, 'deferred');
    assert.equal((await published()).length, 0, 'nothing reaches the stream before its media');
    release({ path: join(root, 'tts', 'voice-1.wav') });
    await publication.schedule(stored.id);
    const [event] = await published();
    assert.equal(event.envelope.payload.elements[1].payload.type, 'audio');
  });

  test('(4) speech past the budget degrades to the voice card and still publishes exactly once', async () => {
    build({ speechBudgetMs: 20, synthesizer: speechThat(() => new Promise(() => {})) });

    const stored = await appendAndSettle(catReply([{ id: 'voice', kind: 'audio', v: 1, url: '', text: 'said aloud' }]));

    const events = await published();
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].envelope.payload.elements[1], {
      elementId: `el_${stored.id}_1`,
      kind: 'rich_block',
      payload: { id: 'voice', kind: 'card', v: 1, title: '🔊 语音', bodyMarkdown: 'said aloud' },
      epistemicStatus: 'inference',
    });
  });

  test('(5i) a message written with the marker but no row (crash) is adopted by recovery once', async () => {
    const stored = await inner.append({
      ...catReply([{ id: 'doc', kind: 'file', v: 1, url: '/uploads/report.pdf', fileName: 'report.pdf' }]),
      extra: {
        rich: { v: 1, blocks: [{ id: 'doc', kind: 'file', v: 1, url: '/uploads/report.pdf', fileName: 'report.pdf' }] },
        mediaPublication: 'deferred',
      },
    });

    await publication.recover();
    await publication.recover();

    assert.equal((await published()).length, 1);
    assert.equal((await outbound.get(stored.id)).state, 'published');
  });

  test('(5ii) a crash after the event but before `published` converges on the same one event', async () => {
    failSettlementOnce();
    const stored = await appendAndSettle(
      catReply([{ id: 'doc', kind: 'file', v: 1, url: '/uploads/report.pdf', fileName: 'report.pdf' }]),
    );
    assert.equal((await outbound.get(stored.id)).state, 'publishing');

    await publication.recover();

    assert.equal((await published()).length, 1);
    assert.equal((await outbound.get(stored.id)).state, 'published');
    assert.equal(failures.length, 1, 'only the injected settlement failure');
  });

  // Review P1 (…5828208840): the event log dedupes a key only while the event is retained. A
  // publish that landed, a settlement write that failed, and a trim in between let recovery append
  // the same `publish:<id>:1` again. The job's publish must carry a fence that outlives retention.
  test('(5iii) a failed settlement followed by an event-log trim still converges on one publish', async () => {
    build({ retentionCount: 1 });
    failSettlementOnce();
    const stored = await appendAndSettle(
      catReply([{ id: 'doc', kind: 'file', v: 1, url: '/uploads/report.pdf', fileName: 'report.pdf' }]),
    );
    const [first] = await published();
    await stores.events.append(
      THREAD,
      'publish:later:1',
      { eventId: 'ev_pub_later_1', type: 'message.publish', envelope: { ...first.envelope, messageId: 'later' } },
      1,
    );
    assert.equal((await outbound.get(stored.id)).state, 'publishing');

    await publication.recover();

    const again = (await stores.events.readAfter(THREAD, 0, 50)).filter((e) => e.envelope?.messageId === stored.id);
    assert.deepEqual(again, [], 'the trimmed publish must not be appended a second time');
    assert.equal((await outbound.get(stored.id)).state, 'published');
    assert.equal((await outbound.get(stored.id)).publishedSequence, first.sequence);
  });

  test('(7) the envelope carries no route, path, data URL or generation provenance', async () => {
    const png = `data:image/png;base64,${Buffer.from('inline png').toString('base64')}`;
    await appendAndSettle(
      catReply([
        { id: 'song', kind: 'audio', v: 1, url: '/uploads/song.mp3' },
        {
          id: 'gen',
          kind: 'media_gallery',
          v: 1,
          items: [{ url: '/uploads/a.png' }, { url: png }],
          provenance: { originalPath: '/private/source/original.png', prompt: 'secret prompt' },
        },
      ]),
    );

    const wire = JSON.stringify((await published())[0].envelope);
    for (const locator of ['/uploads/', root, 'data:', 'original.png', 'secret prompt']) {
      assert.equal(wire.includes(locator), false, `${locator} must not reach the wire`);
    }
  });

  // Review P1 (…5828208840): a failed block's fallback label came from the raw fileName, and the
  // callback schema accepts any non-empty fileName — a path there reached the wire.
  test('(7b) a failed or external block is labelled by base name only, never by a path-shaped fileName', async () => {
    await appendAndSettle(
      catReply([
        { id: 'gone', kind: 'file', v: 1, url: '/uploads/missing.pdf', fileName: '/private/secrets/report.pdf' },
        { id: 'ext', kind: 'file', v: 1, url: 'https://example.com/r.pdf', fileName: '/private/secrets/remote.pdf' },
      ]),
    );

    const wire = JSON.stringify((await published())[0].envelope);
    assert.equal(wire.includes('/private/secrets'), false, 'no path from fileName may reach the wire');
    assert.ok(wire.includes('[file: report.pdf]'), 'the reader still learns which file is missing');
    assert.ok(wire.includes('remote.pdf: https://example.com/r.pdf'));
  });

  // Re-review P1 (…5828779117): the successful media_ref still used the platform basename, so on a
  // POSIX Host a Windows path in fileName (`C:\\…\\report.pdf`) went out verbatim.
  test('(7c) POSIX and Windows path-shaped fileNames stay off the wire, on success and on failure', async () => {
    await appendAndSettle(
      catReply([
        { id: 'ok-posix', kind: 'file', v: 1, url: '/uploads/report.pdf', fileName: '/private/secrets/report.pdf' },
        { id: 'ok-win', kind: 'file', v: 1, url: '/uploads/report.pdf', fileName: 'C:\\private\\secrets\\report.pdf' },
        { id: 'gone-posix', kind: 'file', v: 1, url: '/uploads/missing.pdf', fileName: '/private/secrets/gone.pdf' },
        { id: 'gone-win', kind: 'file', v: 1, url: '/uploads/missing.pdf', fileName: 'C:\\private\\secrets\\gone.pdf' },
      ]),
    );

    const envelope = (await published())[0].envelope;
    const wire = JSON.stringify(envelope);
    for (const leak of ['private', 'secrets', 'C:', '\\\\']) {
      assert.equal(wire.includes(leak), false, `${leak} must not reach the wire`);
    }
    const [, okPosix, okWin, gonePosix, goneWin] = envelope.payload.elements;
    assert.equal(okPosix.payload.fileName, 'report.pdf');
    assert.equal(okWin.payload.fileName, 'report.pdf');
    assert.equal(gonePosix.payload.text, '[file: gone.pdf]');
    assert.equal(goneWin.payload.text, '[file: gone.pdf]');
  });

  // Re-review P1 (…5828779117): the fence must last as long as a `publishing` row can be retried,
  // and it is released once the publication is recorded — it is not left to a clock.
  test('(5iv) the publication fence is released only after `published` is recorded', async () => {
    const released = [];
    const events = {
      append: (...args) => stores.events.append(...args),
      releaseFence: async (threadId, key) => {
        released.push({ threadId, key, state: (await outbound.list())[0]?.state });
        return stores.events.releaseFence(threadId, key);
      },
    };
    publication = new OutboundMediaPublication({
      store: outbound,
      messages: inner,
      events,
      ledger,
      resolvePath: createHostMediaPathResolver({
        uploadDir: join(root, 'uploads'),
        ttsCacheDir: join(root, 'tts'),
        connectorMediaDir: join(root, 'connector-media'),
        webPublicDir: join(root, 'web'),
      }),
      onPublishFailure: (error) => failures.push(error),
    });
    seam = createPublishingMessageStore(inner, {
      events: stores.events,
      publications: stores.publications,
      outboundMedia: () => publication,
      onPublishFailure: (error) => failures.push(error),
    });

    const stored = await appendAndSettle(
      catReply([{ id: 'doc', kind: 'file', v: 1, url: '/uploads/report.pdf', fileName: 'report.pdf' }]),
    );

    assert.deepEqual(released, [{ threadId: THREAD, key: `publish:${stored.id}:1`, state: 'published' }]);
  });

  test('(8) an external https file becomes an explicit text link; nothing is fetched', async () => {
    const stored = await appendAndSettle(
      catReply([{ id: 'doc', kind: 'file', v: 1, url: 'https://example.com/report.pdf', fileName: 'report.pdf' }]),
    );

    const [event] = await published();
    assert.deepEqual(event.envelope.payload.elements[1], {
      elementId: `el_${stored.id}_1`,
      kind: 'text',
      payload: { text: 'report.pdf: https://example.com/report.pdf' },
      epistemicStatus: 'inference',
    });
  });

  test('(9) the snapshot leaves a pending media message to the stream and projects it once published', async () => {
    let release;
    build({ synthesizer: speechThat(() => new Promise((resolve) => (release = resolve))) });
    const messaging = createMessagingDomain({ messageStore: seam, stores, outboundMedia: outbound });
    const subscriber = { pluginInstanceId: 'subscriber' };
    const { handleId } = await messaging.issueThreadHandle({
      pluginInstanceId: 'subscriber',
      threadId: THREAD,
      userId: 'user-1',
      scope: { canSend: false, canSubscribe: true },
    });
    const { subscriptionId } = await messaging.subscribe(subscriber, handleId);

    const stored = await seam.append(catReply([{ id: 'voice', kind: 'audio', v: 1, url: '', text: 'hello' }]));
    assert.deepEqual((await messaging.snapshot(subscriber, subscriptionId)).envelopes, []);

    release({ path: join(root, 'tts', 'voice-1.wav') });
    await publication.schedule(stored.id);
    const { envelopes } = await messaging.snapshot(subscriber, subscriptionId);
    assert.deepEqual(envelopes, [(await published())[0].envelope]);
  });

  test('a whisper with media is neither deferred nor published', async () => {
    const stored = await seam.append(
      catReply([{ id: 'doc', kind: 'file', v: 1, url: '/uploads/report.pdf', fileName: 'report.pdf' }], {
        visibility: 'whisper',
        whisperTo: ['codex'],
      }),
    );

    assert.equal(stored.extra.mediaPublication, undefined);
    assert.equal(await outbound.get(stored.id), null);
    assert.equal((await published()).length, 0);
  });

  test('a message without media still publishes at append, untouched', async () => {
    const stored = await seam.append(catReply([{ id: 'note', kind: 'card', v: 1, title: 'note' }]));

    assert.equal(stored.extra.mediaPublication, undefined);
    assert.equal((await published()).length, 1);
  });
});
