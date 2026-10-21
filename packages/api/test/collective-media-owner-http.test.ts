import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { collectiveMediaBinding } from '../src/domains/collaborative-content/collective-artifact/media-source.js';
import { collectiveMediaHttpFixture } from './collective-media-http.fixture.js';
import { reviewCat } from './helpers/artifact-review-fixture.js';
import { test } from './helpers/f202-collective-installed-business.js';

for (const mime of ['image/png', 'video/mp4'])
  test(`two authenticated Humans read exact retained ${mime}, share one durable discussion and lose access independently`, async (t) => {
    const f = await collectiveMediaHttpFixture(t, mime);
    const read = await f.invoke(f.member.sessionToken, 'read', {}, 'member-initial');
    assert.equal(read.status, 200, JSON.stringify(read));
    const other = await f.invoke(f.owner.sessionToken, 'read', {}, 'owner-initial');
    assert.equal(other.status, 200, JSON.stringify(other));
    assert.equal(read.value.value.blobDigest, f.media.asset.blobDigest);
    assert.deepEqual(read.value.value.media, other.value.value.media);
    const media = f.media.asset.media;
    const anchor =
      media.kind === 'image'
        ? { kind: 'image-region', x: 1, y: 2, width: 20, height: 10 }
        : {
            kind: 'video-range',
            streamId: media.streamId,
            startTick: media.startTick,
            endTick: media.startTick + media.durationTicks,
            framePoint: { tick: media.startTick, x: 4, y: 5 },
          };
    const command = {
      kind: 'media-review',
      expectedReviewRevision: read.value.value.view.review.revision,
      action: { kind: 'annotate', body: '这处构图很好。', anchor },
    };
    const added = await f.invoke(f.member.sessionToken, 'annotate', command, 'one-opinion');
    assert.equal(added.status, 200, JSON.stringify(added));
    const annotationId = added.value.value.annotationId;
    const reply = {
      kind: 'media-review',
      expectedReviewRevision: added.value.value.receipt.revision,
      action: { kind: 'reply', annotationId, body: '这一处保持。' },
    };
    const first = await f.invoke(f.owner.sessionToken, 'annotate', reply, 'one-reply');
    assert.equal(first.status, 200, JSON.stringify(first));
    await f.restart();
    const replay = await f.invoke(f.owner.sessionToken, 'annotate', reply, 'one-reply');
    assert.equal(replay.status, 200, JSON.stringify(replay));
    assert.deepEqual(replay.value.value.receipt, { ...first.value.value.receipt, replayed: true });
    assert.equal(
      (
        await f.invoke(
          f.owner.sessionToken,
          'annotate',
          {
            ...reply,
            action: { ...reply.action, body: 'cannot change a replayed operation' },
          },
          'one-reply',
        )
      ).status,
      409,
    );
    const retained = await f.invoke(f.member.sessionToken, 'history', { annotationId }, 'retained-reply');
    const review = retained.value.value.view.review;
    assert.equal(review.annotations[0].replies.length, 1);
    assert.equal(review.annotations[0].author.actorId, f.member.human.humanId);
    assert.equal(review.annotations[0].replies[0].author.actorId, f.owner.human.humanId);
    const edit = {
      kind: 'media-review',
      expectedReviewRevision: review.revision,
      action: {
        kind: 'edit_reply',
        annotationId,
        replyId: review.annotations[0].replies[0].id,
        body: '这处保持原样。',
      },
    };
    assert.equal((await f.invoke(f.member.sessionToken, 'annotate', edit, 'foreign-reply-edit')).status, 403);
    assert.equal((await f.invoke(f.owner.sessionToken, 'annotate', edit, 'own-reply-edit')).status, 200);
    const resolved = await f.invoke(
      f.member.sessionToken,
      'annotate',
      {
        kind: 'media-review',
        expectedReviewRevision: review.revision + 1,
        action: { kind: 'set_annotation_state', annotationId, state: 'resolved' },
      },
      'resolve',
    );
    assert.equal(resolved.status, 200, JSON.stringify(resolved));
    const publicView = JSON.stringify([read, retained]);
    for (const secret of ['operator', 'thread-cover', 'task-cover', '/uploads', 'sourcePublication', f.media.root])
      assert.equal(publicView.includes(secret), false, secret);
    for (const directory of [f.serviceDirectory, f.connectorDirectory]) {
      for (const name of await readdir(directory, { recursive: true })) {
        if (name.endsWith('.json') || name.endsWith('.jsonl')) {
          const persisted = await readFile(join(directory, name));
          assert.equal(persisted.includes(f.media.bytes), false, name);
          const text = persisted.toString();
          for (const secret of [
            '这处构图很好。',
            '这一处保持。',
            '这处保持原样。',
            'thread-cover',
            'task-cover',
            '/uploads',
            'sourcePublication',
            f.media.root,
          ])
            assert.equal(text.includes(secret), false, `${name}: ${secret}`);
        }
      }
    }
    await f.store.updateArtifactAccess(f.owner.sessionToken, {
      ...f.coordinates,
      artifactId: f.artifact.artifactId,
      humanId: f.member.human.humanId,
      expectedAccessRevision: 1,
      access: 'revoked',
      requestId: 'revoke-member',
    });
    assert.equal((await f.invoke(f.member.sessionToken, 'annotate', command, 'one-opinion')).status, 403);
    assert.equal((await f.invoke(f.owner.sessionToken, 'read', {}, 'remaining-reader')).status, 200);
    await assert.rejects(
      f.media.media.read(f.media.asset.contentRef, 1, {
        userId: f.member.human.humanId,
        actor: { kind: 'human', actorId: f.member.human.humanId },
      }),
      /access_denied/,
    );
    await f.store.revokeConnection({
      sessionToken: f.owner.sessionToken,
      collectiveId: f.coordinates.collectiveId,
      connectionId: f.connection.connectionId,
    });
    const offline = await f.invoke(f.owner.sessionToken, 'read', {}, 'offline-owner');
    assert.equal(offline.status, 503, JSON.stringify(offline));
    assert.equal(offline.value.error.code, 'ARTIFACT_OWNER_UNAVAILABLE');
  });

