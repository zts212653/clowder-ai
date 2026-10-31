import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { ContentTextModificationService } from '../src/domains/collaborative-content/modification/text/text-service.js';
import { ProjectMessageCatGrants } from '../src/domains/collaborative-content/workspace-review/project-message/cat-grants.js';
import { VideoProjectReviewService } from '../src/domains/collaborative-content/workspace-review/video-project-review-service.js';
import { PublishedMediaAccess } from '../src/domains/video-studio/content-owner/published-media-access.js';
import { VideoProjectSelfReviewService } from '../src/domains/video-studio/project/self-review.js';
import { VideoProjectService } from '../src/domains/video-studio/project/service.js';
import { registerCallbackContentModificationRoutes } from '../src/routes/callback-content-modification-routes.js';
import { registerCallbackVideoProjectCommandRoutes } from '../src/routes/callback-video-project-command-routes.js';
import { projectTakeoverFixture } from './helpers/video-project-message-takeover.js';

async function fixture() {
  const f = await projectTakeoverFixture();
  const app = Fastify();
  const registry = new InvocationRegistry();
  const auth = await registry.create(f.principal.userId, f.principal.actor.actorId, f.message.threadId);
  f.turns.createRunning({
    invocationId: auth.invocationId,
    parentInvocationId: 'real-parent',
    userId: f.principal.userId,
    catId: f.principal.actor.actorId,
    threadId: f.message.threadId,
    startedAt: Date.now(),
    executionKind: 'ordinary',
    causal: { triggerMessageId: f.message.id },
  });
  const grants = new ProjectMessageCatGrants({
    turns: f.turns,
    authority: f.authority,
    ledgers: f.store.ledgers,
    takeover: f.project,
  });
  const projects = new VideoProjectService({
    owner: f.owner,
    ownerUserId: f.principal.userId,
    authorizeCat: grants.authorize,
  });
  const reviews = new VideoProjectReviewService({ projects, store: f.store.ledgers, messageAuthority: f.authority });
  const selfReviews = new VideoProjectSelfReviewService({
    projects,
    appendSelfReview: (command) => projects.appendSelfReview(command),
    authorizeSource: async (command) => {
      const witness = await grants.sourceWitness(command.principal, command.contentRef);
      assert.ok(await f.project.hasGrant(witness));
      return { refs: [`message:${witness.sourceMessageId}`] };
    },
  });
  const text = new ContentTextModificationService({
    store: f.store,
    messages: f.messages,
    source: f.workspace,
    access: new PublishedMediaAccess({ tasks: f.tasks, threads: f.threads }),
    executionDirectory: join(f.root, 'isolated-execution'),
  });
  await registerCallbackContentModificationRoutes(app, {
    text,
    requests: f.requests,
    threads: f.threads,
    registry,
    changed: () => {},
  });
  await registerCallbackVideoProjectCommandRoutes(app, {
    takeover: f.project,
    projects,
    reviews,
    selfReviews,
    registry,
    threads: f.threads,
  });
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const takeover = () =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/content-modification/take-over',
      headers,
      payload: { sourceMessageId: f.message.id, operationId: randomUUID() },
    });
  const command = (requestId: string, value: unknown, authorization = headers) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/video-project/command',
      headers: authorization,
      payload: { requestId, command: value },
    });
  return {
    ...f,
    app,
    headers,
    auth,
    takeover,
    command,
    async cleanup() {
      await app.close();
      await f.cleanup();
    },
  };
}

test('F326 callback authenticity and actual canonical takeover precede project commands', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const missing = await f.command('not-a-takeover', { kind: 'read' });
  assert.equal(missing.statusCode, 404, missing.body);
  const accepted = await f.takeover();
  assert.equal(accepted.statusCode, 200, accepted.body);
  const id = accepted.json().record.requestId;
  assert.equal(accepted.json().stage, 'accepted');
  assert.equal(f.tasks.listByThread(f.message.threadId).length, 1);
  const badAuth = await f.command(id, { kind: 'read' }, { ...f.headers, 'x-callback-token': 'forged' });
  assert.equal(badAuth.statusCode, 401);
  const read = await f.command(id, { kind: 'read' });
  assert.equal(read.statusCode, 200, read.body);
  const snapshot = JSON.parse(read.json().json);
  assert.equal(snapshot.contentRef, f.request.contentRef);
  assert.equal(snapshot.ownerRevision, 2);
  const stale = await f.command(id, {
    kind: 'save',
    expectedOwnerRevision: 1,
    operationId: 'stale-project-edit',
    document: (
      await f.projects.load({ principal: f.request.principal, contentRef: f.request.contentRef, ownerRevision: 1 })
    ).document,
  });
  assert.equal(stale.statusCode, 409, stale.body);
  snapshot.document.timeline.segments[0].label = 'Actual semantic segment edit';
  const saved = await f.command(id, {
    kind: 'save',
    expectedOwnerRevision: 2,
    operationId: 'project-edit',
    document: snapshot.document,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().receipt.actor.kind, 'cat');
  const review = await f.command(id, { kind: 'review-read' });
  assert.equal(review.statusCode, 200, review.body);
  const view = JSON.parse(review.json().json);
  const annotation = view.review.annotations[0];
  assert.ok(annotation);
  const actual = await f.command(id, {
    kind: 'review-act',
    expectedRevision: view.review.revision,
    operationId: 'prove-edited-range',
    action: {
      kind: 'addressed',
      annotationId: annotation.id,
      result: {
        contentRef: saved.json().receipt.contentRef,
        ownerRevision: saved.json().receipt.ownerRevision,
        blobDigest: saved.json().receipt.blobDigest,
        operationId: saved.json().receipt.operationId,
      },
    },
  });
  // Segment labels do not prove rendering change in this moment range; the canonical proof rejects them.
  assert.equal(actual.statusCode, 400, actual.body);
  assert.equal(actual.json().error, 'invalid_action');
  const honest = await f.command(id, {
    kind: 'review-act',
    expectedRevision: view.review.revision,
    operationId: 'honest-not-changed',
    action: {
      kind: 'addressed',
      annotationId: annotation.id,
      result: { kind: 'not-changed', reason: 'This input changed labels only; no rendered range changed.' },
    },
  });
  assert.equal(honest.statusCode, 200, honest.body);
  const otherOpinion = await f.command(id, {
    kind: 'review-act',
    expectedRevision: honest.json().review.revision,
    operationId: 'unbound-opinion',
    action: { kind: 'resolved', annotationId: 'someone-elses-opinion' },
  });
  assert.equal(otherOpinion.statusCode, 404, otherOpinion.body);
  const selfReview = await f.command(id, {
    kind: 'self-review',
    expectedOwnerRevision: 3,
    operationId: 'self-review',
    id: 'checked-original',
    input: f.attachment.input,
    segmentIds: ['C01'],
    conclusion: 'changes-requested',
    refs: ['actual-self-review:callback'],
  });
  assert.equal(selfReview.statusCode, 200, selfReview.body);
  assert.equal(selfReview.json().selfReview.actor.actorId, f.principal.actor.actorId);
  assert.equal(f.messages.getByThread(f.message.threadId).length, 1);
  const source = f.messages.getById(f.message.id);
  assert.ok(source);
  source.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };
  const denied = await f.command(id, { kind: 'read' });
  assert.equal(denied.statusCode, 403, denied.body);
});

