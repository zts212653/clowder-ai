import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { publicationMarksFixture } from './helpers/publication-marks-read-fixture.js';

interface Page {
  revision: number;
  sourceSnapshot: string;
  nextCursor: number | null;
  authority: { canWrite: boolean };
  records: { path: string; value: unknown }[];
}

for (const kind of ['image', 'video'] as const)
  test(`${kind}: the addressed cat reads three complete saved strokes without a Task`, async (t) => {
    const f = await publicationMarksFixture(kind);
    t.after(f.close);
    const before = f.store.ledgers.get(f.payload.reviewId);
    const records = new Map<string, unknown>();
    let cursor = 0;
    let sourceSnapshot: string | undefined;
    let pages = 0;
    do {
      const response = await f.read({
        cursor,
        ...(sourceSnapshot ? { expectedRevision: 2, expectedSourceSnapshot: sourceSnapshot } : {}),
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(response.body.length <= 12000);
      const page: Page = response.json();
      assert.equal(page.revision, 2);
      assert.equal(page.authority.canWrite, false);
      sourceSnapshot = page.sourceSnapshot;
      for (const record of page.records) {
        assert.equal(records.has(record.path), false, 'no overlap or lost points at page boundaries');
        records.set(record.path, record.value);
      }
      pages++;
      if (page.nextCursor === null) break;
      assert.ok(page.nextCursor > cursor);
      cursor = page.nextCursor;
      assert.ok(pages < 100);
    } while (pages < 100);
    assert.ok(pages > 1, 'the real long strokes require bounded pagination');
    for (const [index, mark] of f.saved.review.visualMarks!.entries()) {
      assert.equal(records.get(`/${index}/author/kind`), 'human');
      assert.equal(records.get(`/${index}/author/actorId`), 'operator');
      assert.equal(records.get(`/${index}/drawing/kind`), 'stroke');
      assert.equal(records.get(`/${index}/drawing/color`), '#d04a3a');
      const drawing = f.drawings[index]!;
      for (const [point, value] of drawing.points.entries()) {
        assert.equal(records.get(`/${index}/drawing/points/${point}/x`), value.x);
        assert.equal(records.get(`/${index}/drawing/points/${point}/y`), value.y);
      }
      assert.ok(mark.drawing.id);
      assert.equal(records.get(`/${index}/drawing/id`), mark.drawing.id);
      if (drawing.frame) {
        assert.equal(records.get(`/${index}/drawing/frame/streamId`), drawing.frame.streamId);
        assert.equal(records.get(`/${index}/drawing/frame/tick`), drawing.frame.tick);
      }
    }
    assert.equal(f.task.current, null);
    assert.deepEqual(f.store.ledgers.get(f.payload.reviewId), before, 'reading never writes/imports a second ledger');
    assert.deepEqual(f.attachment.selections, [], 'saved strokes do not become fabricated region selections');
  });

test('publication read rechecks source visibility and exact ledger/version on every page', async (t) => {
  const f = await publicationMarksFixture();
  t.after(f.close);
  const first = await f.read();
  assert.equal(first.statusCode, 200, first.body);
  const page: Page = first.json();
  assert.ok(page.nextCursor);
  const next = {
    cursor: page.nextCursor,
    expectedRevision: page.revision,
    expectedSourceSnapshot: page.sourceSnapshot,
  };
  assert.equal((await f.read({ cursor: page.nextCursor })).statusCode, 409);
  assert.equal((await f.read({ ...next, expectedSourceSnapshot: `sha256:${'0'.repeat(64)}` })).statusCode, 409);
  const body = f.question.content;
  f.question.content = 'changed question';
  assert.equal((await f.read(next)).statusCode, 409);
  f.question.content = body;
  f.question.deliveryStatus = 'queued';
  assert.equal((await f.read(next)).statusCode, 403);
  delete f.question.deliveryStatus;
  f.question.origin = 'briefing';
  assert.equal((await f.read(next)).statusCode, 403);
  delete f.question.origin;
  f.question.mentions = [];
  assert.equal((await f.read(next)).statusCode, 200);
  f.question.mentions = [createCatId('codex-astra')];
  f.question.visibility = 'whisper';
  f.question.whisperTo = [];
  assert.equal((await f.read(next)).statusCode, 403);
  delete f.question.visibility;
  delete f.question.whisperTo;
  f.question.recall = { version: 1, exposure: 'none', recalledAt: 3000 };
  assert.equal((await f.read(next)).statusCode, 403);
  delete f.question.recall;
  f.publication.recall = { version: 1, exposure: 'none', recalledAt: 3000 };
  assert.equal((await f.read(next)).statusCode, 403);
  delete f.publication.recall;
  f.thread.current!.deletedAt = 3000;
  assert.equal((await f.read(next)).statusCode, 403);
  delete f.thread.current!.deletedAt;
  const source = f.attachment.source;
  assert.equal(source.kind, 'publication');
  if (source.kind !== 'publication') throw new Error('fixture');
  source.ownerRevision = 2;
  assert.notEqual((await f.read()).statusCode, 200);
  source.ownerRevision = 1;
  await f.ledgers.act({
    principal: { userId: 'operator', actor: { kind: 'human', actorId: 'operator' } },
    reviewId: f.payload.reviewId,
    expectedRevision: 2,
    operationId: 'delete-a-mark',
    action: { kind: 'delete_visual_mark', markId: f.saved.review.visualMarks![0]!.drawing.id },
  });
  assert.equal((await f.read(next)).statusCode, 409);
});

test('publication reads reauthorize a question recalled during the media read', async (t) => {
  const f = await publicationMarksFixture();
  t.after(f.close);
  const read = f.media.read.bind(f.media);
  f.media.read = async (...args) => {
    const asset = await read(...args);
    f.question.recall = { version: 1, exposure: 'none', recalledAt: 3000 };
    return asset;
  };
  const response = await f.read();
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.body.includes('red-circle'), false);
});

test('a normal question routed by conversation fallback is readable from its real delivery, without a written mention', async (t) => {
  const f = await publicationMarksFixture();
  t.after(f.close);
  f.question.mentions = [];
  f.question.lifecycle = {
    kind: 'input',
    orderKey: `2000:${f.question.id}`,
    dispatchRefs: [
      {
        targetId: 'codex-astra',
        phase: 'settled',
        statusMessageId: 'actual-response',
        dispatchedAt: 2001,
        inputRead: { status: 'read', at: 2002 },
      },
    ],
  };
  const response = await f.read();
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(response.json().records.length > 0);
  f.question.lifecycle = { kind: 'input', orderKey: `2000:${f.question.id}`, dispatchRefs: [] };
  assert.equal((await f.read()).statusCode, 200, 'public source visibility is independent of delivery custody');
});

test('ordinary overview separates whole-work selections from saved drawings and annotations', async (t) => {
  const f = await publicationMarksFixture();
  t.after(f.close);
  const overview = await f.read({ view: 'overview' });
  assert.equal(overview.statusCode, 200, overview.body);
  const page: Page = overview.json();
  assert.equal(page.records.find((item) => item.path === '/visualMarkCount')?.value, 3);
  assert.equal(page.records.find((item) => item.path === '/annotationCount')?.value, 0);
  assert.equal(
    page.records.some((item) => item.path.startsWith('/selections/')),
    false,
  );
  const annotations = await f.read({ view: 'annotations' });
  assert.equal(annotations.statusCode, 200, annotations.body);
  assert.deepEqual(annotations.json().records, []);
  assert.equal((await f.read({ view: 'history' })).statusCode, 400);
});

test('ordinary read rejects unauthenticated/foreign-thread reads, forged coordinates and ambiguous attachment selection', async (t) => {
  const f = await publicationMarksFixture();
  t.after(f.close);
  assert.equal((await f.read({}, {})).statusCode, 401);
  for (const [user, cat, thread] of [
    ['other-user', 'codex-astra', 'thread-cover'],
    ['operator', 'codex-astra', 'other-thread'],
  ]) {
    const auth = await f.registry.create(user!, createCatId(cat!), thread!);
    assert.equal(
      (await f.read({}, { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken })).statusCode,
      403,
    );
  }
  const auth = await f.registry.create('operator', createCatId('codex-astra'), f.publication.threadId);
  Object.assign(f.headers, { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken });
  assert.equal((await f.read({ reviewId: 'guessed-ledger' })).statusCode, 403);
  assert.equal((await f.read({ attachmentId: 'another-attachment' })).statusCode, 403);
  assert.equal((await f.read({ actor: { kind: 'human', actorId: 'operator' } })).statusCode, 400);
  assert.equal((await f.read({ round: 1 })).statusCode, 400);
  f.question.contentBlocks = [
    ...(f.question.contentBlocks ?? []),
    { type: 'context_attachment', attachment: { ...f.attachment, id: 'sibling' } },
  ];
  assert.equal((await f.read({ attachmentId: undefined })).statusCode, 400);
  assert.equal((await f.read()).statusCode, 200);
});

test('publication reads keep the canonical public, whisper-recipient and revealed-whisper audiences', async (t) => {
  const f = await publicationMarksFixture();
  t.after(f.close);
  const auth = await f.registry.create('operator', createCatId('codex-sol'), f.publication.threadId);
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  assert.equal((await f.read({}, headers)).statusCode, 200, 'public is visible to all cats in the authorized thread');
  f.question.visibility = 'whisper';
  f.question.whisperTo = [createCatId('codex-astra')];
  assert.equal((await f.read({}, headers)).statusCode, 403);
  assert.equal((await f.read()).statusCode, 200);
  f.question.revealedAt = 3000;
  assert.equal((await f.read({}, headers)).statusCode, 200);
});