test('only a Service-issued reply subject reaches historical media; browser claims and unshared owner revisions cannot widen it', async (t) => {
  const f = await collectiveMediaHttpFixture(t);
  const first = await f.invoke(
    f.member.sessionToken,
    'annotate',
    {
      kind: 'media-review',
      expectedReviewRevision: 1,
      action: { kind: 'annotate', body: '原版这个点。', anchor: { kind: 'image-point', x: 10, y: 20 } },
    },
    'original-point',
  );
  assert.equal(first.status, 200, JSON.stringify(first));
  const annotationId = first.value.value.annotationId;
  await writeFile(
    join(f.media.uploads, 'v2.png'),
    await sharp({ create: { width: 160, height: 100, channels: 3, background: 'blue' } })
      .png()
      .toBuffer(),
  );
  const publication = f.media.publish('/uploads/v2.png');
  assert.ok(f.media.task.current?.entrustedWork);
  f.media.task.current.entrustedWork.artifactRefs.push('/uploads/v2.png');
  const next = await f.media.media.publishVersion({
    ...f.media.prepare,
    principal: reviewCat,
    contentRef: f.media.asset.contentRef,
    expectedOwnerRevision: 1,
    artifactRef: '/uploads/v2.png',
    expectedArtifactRevision: String(publication.timestamp),
    operationId: 'private-next-version',
  });
  assert.equal((await f.invoke(f.member.sessionToken, 'read', {}, 'unshared-v2', 2)).status, 403);
  await f.share(next);
  // Annotate the freshly shared current version before any reader has advanced the ledger projection.
  const currentNote = await f.invoke(
    f.owner.sessionToken,
    'annotate',
    {
      kind: 'media-review',
      expectedReviewRevision: 2,
      action: { kind: 'annotate', body: '新版这个点。', anchor: { kind: 'image-point', x: 10, y: 20 } },
    },
    'new-point',
    2,
  );
  assert.equal(currentNote.status, 200, JSON.stringify(currentNote));
  const binding = collectiveMediaBinding(f.scope, next.contentRef);
  const committed = f.media.reviews.getByContent('operator', binding.ledgerRef, binding.scope.scopeRef);
  assert.ok(committed?.source.kind === 'collective-media');
  assert.equal(
    committed.source.ownerRevision,
    2,
    'A new opinion must atomically retain its exact media source before any read',
  );
  const current = await f.invoke(f.owner.sessionToken, 'read', {}, 'current-version');
  const revision = current.value.value.view.review.revision;
  assert.ok(
    current.value.value.view.review.sourceHistory.some(
      (source: { ownerRevision?: number }) => source.ownerRevision === 2,
    ),
  );
  const reply = {
    kind: 'media-review',
    expectedReviewRevision: revision,
    action: { kind: 'reply', annotationId, body: '继续原版讨论。' },
  };
  assert.equal((await f.invoke(f.owner.sessionToken, 'annotate', reply, 'old-version-reply', 1)).status, 200);
  const old = await f.invoke(f.member.sessionToken, 'history', { annotationId }, 'old-discussion', 1);
  assert.equal(old.value.value.view.historyReadOnly, true);
  assert.equal(old.value.value.view.canWrite, false);
  assert.equal(old.value.value.view.review.annotations[0].replies[0].body, '继续原版讨论。');
  for (const action of [
    { kind: 'annotate', body: '旧版新批注', anchor: { kind: 'image-point', x: 1, y: 1 } },
    { kind: 'set_annotation_state', annotationId, state: 'resolved' },
  ]) {
    assert.equal(
      (await f.invoke(f.member.sessionToken, 'annotate', { ...reply, action }, 'stale-write', 1)).status,
      409,
    );
  }
  const base = {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    sourceEventId: f.source.eventId,
    action: 'annotate',
    ownerRevision: 1,
  };
  assert.equal(
    (await f.post('constraints', f.member.sessionToken, { ...base, mediaReviewReply: { annotationId } })).status,
    400,
  );
  assert.equal(
    (
      await f.post('owner/request', f.member.sessionToken, {
        ...base,
        payload: reply,
        requestId: 'forged-authority',
        mediaReviewReply: { annotationId },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.post('owner/request', f.member.sessionToken, {
        ...base,
        collectiveId: 'wrong',
        payload: reply,
        requestId: 'wrong-collective',
      })
    ).status,
    409,
  );
  for (const action of ['propose', 'preview', 'apply', 'cancel', 'reject']) {
    const result = await f.invoke(f.owner.sessionToken, action, {}, `unsupported-${action}`);
    assert.equal(result.status, 422, JSON.stringify(result));
    assert.equal(result.value.error.code, 'ARTIFACT_OPERATION_UNAVAILABLE');
  }
  const original = f.media.messages.get(f.media.asset.sourcePublication.sourceRef.split(':').at(-1) ?? '');
  assert.ok(original);
  original.recall = { recalledAt: 9999, recalledBy: 'operator' };
  assert.equal((await f.invoke(f.owner.sessionToken, 'history', {}, 'recalled-source', 1)).status, 403);
});