test('F326 callback project JSON reads are complete, bounded and fenced against a changed owner revision', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const current = await f.projects.load({ principal: f.request.principal, contentRef: f.request.contentRef });
  current.document.tags = Array.from({ length: 80 }, (_, i) => `tag-${i}-${'q'.repeat(110)}`);
  await f.projects.save({
    principal: f.request.principal,
    contentRef: f.request.contentRef,
    expectedOwnerRevision: current.ownerRevision,
    operationId: 'large-input',
    document: current.document,
  });
  const accepted = await f.takeover();
  assert.equal(accepted.statusCode, 200, accepted.body);
  const id = accepted.json().record.requestId;
  let json = '',
    cursor = 0;
  let snapshot: string | undefined;
  let count = 0;
  do {
    const response = await f.command(id, { kind: 'read', cursor, ...(snapshot ? { expectedSnapshot: snapshot } : {}) });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.body.length <= 12000);
    const page = response.json();
    snapshot = page.snapshot;
    json += page.json;
    count++;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  } while (count < 10);
  assert.ok(count > 1);
  assert.equal(JSON.parse(json).document.tags.length, 80);
  const noFence = await f.command(id, { kind: 'read', cursor: 6000 });
  assert.equal(noFence.statusCode, 409, noFence.body);
  const head = await f.projects.load({ principal: f.request.principal, contentRef: f.request.contentRef });
  head.document.title = 'New revision';
  await f.projects.save({
    principal: f.request.principal,
    contentRef: f.request.contentRef,
    expectedOwnerRevision: head.ownerRevision,
    operationId: 'head-change',
    document: head.document,
  });
  const stale = await f.command(id, { kind: 'read', cursor: 6000, expectedSnapshot: snapshot });
  assert.equal(stale.statusCode, 409, stale.body);
  const historical = await f.command(id, { kind: 'read', ownerRevision: 3 });
  assert.equal(historical.statusCode, 200, historical.body);
});

test('F326 project JSON consumer refuses an over-16MiB snapshot with the typed 413 response', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const { projectCommandJsonPage } = await import(
    '../src/domains/collaborative-content/modification/project/json-page.js'
  );
  const { replyContentModificationError } = await import('../src/routes/content-modification-routes.js');
  app.get('/bounded-consumer', (_request, reply) => {
    try {
      return projectCommandJsonPage(
        'actual-request',
        'project-input',
        { cursor: 0 },
        { document: 'x'.repeat(16 * 1024 * 1024) },
      );
    } catch (error) {
      return replyContentModificationError(reply, error);
    }
  });
  const response = await app.inject({ method: 'GET', url: '/bounded-consumer' });
  assert.equal(response.statusCode, 413, response.body);
  assert.equal(response.json().error, 'too_large');
});

test('F326 project takeover supports content-free control without the media-only reviewId selector', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const accepted = await f.takeover();
  assert.equal(accepted.statusCode, 200, accepted.body);
  const record = accepted.json().record;
  const control = (extra: { reviewId?: string } = {}) =>
    f.app.inject({
      method: 'POST',
      url: '/api/callbacks/content-modification/read',
      headers: f.headers,
      payload: { requestId: record.requestId, view: 'control', ...extra },
    });
  const direct = await control();
  assert.equal(direct.statusCode, 200, direct.body);
  const result = JSON.parse(direct.json().json);
  assert.equal(result.stage, 'active');
  assert.equal(result.taskId, record.progress.task.taskId);
  assert.equal(result.requestId, record.requestId);
  assert.equal(result.intent, undefined, 'Task control remains content-free');
  const mediaSelector = await control({ reviewId: record.progress.review.reviewId });
  assert.equal(mediaSelector.statusCode, 404, mediaSelector.body);
  assert.equal(mediaSelector.json().error, 'not_found', 'reviewId selector is explicitly media-only');
  const projectState = await f.command(record.requestId, { kind: 'review-read' });
  assert.equal(projectState.statusCode, 200, projectState.body);
  assert.equal(JSON.parse(projectState.json().json).review.reviewId, record.progress.review.reviewId);
});
