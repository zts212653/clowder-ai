import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ProjectScreeningContextAttachment, VideoProjectScreening } from '@cat-cafe/shared';
import { mapScreeningMediaRange } from '@cat-cafe/shared';
import {
  deriveGrowingSourceMessageRevision,
  MessageStore,
} from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { VideoProjectMessageImporter } from '../src/domains/collaborative-content/workspace-review/project-message/import.js';
import { adaptMessageStore } from './helpers/message-from-fixtures.js';
import { screeningFixture } from './helpers/video-project-screening.js';

function attachment(screening: VideoProjectScreening): ProjectScreeningContextAttachment {
  const range = {
    startPts: screening.media.media.startTick,
    endPts: screening.media.media.startTick + screening.media.media.durationTicks,
  };
  const ticks = mapScreeningMediaRange(screening, range);
  assert.ok(ticks);
  return {
    v: 1,
    kind: 'project-screening',
    id: 'attachment-1',
    title: 'Selected film range',
    contentRef: screening.input.contentRef,
    screeningId: screening.id,
    input: screening.input,
    media: {
      contentRef: screening.media.contentRef,
      ownerRevision: screening.media.ownerRevision,
      blobDigest: screening.media.blobDigest,
    },
    selections: [
      {
        id: 'selection-1',
        mediaRange: range,
        target: {
          kind: 'moment',
          tick: ticks.startTick,
          endTick: ticks.endTick,
          timebase: { numerator: 1, denominator: 30 },
        },
      },
    ],
  };
}
async function setup() {
  const f = await screeningFixture();
  const { screening } = await f.make().register(f.request);
  const messages = adaptMessageStore(new MessageStore());
  const path = join(f.dataDir, 'artifact-reviews.sqlite');
  let store = new ArtifactReviewStore(path);
  let allowed = true;
  const authority = {
    messages,
    authorizeSource: async () => {
      if (!allowed) throw new Error('Thread access revoked');
    },
  };
  const make = () =>
    new VideoProjectMessageImporter({ store: store.ledgers, projects: f.projects, screenings: f.make(), authority });
  const append = (selection = attachment(screening), extra = {}) =>
    messages.append({
      userId: f.principal.userId,
      catId: null,
      content: 'Please fix this selected range',
      mentions: [],
      threadId: 'thread-1',
      timestamp: Date.now(),
      contentBlocks: [{ type: 'context_attachment', attachment: selection }],
      ...extra,
    });
  return {
    ...f,
    screening,
    screenings: f.make(),
    messages,
    make,
    append,
    get store() {
      return store;
    },
    revoke() {
      allowed = false;
    },
    restart() {
      store.close();
      store = new ArtifactReviewStore(path);
      return make();
    },
    async cleanup() {
      store.close();
      await f.cleanup();
    },
  };
}
function sourceInput(f: Awaited<ReturnType<typeof setup>>, message: ReturnType<MessageStore['append']>) {
  return {
    principal: f.principal,
    contentRef: f.request.contentRef,
    threadId: message.threadId,
    messageId: message.id,
    messageRevision: deriveGrowingSourceMessageRevision(message),
    attachmentId: 'attachment-1',
    selectionId: 'selection-1',
  };
}

test('F326 actual sent Human source imports a frozen old input, atomically receipts and replays across SQLite restart', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const before = await f.projects.load(f.request);
  const changed = structuredClone(before.document);
  changed.title = 'Later project head';
  await f.projects.save({
    ...f.request,
    expectedOwnerRevision: before.ownerRevision,
    operationId: 'change-head',
    document: changed,
  });
  const message = f.append();
  const input = sourceInput(f, message);
  const imported = await f.make().import(input);
  assert.equal(imported.review.annotations.length, 1);
  const annotation = imported.review.annotations[0];
  assert.ok(annotation);
  assert.equal(annotation.body, message.content);
  assert.deepEqual(annotation.author, f.principal.actor);
  assert.equal(annotation.anchor.kind, 'video-project');
  assert.equal('baseOwnerRevision' in annotation.anchor && annotation.anchor.baseOwnerRevision, 1);
  assert.equal(imported.review.source.kind === 'video-project' && imported.review.source.ownerRevision, 1);
  assert.equal(annotation.projectMessage?.source.messageRevision, input.messageRevision);
  const replay = await f.restart().import(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.review.revision, imported.review.revision);
  assert.equal(replay.review.annotations.length, 1);
  assert.equal(replay.receipt.receiptRef, imported.receipt.receiptRef);
  assert.equal((await f.messages.getByThreadAfter('thread-1')).length, 1, 'import never sends another message');
});

