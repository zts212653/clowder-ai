import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { ArtifactReviewService } from '../src/domains/collaborative-content/artifact-review/service.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { createReviewFixture, reviewCat, reviewHuman } from './helpers/artifact-review-fixture.js';

test('real PNG ranges keep their original source and Task through one request and returned candidate', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-media-selection-source-'));
  const uploads = join(root, 'uploads');
  await mkdir(uploads);
  const original = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#abcdef' } })
    .png()
    .toBuffer();
  await writeFile(join(uploads, 'cover.png'), original);
  const store = new ArtifactReviewStore(join(root, 'review.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const f = createReviewFixture(root, uploads, store);
  const service = new ArtifactReviewService({ store, media: f.media });
  const { principal: _principal, ...prepare } = f.prepare;
  const before = await service.prepare(prepare, reviewHuman);
  const request = {
    reviewId: before.review.reviewId,
    expectedRevision: before.review.revision,
    expectedTaskRevision: before.authority.taskRevision,
    round: 1,
    operationId: randomUUID(),
    action: {
      kind: 'request_media_edit',
      mediaType: 'image/png',
      annotationId: 'multi-range',
      body: '请一起改这两处。',
      selections: [
        {
          id: 'one',
          selection: { kind: 'image-region', x: 10, y: 20, width: 40, height: 30 },
          instruction: '移除文字',
        },
        { id: 'two', selection: { kind: 'image-point', x: 120, y: 70 }, instruction: '这里增加星星' },
      ],
    },
  };
  await assert.rejects(service.act(request, reviewCat), /human_required/);
  await assert.rejects(
    service.act(request, { userId: 'foreign', actor: { kind: 'human', actorId: 'foreign' } }),
    /access_denied/,
  );
  const result = await service.act(request, reviewHuman);
  const sourceRound = result.view.review.rounds[0];
  assert.ok(sourceRound);
  assert.equal(sourceRound.annotations.length, 2);
  assert.deepEqual(sourceRound.asset.media, { kind: 'image', width: 160, height: 100 });
  assert.deepEqual(
    sourceRound.annotations.map((item) => item.anchor),
    request.action.selections.map((item) => item.selection),
  );
  assert.equal(store.returns.pending().length, 1);
  assert.equal((await service.act(request, reviewHuman)).receipt.receiptRef, result.receipt.receiptRef);
  assert.equal(store.returns.pending().length, 1);
  const candidate = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#fffabc' } })
    .png()
    .toBuffer();
  await writeFile(join(uploads, 'candidate.png'), candidate);
  const publication = f.publish('/uploads/candidate.png');
  const responses = sourceRound.annotations.map((item) => ({
    annotationId: item.id,
    disposition: 'addressed',
    explanation: '已按本处说明修改。',
  }));
  const response = {
    reviewId: before.review.reviewId,
    expectedRevision: result.view.review.revision,
    expectedTaskRevision: 1,
    expectedOwnerRevision: 1,
    operationId: 'candidate',
    artifactRef: '/uploads/candidate.png',
    expectedArtifactRevision: String(publication.timestamp),
    responses,
  };
  await assert.rejects(service.respond({ ...response, responses: responses.slice(0, 1) }, reviewCat), /invalid_action/);
  const changed = await service.respond(response, reviewCat);
  assert.equal(changed.view.review.task.taskId, before.review.task.taskId);
  assert.equal(changed.view.review.rounds.length, 2);
  assert.deepEqual(changed.view.review.rounds[0]?.annotations, sourceRound.annotations);
  assert.equal(changed.view.review.rounds[1]?.responses.length, 2);
  assert.equal(changed.view.review.rounds[1]?.asset.ownerRevision, 2);
  assert.equal(f.task.current?.status, 'doing');
  assert.deepEqual(
    await readFile(join(uploads, 'cover.png')),
    original,
    'request and candidate never rewrite the source',
  );
});
