import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  ArtifactReviewAction,
  ArtifactReviewCommand,
  ArtifactReviewView,
  RespondWithMediaVersion,
} from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { ArtifactReviewService } from '../src/domains/collaborative-content/artifact-review/service.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import type { MediaReviewPrincipal } from '../src/domains/video-studio/content-owner/published-media-access.js';
import { createReviewFixture, reviewCat, reviewHuman } from './helpers/artifact-review-fixture.js';

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'f309-review-service-'));
  const uploads = join(root, 'uploads');
  await mkdir(uploads);
  const png = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#eee4d5' } })
    .png()
    .toBuffer();
  await writeFile(join(uploads, 'cover.png'), png);
  const f = createReviewFixture(root, uploads);
  const path = join(root, 'review.sqlite');
  const store = new ArtifactReviewStore(path);
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const service = new ArtifactReviewService({ store, media: f.media });
  const { principal: _principal, ...prepareRequest } = f.prepare;
  return { ...f, prepareRequest, root, uploads, png, path, store, service };
}

function command(view: ArtifactReviewView, action: ArtifactReviewAction): ArtifactReviewCommand {
  return {
    reviewId: view.review.reviewId,
    expectedRevision: view.review.revision,
    expectedTaskRevision: view.authority.taskRevision,
    round: view.review.rounds.at(-1)?.number ?? 1,
    operationId: randomUUID(),
    action,
  };
}

async function annotate(
  service: ArtifactReviewService,
  view: ArtifactReviewView,
  principal: MediaReviewPrincipal = reviewHuman,
) {
  return (
    await service.act(
      command(view, {
        kind: 'annotate',
        annotationId: 'title',
        anchor: { kind: 'image-region', x: 10, y: 10, width: 40, height: 30 },
        body: '标题再下移一些。',
      }),
      principal,
    )
  ).view;
}

async function newVersion(
  f: Awaited<ReturnType<typeof fixture>>,
  view: ArtifactReviewView,
): Promise<RespondWithMediaVersion> {
  await writeFile(
    join(f.uploads, 'cover-2.png'),
    await sharp({ create: { width: 160, height: 100, channels: 3, background: '#a0563d' } })
      .png()
      .toBuffer(),
  );
  const publication = f.publish('/uploads/cover-2.png');
  return {
    reviewId: view.review.reviewId,
    expectedRevision: view.review.revision,
    expectedTaskRevision: view.authority.taskRevision,
    expectedOwnerRevision: 1,
    operationId: 'respond-with-second-version',
    artifactRef: '/uploads/cover-2.png',
    expectedArtifactRevision: String(publication.timestamp),
    responses: [
      { annotationId: 'title', disposition: 'addressed', explanation: '标题位置已调整，新版请看框出的区域。' },
    ],
  };
}

test('a full image round returns typed evidence to the same Task without closing it', async (t) => {
  const f = await fixture(t);
  let view = await f.service.prepare(f.prepareRequest, reviewHuman);
  view = await annotate(f.service, view);
  view = (
    await f.service.act(command(view, { kind: 'submit_feedback', explanation: '请按标注调整封面。' }), reviewHuman)
  ).view;
  assert.equal(view.review.rounds[0]?.state, 'changes_requested');
  view = (
    await f.service.act(
      command(view, { kind: 'reply', annotationId: 'title', replyId: 'cat-reply', body: '我按这条意见来处理。' }),
      reviewCat,
    )
  ).view;
  const response = await newVersion(f, view);
  await assert.rejects(f.service.respond({ ...response, responses: [] }, reviewCat), /invalid_action/);
  assert.equal((await f.owner.load(view.review.contentRef)).ownerRevision, 1);
  view = (await f.service.respond(response, reviewCat)).view;
  assert.equal(view.review.rounds.length, 2);
  assert.deepEqual(view.review.rounds[0]?.annotations[0]?.author, reviewHuman.actor);
  assert.deepEqual(view.review.rounds[0]?.annotations[0]?.replies[0]?.author, reviewCat.actor);
  assert.deepEqual((await f.service.mediaBytes(view.review.reviewId, 1, reviewHuman)).bytes, f.png);
  assert.equal(view.review.rounds[1]?.annotations.length, 0);
  await assert.rejects(
    f.service.act(
      command(view, { kind: 'request_judgment', summary: '新版已就绪', judgmentNeeded: '请确认版式。' }),
      reviewCat,
    ),
    /task_changed/,
  );
  const task = f.task.current;
  assert.ok(task?.entrustedWork);
  f.task.current = {
    ...task,
    entrustedWork: { ...task.entrustedWork, revision: 2, artifactRefs: [view.continuation.artifactRef] },
  };
  view = await f.service.read(view.review.reviewId, reviewCat);
  view = (
    await f.service.act(
      command(view, { kind: 'request_judgment', summary: '新版已按意见调整', judgmentNeeded: '请确认可以发布。' }),
      reviewCat,
    )
  ).view;
  assert.equal(view.review.task.observedRevision, 2);
  const decision = command(view, { kind: 'decide', outcome: 'approved', explanation: '这版可以发布。' });
  const accepted = await f.service.act(decision, reviewHuman);
  assert.equal(accepted.view.continuation.taskId, 'task-cover');
  assert.equal(accepted.view.continuation.reviewEvidenceRef, accepted.receipt.receiptRef);
  assert.equal(f.task.current?.status, 'doing');
  const returns = f.store.returns.pending();
  assert.equal(returns.length, 2);
  assert.equal(returns[1]?.receiptRef, accepted.receipt.receiptRef);
  assert.equal(returns[1]?.taskId, 'task-cover');
  assert.equal(returns[1]?.expectedTaskRevision, 2);
  assert.equal(returns[1]?.targetCatId, 'codex-astra');
  const currentTask = f.task.current;
  assert.ok(currentTask?.entrustedWork);
  f.task.current = {
    ...currentTask,
    status: 'done',
    entrustedWork: {
      ...currentTask.entrustedWork,
      revision: 3,
      closure: {
        ...currentTask.entrustedWork.closure,
        state: 'satisfied',
        evidenceRefs: [accepted.receipt.receiptRef],
      },
    },
  };
  assert.equal((await f.service.read(view.review.reviewId, reviewHuman)).authority.state, 'task_closed');
  assert.deepEqual((await f.service.act(decision, reviewHuman)).receipt, accepted.receipt);
  assert.equal(f.store.returns.pending().length, 2);
  assert.ok((await f.service.history(view.review.reviewId, reviewHuman)).entries.length > 5);
});