for (const kind of ['queued', 'canceled', 'cat', 'connector', 'recalled'] as const)
  test(`F326 ${kind} source is not an original delivered Human opinion`, async (t) => {
    const f = await setup();
    t.after(f.cleanup);
    const message = f.append(
      attachment(f.screening),
      kind === 'cat'
        ? { catId: 'sol' }
        : kind === 'connector'
          ? { sourceParseFailure: true }
          : kind === 'recalled'
            ? { recall: { recalledAt: Date.now(), sourceMessageId: 'x' } }
            : { deliveryStatus: 'queued' },
    );
    if (kind === 'canceled') await f.messages.markCanceled(message.id);
    await assert.rejects(f.make().import(sourceInput(f, message)), { code: 'invalid_action' });
    assert.equal(f.store.ledgers.getByContent(f.principal.userId, f.request.contentRef), null);
  });

test('F326 binding checks reject client input/media/target spoofing and unknown mappings', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  for (const field of ['input', 'media', 'target'] as const) {
    const chip = attachment(f.screening);
    const selection = chip.selections[0];
    assert.ok(selection);
    if (field === 'target')
      selection.target = {
        kind: 'moment',
        tick: 40,
        endTick: 50,
        timebase: { numerator: 1, denominator: 30 },
      };
    else chip[field] = { ...chip[field], blobDigest: `sha256:${'f'.repeat(64)}` };
    const message = f.append(chip);
    await assert.rejects(f.make().import(sourceInput(f, message)), { code: 'invalid_action' });
  }
});

test('F326 recovery scans persistent pages without skipping a failed page and replays previous success once', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  for (let i = 0; i < 4; i++)
    f.messages.append({
      userId: f.principal.userId,
      catId: null,
      content: `unrelated-${i}`,
      mentions: [],
      threadId: 'thread-1',
      timestamp: Date.now(),
    });
  const first = f.append();
  const second = f.append();
  const importer = f.make();
  const one = await importer.synchronize({
    principal: f.principal,
    contentRef: f.request.contentRef,
    threadId: 'thread-1',
    limit: 4,
  });
  assert.equal(one.imported, 0);
  assert.equal(one.scanned, 4);
  assert.equal(one.hasMore, true);
  const cursor = one.cursor;
  const save = f.store.ledgers.mutate.bind(f.store.ledgers);
  let fail = true;
  f.store.ledgers.mutate = (input, transition) => {
    if (fail && input.kind === 'import:project-message' && JSON.stringify(input.request).includes(second.id)) {
      fail = false;
      throw new Error('SQLite temporarily unavailable');
    }
    return save(input, transition);
  };
  await assert.rejects(
    importer.synchronize({ principal: f.principal, contentRef: f.request.contentRef, threadId: 'thread-1', limit: 4 }),
    /temporarily unavailable/,
  );
  assert.equal(f.store.ledgers.projectMessageImports.get(f.principal.userId, f.request.contentRef, 'thread-1'), cursor);
  assert.equal(f.store.ledgers.getByContent(f.principal.userId, f.request.contentRef)?.annotations.length, 1);
  const completed = await f
    .restart()
    .synchronize({ principal: f.principal, contentRef: f.request.contentRef, threadId: 'thread-1', limit: 4 });
  assert.equal(completed.imported, 2);
  assert.equal(completed.hasMore, false);
  const review = f.store.ledgers.getByContent(f.principal.userId, f.request.contentRef);
  assert.ok(review);
  assert.equal(review.annotations.length, 2);
  assert.equal(review.annotations.filter((item) => item.projectMessage?.source.messageId === first.id).length, 1);
  assert.equal(
    (await f.restart().synchronize({ principal: f.principal, contentRef: f.request.contentRef, threadId: 'thread-1' }))
      .scanned,
    0,
  );
});

