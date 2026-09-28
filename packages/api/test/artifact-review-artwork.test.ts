import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type ArtifactReviewView, artifactReviewActionSchema } from '@cat-cafe/shared';
import Fastify from 'fastify';
import sharp from 'sharp';
import { inspectArtifactReview } from '../src/domains/collaborative-content/artifact-review/inspection.js';
import { ArtifactReviewService } from '../src/domains/collaborative-content/artifact-review/service.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { registerArtifactReviewRoutes } from '../src/routes/artifact-review-routes.js';
import { artifactReviewSchema as legacyReader } from './fixtures/artifact-review-v1-schema.js';
import { createReviewFixture, reviewCat, reviewHuman } from './helpers/artifact-review-fixture.js';

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'f309-artwork-'));
  const uploads = join(root, 'uploads');
  await mkdir(uploads);
  await sharp({ create: { width: 160, height: 100, channels: 3, background: '#eee4d5' } })
    .png()
    .toFile(join(uploads, 'cover.png'));
  const f = createReviewFixture(root, uploads);
  const path = join(root, 'review.sqlite');
  const store = new ArtifactReviewStore(path);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const service = new ArtifactReviewService({ store, media: f.media });
  const { principal: _principal, ...request } = f.prepare;
  const initial = await service.prepare(request, reviewHuman);
  return { ...f, uploads, path, store, service, initial };
}

function command(view: ArtifactReviewView, action: unknown) {
  return {
    reviewId: view.review.reviewId,
    expectedRevision: view.review.revision,
    expectedTaskRevision: view.authority.taskRevision,
    round: view.review.rounds.at(-1)?.number ?? 1,
    operationId: randomUUID(),
    action: artifactReviewActionSchema.parse(action),
  };
}
const drawing = {
  id: 'human-line',
  kind: 'stroke',
  color: '#d04a3a',
  strokeWidth: 4,
  points: [
    { x: 12, y: 14 },
    { x: 45, y: 52 },
  ],
};

test('marks persist with authenticated authors, no fabricated comments, exact replay and historical deletion', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(legacyReader.parse(f.store.get(f.initial.review.reviewId)), f.initial.review);
  const save = command(f.initial, { kind: 'add_visual_marks', marks: [drawing] });
  const result = await f.service.act(save, reviewHuman);
  const round = result.view.review.rounds[0];
  assert.equal(result.view.review.version, 2);
  assert.equal(
    legacyReader.safeParse(f.store.get(f.initial.review.reviewId)).success,
    false,
    'an old reader explicitly rejects v2; it must never drop new fields and rewrite v1',
  );
  assert.deepEqual(
    f.store.get(f.initial.review.reviewId),
    result.view.review,
    'rollback read rejection preserves the stored record for the current reader',
  );
  assert.equal(round?.annotations.length, 0);
  assert.deepEqual(round?.visualMarks?.[0]?.drawing, drawing);
  assert.deepEqual(round?.visualMarks?.[0]?.author, reviewHuman.actor);
  assert.equal(f.store.returns.pending().length, 0, 'saving drawings does not ask a cat to continue');
  const marks = await inspectArtifactReview(
    f.service,
    { reviewId: result.view.review.reviewId, view: 'marks' },
    reviewCat,
  );
  assert.ok(marks.records.some((row) => row.path === '/0/drawing/points/0/x' && row.value === 12));
  assert.ok(marks.records.some((row) => row.path === '/0/author/actorId' && row.value === 'operator'));
  assert.equal((await f.service.act(save, reviewHuman)).receipt.receiptRef, result.receipt.receiptRef);
  assert.equal((await f.service.read(result.view.review.reviewId, reviewHuman)).review.revision, 2);
  await assert.rejects(
    f.service.act(command(result.view, { kind: 'delete_visual_mark', markId: drawing.id }), reviewCat),
    /access_denied/,
  );
  const deleted = await f.service.act(
    command(result.view, { kind: 'delete_visual_mark', markId: drawing.id }),
    reviewHuman,
  );
  assert.equal(deleted.view.review.rounds[0]?.visualMarks?.[0]?.state, 'deleted');
  assert.deepEqual(deleted.view.review.rounds[0]?.visualMarks?.[0]?.drawing, drawing);
  const reopened = new ArtifactReviewStore(f.path);
  try {
    assert.deepEqual(reopened.get(result.view.review.reviewId), deleted.view.review);
    assert.ok(reopened.history(result.view.review.reviewId, 0, 20).some((entry) => entry.kind === 'add_visual_marks'));
  } finally {
    reopened.close();
  }
});

