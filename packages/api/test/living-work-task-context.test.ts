import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { deriveGrowingSourceMessageRevision } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { ModificationPublicationGrants } from '../src/domains/collaborative-content/modification/request-authority.js';
import { createWorkAuthorizer } from '../src/domains/collaborative-content/works/access.js';
import { LivingWorkService } from '../src/domains/collaborative-content/works/service.js';
import { createWorkWorkspaceSource } from '../src/domains/collaborative-content/works/workspace-source.js';
import { PublishedMediaAccess } from '../src/domains/video-studio/content-owner/published-media-access.js';
import { registerLivingWorkRoutes } from '../src/routes/living-work-routes.js';
import { createReviewFixture, reviewHuman } from './helpers/artifact-review-fixture.js';
import { screeningFixture } from './helpers/video-project-screening.js';

test('common submission carries the original Task context but only its current exact Human grant authorizes a director', async (t) => {
  const film = await screeningFixture();
  t.after(film.cleanup);
  const store = new ArtifactReviewStore(`${film.root}/work-review.sqlite`);
  const f = createReviewFixture(film.dataDir, film.root, store);
  assert.ok(f.thread.current && f.task.current);
  const directorThread = 'thread-director';
  const threads = new Map([
    ['thread-cover', f.thread.current],
    [directorThread, { ...f.thread.current, id: directorThread }],
  ]);
  f.task.current.threadId = directorThread;
  const access = new PublishedMediaAccess({
    tasks: f.taskStore,
    threads: { get: (id) => threads.get(id) ?? null, list: () => [...threads.values()] },
    publicationGrants: new ModificationPublicationGrants(store.requests, f.messageStore),
  });
  const registry = new InvocationRegistry();
  const auth = await registry.create(
    'operator',
    createCatId('codex-astra'),
    directorThread,
    undefined,
    undefined,
    undefined,
    undefined,
    'strict',
  );
  const service = new LivingWorkService({
    owner: f.owner,
    versions: store.works,
    source: createWorkWorkspaceSource(film.workspace),
    authorize: createWorkAuthorizer({
      ownerUserId: 'operator',
      access,
      invocation: (id) => registry.peekRecord(id),
    }),
  });
  const inspected = await service.inspectSource(
    { worktreeId: 'root', path: 'movie.mp4' },
    { ...reviewHuman, threadId: 'thread-cover' },
  );
  const created = await service.commit(
    {
      action: 'create',
      operationId: 'human-film',
      title: '人交的原片',
      changeSummary: '初版',
      source: inspected.source,
    },
    { ...reviewHuman, threadId: 'thread-cover' },
  );
  const app = Fastify();
  await registerLivingWorkRoutes(app, { service, registry });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const call = (command: unknown, contentTaskId?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/work',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { command, ...(contentTaskId ? { contentTaskId } : {}) },
    });
  await promisify(execFile)(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x96:r=30:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      `${film.root}/new-cut.mp4`,
    ],
    { timeout: 15000 },
  );
  const revised = await service.inspectSource(
    { worktreeId: 'root', path: 'new-cut.mp4' },
    { ...reviewHuman, threadId: 'thread-cover' },
  );
  const submit = {
    action: 'submit',
    contentRef: created.reference.contentRef,
    expectedOwnerRevision: 1,
    operationId: 'director-cut',
    title: '人交的原片',
    changeSummary: '回应原意见',
    source: revised.source,
  };
  assert.equal((await call(submit)).statusCode, 403);
  const read = { action: 'read', reference: created.reference };
  assert.equal((await call(read)).statusCode, 403, 'A fixed reference grants no cross-thread read');

  // The regular F309 request journal and live Human message constitute the grant;
  // a mutable Task artifact list, a tool argument or a fixed reference does not.
  const source = {
    kind: 'publication' as const,
    ...created.reference,
    ledgerRef: 'original-ledger',
    expectedLedgerRevision: 1,
  };
  const message = {
    id: 'human-request',
    userId: 'operator',
    threadId: directorThread,
    catId: null,
    from: { kind: 'user' as const, userId: 'operator' },
    content: '请改这段',
    timestamp: 10001,
    mentions: [createCatId('codex-astra')],
  };
  f.messages.set(message.id, message);
  const request = store.requests.reserve('operator', {
    operationId: randomUUID(),
    threadId: directorThread,
    targetCatId: 'codex-astra',
    source,
    intent: { body: message.content },
  });
  const lease = store.requests.acquire(request.requestId, 'operator');
  assert.ok(lease);
  store.requests.advance(request.requestId, lease.token, {
    sourceMessageId: message.id,
    sourceMessageRevision: deriveGrowingSourceMessageRevision(message),
    sourceKind: 'human_message',
    prepared: { kind: 'media', ...created.reference, ledgerRef: source.ledgerRef },
    task: { taskId: 'task-cover', revision: 1, receiptRef: 'original-task-receipt' },
    review: { reviewId: 'original-review', receiptRef: 'original-review-receipt' },
  });
  store.requests.release(request.requestId, lease.token);
  assert.equal((await call(submit)).statusCode, 403, 'Even a real grant must be explicitly selected');
  assert.equal((await call(read, 'task-cover')).statusCode, 200);
  const response = await call(submit, 'task-cover');
  assert.equal(response.statusCode, 200, response.body);
  const saved = JSON.parse(response.json().json);
  assert.equal(saved.reference.ownerRevision, 2);
  assert.equal(saved.reference.contentRef, created.reference.contentRef);
  assert.equal(
    (await call({ ...submit, operationId: 'wrong-context', expectedOwnerRevision: 2 }, 'unrelated-task')).statusCode,
    403,
  );
  f.messages.set(message.id, { ...message, deletedAt: 10002 });
  assert.equal((await call(read, 'task-cover')).statusCode, 403);
  assert.equal(
    (await call(submit, 'task-cover')).statusCode,
    403,
    'A receipt replay never bypasses revoked Human source custody',
  );
  assert.equal((await f.owner.describe(created.reference.contentRef)).currentOwnerRevision, 2);
});
