import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  assertCollectiveMediaView,
  collectiveMediaOperationId,
  collectiveMediaReceiptSchema,
  collectiveMediaViewSchema,
} from '@cat-cafe/shared';
import { publishedCollectiveFixture } from './collective-published-media.fixture.js';

for (const mime of ['image/png', 'video/mp4'])
  test(`the actual retained ${mime} owner fits the public surface contract without a private principal`, async (t) => {
    const f = await publishedCollectiveFixture(t, mime);
    await f.share();
    const first = await f.execute('alice');
    assert.equal(first.status, 'ok');
    const value = assertCollectiveMediaView(first.value, { ...f.scope, ...f.asset });
    assert.equal(value.mediaType, mime);
    assert.doesNotMatch(JSON.stringify(value), /ownerUserId|sourcePublication|\/uploads|threadId/);
    assert.equal(collectiveMediaViewSchema.safeParse({ ...value, sourcePublication: {} }).success, false);
    const operationId = randomUUID();
    const anchor =
      value.media.kind === 'image'
        ? { kind: 'image-point', x: 3, y: 4 }
        : {
            kind: 'video-range',
            streamId: value.media.streamId,
            startTick: value.media.startTick,
            endTick: value.media.startTick + 1,
            framePoint: { tick: value.media.startTick, x: 3, y: 4 },
          };
    const command = {
      kind: 'media-review',
      expectedReviewRevision: value.view.review.revision,
      action: { kind: 'annotate', body: '这是实际owner的一条批注。', anchor },
    };
    const added = await f.execute('alice', 'annotate', command, operationId);
    assert.equal(added.status, 'ok');
    const receipt = collectiveMediaReceiptSchema.parse(added.value);
    assert.equal(
      receipt.receipt.operationId,
      await collectiveMediaOperationId({ ...f.scope, humanId: 'alice' }, 'annotate', operationId),
    );
    const replay = await f.execute('alice', 'annotate', command, operationId);
    assert.equal(collectiveMediaReceiptSchema.parse(replay.value).receipt.receiptRef, receipt.receipt.receiptRef);
    const other = await f.execute('bob');
    assert.equal(other.status, 'ok');
    assert.equal(collectiveMediaViewSchema.parse(other.value).view.review.annotations.length, 1);
  });