test('batch validation is atomic and rejects duplicate, out-of-bounds and foreign-frame marks', async (t) => {
  const f = await fixture(t);
  for (const marks of [
    [drawing, drawing],
    [
      drawing,
      {
        ...drawing,
        id: 'outside',
        points: [
          { x: 12, y: 14 },
          { x: 161, y: 52 },
        ],
      },
    ],
    [{ ...drawing, frame: { streamId: 'invented', tick: 0 } }],
  ]) {
    await assert.rejects(
      f.service.act(
        {
          ...command(f.initial, { kind: 'add_visual_marks', marks: [drawing] }),
          action: { kind: 'add_visual_marks', marks },
        },
        reviewHuman,
      ),
    );
    assert.equal(f.store.get(f.initial.review.reviewId)?.revision, 1);
  }
  assert.equal(
    artifactReviewActionSchema.safeParse({
      kind: 'add_visual_marks',
      marks: [{ ...drawing, color: 'url(javascript:alert(1))' }],
    }).success,
    false,
  );
  const saved = await f.service.act(command(f.initial, { kind: 'add_visual_marks', marks: [drawing] }), reviewHuman);
  await assert.rejects(
    f.service.act(command(f.initial, { kind: 'add_visual_marks', marks: [{ ...drawing, id: 'stale' }] }), reviewHuman),
    /revision_conflict/,
  );
  assert.equal(saved.view.review.rounds[0]?.visualMarks?.length, 1);
});

test('point comments are explicit points, survive restart, and stay attached to their original media version', async (t) => {
  const f = await fixture(t);
  const point = { kind: 'image-point', x: 73, y: 29 };
  const saved = await f.service.act(
    command(f.initial, { kind: 'annotate', annotationId: 'point', anchor: point, body: '这里的字距再松一点' }),
    reviewHuman,
  );
  assert.deepEqual(saved.view.review.rounds[0]?.annotations[0]?.anchor, point);
  assert.equal(saved.view.review.version, 2);
  await assert.rejects(
    f.service.act(
      command(saved.view, { kind: 'annotate', annotationId: 'outside', anchor: { ...point, x: 161 }, body: 'outside' }),
      reviewHuman,
    ),
    /invalid_anchor/,
  );
  const second = new ArtifactReviewStore(f.path);
  try {
    assert.deepEqual(second.get(saved.view.review.reviewId)?.rounds[0]?.annotations[0]?.anchor, point);
  } finally {
    second.close();
  }
});

