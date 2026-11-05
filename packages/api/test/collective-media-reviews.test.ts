import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { mediaValue, publishedCollectiveFixture } from './collective-published-media.fixture.js';
import { reviewCat } from './helpers/artifact-review-fixture.js';

test('image opinions, own edits, replies and resolution use the original durable ledger and exact operation CAS', async (t) => {
  const f = await publishedCollectiveFixture(t);
  await f.share();
  const before = mediaValue(await f.execute('alice'));
  const input = {
    kind: 'media-review',
    expectedReviewRevision: before.view.review.revision,
    action: {
      kind: 'annotate',
      body: '这里留白。',
      anchor: { kind: 'image-region', x: 1, y: 2, width: 20, height: 10 },
    },
  };
  const added = mediaValue(await f.execute('alice', 'annotate', input, 'one-opinion'));
  assert.ok(added.annotationId);
  const replay = mediaValue(await f.execute('alice', 'annotate', input, 'one-opinion'));
  assert.equal(replay.receipt?.revision, added.receipt?.revision);
  let view = mediaValue(await f.execute('bob'));
  assert.equal(view.view.review.annotations.length, 1);
  assert.equal(view.view.review.annotations[0].author.actorId, 'alice');
  const edit = {
    kind: 'media-review',
    expectedReviewRevision: view.view.review.revision,
    action: { kind: 'edit_annotation', annotationId: added.annotationId, body: '请保留这处空白。' },
  };
  assert.equal((await f.execute('bob', 'annotate', edit, 'foreign-edit')).status, 'error');
  assert.equal((await f.execute('alice', 'annotate', edit, 'own-edit')).status, 'ok');
  view = mediaValue(await f.execute('bob'));
  const reply = {
    kind: 'media-review',
    expectedReviewRevision: view.view.review.revision,
    action: { kind: 'reply', annotationId: added.annotationId, body: '同意这处留白。' },
  };
  const subject = { mediaReviewReply: { annotationId: added.annotationId } };
  assert.equal((await f.execute('bob', 'annotate', reply, 'one-reply', f.asset, subject)).status, 'ok');
  assert.equal((await f.execute('bob', 'annotate', reply, 'one-reply', f.asset, subject)).status, 'ok');
  view = mediaValue(await f.execute('alice', 'read', { annotationId: added.annotationId }));
  assert.equal(view.view.review.annotations[0].replies?.length, 1);
  assert.equal(view.view.review.annotations[0].replies?.[0].author.actorId, 'bob');
  const resolve = {
    kind: 'media-review',
    expectedReviewRevision: view.view.review.revision,
    action: { kind: 'set_annotation_state', annotationId: added.annotationId, state: 'resolved' },
  };
  assert.equal((await f.execute('alice', 'annotate', resolve, 'resolve')).status, 'ok');
  f.reopen();
  view = mediaValue(await f.execute('alice', 'history', { annotationId: added.annotationId }));
  assert.equal(view.view.review.annotations[0].state, 'resolved');
  assert.equal(view.view.review.annotations[0].replies?.length, 1);
  assert.equal((await f.execute('alice', 'annotate', input, 'different-stale-op')).status, 'error');
  assert.equal((await f.owner.listOutbox(f.asset.contentRef)).length, 1);
});

