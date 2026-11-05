import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createCatId } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { deriveGrowingSourceMessageRevision } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ArtifactReviewService } from '../src/domains/collaborative-content/artifact-review/service.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { createWorkAuthorizer, workMediaPrincipal } from '../src/domains/collaborative-content/works/access.js';
import { WorkReviewResponseService } from '../src/domains/collaborative-content/works/review-response.js';
import { createWorkResponseAuthority } from '../src/domains/collaborative-content/works/review-response-authority.js';
import { LivingWorkService } from '../src/domains/collaborative-content/works/service.js';
import { createWorkWorkspaceSource } from '../src/domains/collaborative-content/works/workspace-source.js';
import { reviewReturnMessageProjection } from '../src/domains/growing/ArtifactReviewReturnDispatcher.js';
import { withContentTask } from '../src/domains/video-studio/content-owner/published-media-access.js';
import { registerLivingWorkRoutes } from '../src/routes/living-work-routes.js';
import { createReviewFixture, reviewHuman } from './helpers/artifact-review-fixture.js';
import { screeningFixture } from './helpers/video-project-screening.js';

test('real callback submits one MP4 with original Human feedback and repairs its receipt through the original review read', async (t) => {
  const film = await screeningFixture();
  t.after(film.cleanup);
  const path = `${film.root}/review.sqlite`;
  const store = new ArtifactReviewStore(path);
  const db = new Database(path);
  const f = createReviewFixture(film.dataDir, film.root, store);
  const registry = new InvocationRegistry();
  let credentials = await registry.create(
    'operator',
    createCatId('codex-astra'),
    'thread-cover',
    undefined,
    undefined,
    undefined,
    undefined,
    'strict',
  );
  const human = { ...reviewHuman, threadId: 'thread-cover' };
  const responses = new WorkReviewResponseService({
    store,
    owner: f.owner,
    authorize: createWorkResponseAuthority({ store, media: f.media, messages: f.messageStore }),
    readAsset: (review, revision, principal) =>
      f.media.read(review.contentRef, revision, withContentTask(workMediaPrincipal(principal), review.task.taskId)),
  });
  const service = new LivingWorkService({
    owner: f.owner,
    versions: store.works,
    responses,
    source: createWorkWorkspaceSource(film.workspace),
    authorize: createWorkAuthorizer({
      ownerUserId: 'operator',
      access: f.access,
      invocation: (id) => registry.peekRecord(id),
    }),
  });
  const reviews = new ArtifactReviewService({ store, media: f.media });
  reviews.setWorkResponseRecovery((review, principal) =>
    responses.recover(review, { ...principal, threadId: principal.threadId ?? review.task.threadId }),
  );
  const app = Fastify();
  app.decorateRequest('sessionUserId', null);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId =
      typeof request.headers['x-fixture-user'] === 'string' ? request.headers['x-fixture-user'] : null;
  });
  await registerLivingWorkRoutes(app, { service, registry });
  t.after(async () => {
    await app.close();
    db.close();
    store.close();
  });
  const call = (command: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/work',
      headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
      payload: { command, contentTaskId: 'task-cover' },
    });
  const inspected = await service.inspectSource({ worktreeId: 'root', path: 'movie.mp4' }, human);
  const created = await call({
    action: 'create',
    operationId: 'first',
    title: 'Real film',
    changeSummary: 'first',
    source: inspected.source,
  });
  assert.equal(created.statusCode, 200, created.body);
  const saved = JSON.parse(created.json().json);
  assert.ok(f.task.current?.entrustedWork);
  f.task.current.entrustedWork.artifactRefs = [`content:${saved.reference.contentRef}`];
  const initial = await reviews.prepare(
    {
      taskId: 'task-cover',
      expectedTaskRevision: 1,
      operationId: 'prepare-work',
      artifactRef: `content:${saved.reference.contentRef}`,
      expectedArtifactRevision: '1',
    },
    reviewHuman,
  );
  const first = initial.review.rounds[0]!;
  assert.equal(first.asset.media.kind, 'video');
  if (first.asset.media.kind !== 'video') throw new Error('video required');
  const marked = await reviews.act(
    {
      reviewId: initial.review.reviewId,
      expectedRevision: initial.review.revision,
      expectedTaskRevision: 1,
      expectedLedgerRevision: first.ledgerRevision,
      operationId: 'human-mark',
      round: 1,
      action: {
        kind: 'annotate',
        annotationId: 'original-opinion',
        body: '请修改片头',
        anchor: {
          kind: 'video-range',
          streamId: first.asset.media.streamId,
          startTick: first.asset.media.startTick,
          endTick: first.asset.media.startTick + 1,
        },
      },
    },
    reviewHuman,
  );
  const feedback = await reviews.act(
    {
      reviewId: initial.review.reviewId,
      expectedRevision: marked.view.review.revision,
      expectedTaskRevision: 1,
      expectedLedgerRevision: marked.view.review.rounds[0]?.ledgerRevision,
      operationId: 'human-feedback',
      round: 1,
      action: { kind: 'submit_feedback', explanation: '请修改片头' },
    },
    reviewHuman,
  );
  const round = feedback.view.review.rounds[0]!;
  const message = {
    id: 'original-human-opinion',
    userId: 'operator',
    threadId: 'thread-cover',
    catId: null,
    from: { kind: 'user' as const, userId: 'operator' },
    content: '请修改片头',
    timestamp: 10001,
    mentions: [createCatId('codex-astra')],
    visibility: 'whisper' as const,
    whisperTo: [createCatId('codex-astra')],
  };
  f.messages.set(message.id, message);
  const request = store.requests.reserve('operator', {
    operationId: randomUUID(),
    threadId: 'thread-cover',
    targetCatId: 'codex-astra',
    source: {
      kind: 'publication',
      ...saved.reference,
      ledgerRef: round.ledgerRef!,
      expectedLedgerRevision: round.ledgerRevision!,
    },
    intent: { body: message.content },
  });
  const lease = store.requests.acquire(request.requestId, 'operator');
  assert.ok(lease);
  store.requests.advance(request.requestId, lease.token, {
    sourceMessageId: message.id,
    sourceMessageRevision: deriveGrowingSourceMessageRevision(message),
    sourceKind: 'human_message',
    sourceVisibility: { visibility: 'whisper', whisperTo: ['codex-astra'] },
    prepared: { kind: 'media', ...saved.reference, ledgerRef: round.ledgerRef },
    task: { taskId: 'task-cover', revision: 1, receiptRef: 'original-task-receipt' },
    review: { reviewId: initial.review.reviewId, round: 1, receiptRef: feedback.receipt.receiptRef },
  });
  store.requests.release(request.requestId, lease.token);
  await promisify(execFile)(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x96:r=30:d=0.5',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      `${film.root}/revised.mp4`,
    ],
    { timeout: 15000 },
  );
  const revised = await service.inspectSource({ worktreeId: 'root', path: 'revised.mp4' }, human);
  assert.equal(revised.media?.kind, 'video');
  if (revised.media?.kind !== 'video') throw new Error('video required');
  const command = {
    action: 'submit',
    contentRef: saved.reference.contentRef,
    expectedOwnerRevision: 1,
    operationId: 'revision-and-response',
    title: 'Real film',
    changeSummary: '回应片头意见',
    source: revised.source,
    reviewResponse: {
      reviewId: initial.review.reviewId,
      sourceRound: 1,
      expectedReviewRevision: feedback.view.review.revision,
      expectedTaskRevision: 1,
      expectedLedgerRevision: round.ledgerRevision,
      requestId: request.requestId,
      responses: round.annotations.map((annotation) => ({
        annotationId: annotation.id,
        disposition: 'addressed',
        explanation: '片头已调整',
        resultAnchor: {
          kind: 'video-range',
          streamId: revised.media!.kind === 'video' ? revised.media!.streamId : '',
          startTick: 0,
          endTick: 1,
        },
      })),
    },
  };
  f.messages.set(message.id, { ...message, deletedAt: 10002 });
  assert.equal(
    (await call(command)).statusCode,
    403,
    'Work write identity cannot replace the original live Human source',
  );
  assert.equal((await f.owner.describe(saved.reference.contentRef)).currentOwnerRevision, 1);
  f.messages.set(message.id, message);
  db.exec(
    "CREATE TRIGGER fail_work_metadata BEFORE INSERT ON work_version_annotations WHEN NEW.owner_revision=2 BEGIN SELECT RAISE(ABORT,'projection crash'); END",
  );
  const pending = await call(command);
  assert.equal(pending.statusCode, 503, pending.body);
  assert.equal(pending.json().reference.ownerRevision, 2);
  assert.equal(store.get(initial.review.reviewId)?.rounds.length, 1);
  db.exec('DROP TRIGGER fail_work_metadata');
  await registry.commitTerminal({
    invocationId: credentials.invocationId,
    disposition: 'completed',
    endedAt: Date.now(),
    endReason: 'producer ended after owner commit',
  });
  const recovered = await reviews.read(initial.review.reviewId, reviewHuman);
  assert.equal(recovered.pendingVersion, false);
  assert.equal(recovered.review.rounds.at(-1)?.asset.ownerRevision, 2);
  assert.equal(recovered.review.rounds[0]?.annotations[0]?.state, 'open');
  assert.equal(recovered.review.rounds.at(-1)?.responseSource?.round, 1);
  assert.equal(recovered.review.rounds.at(-1)?.responseSource?.requestId, request.requestId);
  assert.equal((await f.owner.listOutbox(saved.reference.contentRef)).length, 2);
  const again = await call(command);
  assert.equal(again.statusCode, 401, 'Fact recovery does not reactivate a terminal production callback');
  credentials = await registry.create(
    'operator',
    createCatId('codex-astra'),
    'thread-cover',
    undefined,
    undefined,
    undefined,
    undefined,
    'strict',
  );
  const retry = {
    ...command,
    expectedOwnerRevision: 2,
    operationId: 'interrupted-before-owner',
    source: inspected.source,
    reviewResponse: { ...command.reviewResponse, expectedReviewRevision: recovered.review.revision },
  };
  const judged = await reviews.act(
    {
      reviewId: initial.review.reviewId,
      expectedRevision: recovered.review.revision,
      expectedTaskRevision: 1,
      expectedLedgerRevision: recovered.review.rounds[0]?.ledgerRevision,
      round: 2,
      operationId: 'human-accept-response',
      action: {
        kind: 'judge_response',
        sourceRound: 1,
        annotationId: 'original-opinion',
        resultOwnerRevision: 2,
        outcome: 'accepted',
      },
    },
    reviewHuman,
  );
  assert.equal(judged.view.review.rounds[0]?.annotations[0]?.state, 'resolved');
  assert.equal(judged.view.review.rounds[1]?.responses[0]?.judgment?.receiptRef, judged.receipt.receiptRef);
  assert.equal(store.returns.latest(initial.review.reviewId)?.kind, 'judge_response');
  const returned = reviewReturnMessageProjection(store, store.returns.latest(initial.review.reviewId)!);
  assert.equal(returned.visibility, 'whisper', 'Judgment of a whispered request cannot widen its audience');
  assert.ok(returned.visibility === 'whisper');
  assert.deepEqual(returned.whisperTo, ['codex-astra']);
  const reopened = await reviews.act(
    {
      reviewId: initial.review.reviewId,
      expectedRevision: judged.view.review.revision,
      expectedTaskRevision: 1,
      expectedLedgerRevision: judged.view.review.rounds[0]?.ledgerRevision,
      round: 2,
      operationId: 'human-reopen-response',
      action: {
        kind: 'judge_response',
        sourceRound: 1,
        annotationId: 'original-opinion',
        resultOwnerRevision: 2,
        outcome: 'reopened',
      },
    },
    reviewHuman,
  );
  assert.equal(reopened.view.review.rounds[0]?.annotations[0]?.state, 'open');
  retry.reviewResponse.expectedReviewRevision = reopened.view.review.revision;
  retry.reviewResponse.expectedLedgerRevision = reopened.view.review.rounds[0]?.ledgerRevision;
  const settle = f.owner.settleStream.bind(f.owner);
  f.owner.settleStream = async () => {
    throw new Error('injected pre-commit interruption');
  };
  assert.equal((await call(retry)).statusCode, 500);
  f.owner.settleStream = settle;
  const unknown = await reviews.read(initial.review.reviewId, reviewHuman);
  assert.equal(unknown.pendingVersion, true);
  assert.equal(unknown.pendingSubmission?.operationId, retry.operationId);
  assert.equal((await f.owner.describe(saved.reference.contentRef)).currentOwnerRevision, 2);
  const resolution = {
    action: 'resolve-review-submission',
    reviewId: initial.review.reviewId,
    sourceRound: 1,
    expectedReviewRevision: reopened.view.review.revision,
    pendingOperationId: retry.operationId,
    operationId: 'human-resolution',
  };
  assert.equal((await call(resolution)).statusCode, 403);
  const resolve = () =>
    app.inject({
      method: 'POST',
      url: '/api/works/command',
      headers: { 'x-fixture-user': 'operator' },
      payload: { threadId: 'thread-cover', command: resolution },
    });
  const resolved = await resolve();
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.equal(resolved.json().status, 'aborted');
  assert.equal((await resolve()).statusCode, 200, 'an unconfirmed direct Human action replays its own receipt');
  assert.equal((await call(retry)).statusCode, 400, 'the accepted old operation remains terminated');
  assert.equal((await f.owner.listOutbox(saved.reference.contentRef)).length, 2);
});