test('F326 revoked current source authority blocks original import and durable recovery', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const message = f.append();
  f.revoke();
  await assert.rejects(f.make().import(sourceInput(f, message)), /revoked/);
  await assert.rejects(
    f.make().synchronize({ principal: f.principal, contentRef: f.request.contentRef, threadId: 'thread-1' }),
    /revoked/,
  );
  assert.equal(
    f.store.ledgers.projectMessageImports.get(f.principal.userId, f.request.contentRef, 'thread-1'),
    undefined,
  );
});

test('F326 decoded display box and mapped canvas box stay distinct through actual import', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const chip = attachment(f.screening);
  const selection = chip.selections[0];
  assert.ok(selection);
  selection.displayRegion = {
    coordinateSpace: 'display-pixels',
    width: 160,
    height: 96,
    rotation: 0,
    bbox: { x: 10, y: 12, width: 30, height: 24 },
  };
  const canvas = {
    coordinateSpace: 'canvas-pixels' as const,
    width: 1920,
    height: 1080,
    rotation: 0 as const,
    bbox: { x: 120, y: 135, width: 360, height: 270 },
  };
  assert.equal(selection.target.kind, 'moment');
  if (selection.target.kind === 'moment') selection.target.region = canvas;
  const message = f.append(chip);
  const result = await f.make().import(sourceInput(f, message));
  const imported = result.review.annotations[0];
  assert.ok(imported);
  assert.deepEqual(imported.projectMessage?.selection.displayRegion, selection.displayRegion);
  assert.deepEqual(imported.projectMessage?.selection.canvasRegion, canvas);
  assert.ok('kind' in imported.anchor && imported.anchor.kind === 'video-project');
  assert.equal(
    imported.anchor.target.kind === 'moment' && imported.anchor.target.region?.coordinateSpace,
    'canvas-pixels',
  );
});

test('F326 editing the real Human source during async owner validation prevents deferred import', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const message = f.append();
  const input = sourceInput(f, message);
  const descriptor = f.screenings.descriptor.bind(f.screenings);
  const importer = new VideoProjectMessageImporter({
    store: f.store.ledgers,
    projects: f.projects,
    screenings: {
      descriptor: async (request) => {
        const result = await descriptor(request);
        const source = f.messages.getById(message.id);
        assert.ok(source);
        source.content = 'Changed during validation';
        return result;
      },
    },
    authority: { messages: f.messages, authorizeSource: async () => {} },
  });
  await assert.rejects(importer.import(input), { code: 'source_changed' });
  assert.equal(f.store.ledgers.getByContent(f.principal.userId, f.request.contentRef)?.annotations.length ?? 0, 0);
});

test('F326 delayed queued publication survives a later cursor and SQLite importer restart', async (t) => {
  const f = await setup();
  t.after(f.cleanup);
  const queued = f.append(attachment(f.screening), { deliveryStatus: 'queued' });
  f.messages.append({
    userId: f.principal.userId,
    catId: null,
    content: 'Later direct chat',
    mentions: [],
    threadId: 'thread-1',
    timestamp: Date.now(),
  });
  const before = await f
    .make()
    .synchronize({ principal: f.principal, contentRef: f.request.contentRef, threadId: 'thread-1' });
  assert.equal(before.scanned, 1);
  assert.equal(before.imported, 0);
  assert.ok(before.cursor?.startsWith('v2:'));
  assert.equal(f.store.ledgers.getByContent(f.principal.userId, f.request.contentRef), null);
  const delivered = await f.messages.markDelivered(queued.id, Date.now());
  assert.ok(delivered);
  assert.equal(delivered.deliveryStatus, 'delivered');
  const after = await f
    .restart()
    .synchronize({ principal: f.principal, contentRef: f.request.contentRef, threadId: 'thread-1' });
  assert.equal(after.imported, 1);
  assert.notEqual(after.cursor, before.cursor);
  assert.equal(
    f.store.ledgers.getByContent(f.principal.userId, f.request.contentRef)?.annotations[0]?.projectMessage?.source
      .messageId,
    queued.id,
  );
});