test('region removal is one human request and durable return; the assigned cat reads the exact region and publishes a new version', async (t) => {
  const f = await fixture(t);
  const edit = { kind: 'erase-region', region: { x: 30, y: 12, width: 24, height: 28 } };
  const request = command(f.initial, {
    kind: 'request_image_edit',
    annotationId: 'remove-cup',
    edit,
    note: '保留旁边的花',
  });
  await assert.rejects(f.service.act(request, reviewCat), /human_required/);
  const result = await f.service.act(request, reviewHuman);
  const round = result.view.review.rounds[0];
  assert.equal(round?.state, 'changes_requested');
  assert.deepEqual(round?.annotations[0]?.imageEdit, edit);
  assert.deepEqual(round?.annotations[0]?.anchor, { kind: 'image-region', ...edit.region });
  assert.ok(round?.annotations[0]?.body.includes('保留旁边的花'));
  assert.equal(round?.decision?.receiptRef, result.receipt.receiptRef);
  assert.equal(f.store.returns.pending().length, 1);
  assert.equal(f.store.returns.pending()[0]?.targetCatId, reviewCat.actor.actorId);
  assert.equal(f.store.returns.pending()[0]?.kind, 'request_image_edit');
  await f.service.act(request, reviewHuman);
  assert.equal(f.store.returns.pending().length, 1);
  const inspection = await inspectArtifactReview(
    f.service,
    { reviewId: result.view.review.reviewId, view: 'annotations' },
    reviewCat,
  );
  assert.ok(inspection.records.some((row) => row.path === '/0/imageEdit/region/x' && row.value === 30));
  const bytes = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#abddee' } })
    .png()
    .toBuffer();
  await writeFile(join(f.uploads, 'revised.png'), bytes);
  const publication = f.publish('/uploads/revised.png');
  const changed = await f.service.respond(
    {
      reviewId: result.view.review.reviewId,
      expectedRevision: result.view.review.revision,
      expectedTaskRevision: 1,
      expectedOwnerRevision: 1,
      operationId: 'publish-edit',
      artifactRef: '/uploads/revised.png',
      expectedArtifactRevision: String(publication.timestamp),
      responses: [{ annotationId: 'remove-cup', disposition: 'addressed', explanation: '按选区完成修改' }],
    },
    reviewCat,
  );
  assert.equal(changed.view.review.rounds.length, 2);
  assert.deepEqual(changed.view.review.rounds[0]?.annotations[0]?.imageEdit, edit);
  assert.equal(changed.view.review.rounds[1]?.annotations.length, 0);
  assert.equal(changed.view.review.task.taskId, f.initial.review.task.taskId);
  assert.equal(f.task.current?.status, 'doing');
});

test('aspect ratio is a typed whole-image request with bounded presets, not a stretched preview', async (t) => {
  const f = await fixture(t);
  const edit = { kind: 'aspect-ratio', ratio: '9:16' };
  const result = await f.service.act(
    command(f.initial, { kind: 'request_image_edit', annotationId: 'portrait', edit }),
    reviewHuman,
  );
  assert.deepEqual(result.view.review.rounds[0]?.asset, f.initial.review.rounds[0]?.asset);
  assert.deepEqual(result.view.review.rounds[0]?.annotations[0]?.imageEdit, edit);
  assert.deepEqual(result.view.review.rounds[0]?.annotations[0]?.anchor, {
    kind: 'image-region',
    x: 0,
    y: 0,
    width: 160,
    height: 100,
  });
  assert.equal(f.store.returns.pending().length, 1);
  assert.equal(
    artifactReviewActionSchema.safeParse({
      kind: 'request_image_edit',
      annotationId: 'bad',
      edit: { ...edit, ratio: '0:999999' },
    }).success,
    false,
  );
});

test('the human route accepts the advertised full drawing batch and still rejects oversized bodies', async (t) => {
  const f = await fixture(t);
  const app = Fastify();
  app.decorateRequest('sessionUserId', null);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = 'operator';
  });
  registerArtifactReviewRoutes(app, { reviews: f.service, changed: async () => {}, contexts: async () => [] });
  t.after(async () => {
    await app.close();
  });
  const marks = Array.from({ length: 100 }, (_, index) => ({
    ...drawing,
    id: `line-${index}`,
    points: Array.from({ length: 300 }, (_, i) => ({
      x: 12.123456789012344 + i / 300,
      y: 44.98765432101234 + i / 300,
    })),
  }));
  const payload = command(f.initial, { kind: 'add_visual_marks', marks });
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 512 * 1024);
  const url = `/api/artifact-reviews/${f.initial.review.reviewId}/actions`;
  const response = await app.inject({ method: 'POST', url, payload });
  assert.equal(response.statusCode, 200, response.body.slice(0, 500));
  assert.equal(response.json().view.review.rounds[0].visualMarks.length, 100);
  const excessive = await app.inject({ method: 'POST', url, payload: { unused: 'x'.repeat(2 * 1024 * 1024) } });
  assert.equal(excessive.statusCode, 413);
  assert.equal(f.store.get(f.initial.review.reviewId)?.revision, 2);
});