test('historical media replies need an exact fresh subject; old annotations, edits, markup and borrowed reply capabilities are refused', async (t) => {
  const f = await publishedCollectiveFixture(t);
  await f.share();
  const before = mediaValue(await f.execute('alice'));
  const add = {
    kind: 'media-review',
    expectedReviewRevision: before.view.review.revision,
    action: { kind: 'annotate', body: '原图这个点。', anchor: { kind: 'image-point', x: 10, y: 20 } },
  };
  const note = mediaValue(await f.execute('alice', 'annotate', add, 'old-point'));
  assert.ok(note.annotationId);
  await writeFile(
    join(f.uploads, 'v2.png'),
    await sharp({ create: { width: 160, height: 100, channels: 3, background: 'blue' } })
      .png()
      .toBuffer(),
  );
  const publication = f.publish('/uploads/v2.png');
  assert.ok(f.task.current?.entrustedWork);
  f.task.current.entrustedWork.artifactRefs.push('/uploads/v2.png');
  const next = await f.media.publishVersion({
    ...f.prepare,
    principal: reviewCat,
    contentRef: f.asset.contentRef,
    expectedOwnerRevision: 1,
    artifactRef: '/uploads/v2.png',
    expectedArtifactRevision: String(publication.timestamp),
    operationId: 'real-private-v2',
  });
  assert.equal(
    (await f.execute('alice', 'read', {}, 'unshared-v2', next, { catalogueOwnerRevision: 2 })).status,
    'error',
  );
  await f.share(next);
  const current = mediaValue(await f.execute('alice', 'read', {}, 'shared-v2', next, { catalogueOwnerRevision: 2 }));
  assert.equal(current.view.canWrite, true);
  const old = mediaValue(await f.execute('alice'));
  assert.equal(old.view.historyReadOnly, true);
  assert.equal(old.view.canWrite, false);
  const reply = {
    kind: 'media-review',
    expectedReviewRevision: current.view.review.revision,
    action: { kind: 'reply', annotationId: note.annotationId, body: '继续讨论原图。' },
  };
  assert.equal((await f.execute('bob', 'annotate', reply, 'no-reply-authority')).status, 'error');
  const subject = { catalogueOwnerRevision: 2, mediaReviewReply: { annotationId: note.annotationId } };
  assert.equal((await f.execute('bob', 'annotate', reply, 'historical-reply', f.asset, subject)).status, 'ok');
  const read = mediaValue(await f.execute('alice', 'read', { annotationId: note.annotationId }));
  assert.equal(read.view.review.annotations[0].replies?.length, 1);
  for (const action of [
    add.action,
    { kind: 'set_annotation_state', annotationId: note.annotationId, state: 'resolved' },
    { kind: 'add_visual_marks', marks: [] },
  ]) {
    assert.equal(
      (await f.execute('bob', 'annotate', { ...reply, action }, 'borrowed', f.asset, subject)).status,
      'error',
    );
  }
  f.revoked.add('bob');
  assert.equal((await f.execute('bob', 'annotate', reply, 'historical-reply', f.asset, subject)).status, 'error');
  assert.equal((await f.execute('alice', 'read', {}, 'other-reader', next)).status, 'ok');
});

test('actual MP4 presentation ticks and frame anchors are validated against the retained stream', async (t) => {
  const f = await publishedCollectiveFixture(t, 'video/mp4');
  await f.share();
  const view = mediaValue(await f.execute('alice'));
  const media = view.media;
  assert.equal(media.kind, 'video');
  if (media.kind !== 'video') return;
  const input = {
    kind: 'media-review',
    expectedReviewRevision: view.view.review.revision,
    action: {
      kind: 'annotate',
      body: '这一帧。',
      anchor: {
        kind: 'video-range',
        streamId: media.streamId,
        startTick: media.startTick,
        endTick: media.startTick + media.durationTicks,
        framePoint: { tick: media.startTick, x: 4, y: 5 },
      },
    },
  };
  assert.equal((await f.execute('alice', 'annotate', input, 'real-frame')).status, 'ok');
  const after = mediaValue(await f.execute('alice'));
  assert.equal(
    (
      await f.execute(
        'alice',
        'annotate',
        {
          ...input,
          expectedReviewRevision: after.view.review.revision,
          action: { ...input.action, anchor: { ...input.action.anchor, streamId: 'forged' } },
        },
        'forged-stream',
      )
    ).status,
    'error',
  );
  f.reopen();
  assert.equal(mediaValue(await f.execute('bob')).view.review.annotations.length, 1);
});