test('owner commit followed by a projection crash recovers once after restart and replays the original operation', async (t) => {
  const f = await fixture(t);
  const view = await annotate(f.service, await f.service.prepare(f.prepareRequest, reviewHuman));
  const response = await newVersion(f, view);
  const database = new Database(f.path);
  database.exec(
    "CREATE TRIGGER crash_projection BEFORE INSERT ON artifact_review_operations WHEN NEW.operation_id = 'respond-with-second-version' BEGIN SELECT RAISE(ABORT, 'projection crash'); END",
  );
  await assert.rejects(f.service.respond(response, reviewCat), /projection crash/);
  assert.equal((await f.owner.load(view.review.contentRef)).ownerRevision, 2);
  assert.equal(f.store.get(view.review.reviewId)?.rounds.length, 1);
  assert.ok(f.store.pendingVersion(view.review.reviewId));
  database.exec('DROP TRIGGER crash_projection');
  database.close();
  const restartedStore = new ArtifactReviewStore(f.path);
  const restarted = new ArtifactReviewService({ store: restartedStore, media: f.media });
  const recovered = await restarted.read(view.review.reviewId, reviewHuman);
  assert.equal(recovered.review.rounds.length, 2);
  assert.equal(recovered.pendingVersion, false);
  assert.equal((await f.owner.listOutbox(view.review.contentRef)).length, 2);
  const replay = await restarted.respond(response, reviewCat);
  assert.equal(replay.receipt.outcome, 'applied');
  assert.equal(replay.view.review.rounds.length, 2);
  restartedStore.close();
});

test('a Task revision change during asynchronous authorization cannot commit a stale annotation', async (t) => {
  const f = await fixture(t);
  const view = await f.service.prepare(f.prepareRequest, reviewHuman);
  const original = f.media.currentRevision.bind(f.media);
  f.media.currentRevision = async (...args) => {
    const result = await original(...args);
    const task = f.task.current;
    assert.ok(task?.entrustedWork);
    f.task.current = { ...task, entrustedWork: { ...task.entrustedWork, revision: 2 } };
    return result;
  };
  await assert.rejects(annotate(f.service, view), /task_changed/);
  assert.equal(f.store.get(view.review.reviewId)?.rounds[0]?.annotations.length, 0);
});

test('recovery rejects an owner operation whose actor or source does not prove the accepted version response', async (t) => {
  const f = await fixture(t);
  const view = await annotate(f.service, await f.service.prepare(f.prepareRequest, reviewHuman));
  const response = await newVersion(f, view);
  f.store.reserveVersion(f.service.versions.mutation(response, reviewCat.actor, 1), response);
  await f.owner.settle({
    contentRef: view.review.contentRef,
    expectedOwnerRevision: 1,
    operationId: `review-version:${view.review.reviewId}:${response.operationId}`,
    bytes: f.png,
    actor: reviewHuman.actor,
    sourcePublication: view.review.rounds[0]?.asset.sourcePublication,
  });
  await assert.rejects(f.service.read(view.review.reviewId, reviewHuman), /operation_reused/);
  assert.equal(f.store.get(view.review.reviewId)?.rounds.length, 1);
  assert.ok(f.store.pendingVersion(view.review.reviewId));
});

test('a new media version and a human judgment racing on the same revision cannot both commit', async (t) => {
  const f = await fixture(t);
  let view = await annotate(f.service, await f.service.prepare(f.prepareRequest, reviewHuman));
  view = (
    await f.service.act(
      command(view, { kind: 'request_judgment', summary: '本版待确认', judgmentNeeded: '请确认这一版' }),
      reviewCat,
    )
  ).view;
  const response = await newVersion(f, view);
  const decision = command(view, { kind: 'decide', outcome: 'approved', explanation: '确认这一版。' });
  const results = await Promise.allSettled([
    f.service.respond(response, reviewCat),
    f.service.act(decision, reviewHuman),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const actual = await f.service.read(view.review.reviewId, reviewHuman);
  if (actual.review.rounds.length === 2) {
    assert.equal(actual.review.rounds[0]?.decision, undefined);
    assert.equal(f.store.returns.pending().length, 0);
  } else {
    assert.equal(actual.review.rounds[0]?.decision?.outcome, 'approved');
    assert.equal((await f.owner.load(view.review.contentRef)).ownerRevision, 1);
  }
});
