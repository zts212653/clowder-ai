import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { ProjectMessageCatGrants } from '../src/domains/collaborative-content/workspace-review/project-message/cat-grants.js';
import { VideoProjectService } from '../src/domains/video-studio/project/service.js';
import { projectTakeoverFixture as fixture } from './helpers/video-project-message-takeover.js';

test('F326 original project-screening Human message is recognized by the canonical content takeover resolver', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const resolved = await f.resolver({ sourceMessageId: f.message.id, operationId: randomUUID() });
  assert.equal(resolved.payload.source.kind, 'video-project');
  assert.equal(resolved.payload.intent.body, f.message.content);
  assert.equal(f.tasks.listByThread(f.message.threadId).length, 0, 'resolution/import alone is Task-free');
});

test('F326 explicit project takeover binds one real Task and Cat acknowledgement without another chat send', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const before = f.store.ledgers.getByContent(f.principal.userId, f.request.contentRef);
  assert.ok(before);
  const result = await f.requests.takeOver({ sourceMessageId: f.message.id, operationId: randomUUID() }, f.principal);
  assert.equal(result.stage, 'accepted');
  assert.equal(result.record.progress.prepared?.kind, 'project');
  assert.equal(f.tasks.listByThread(f.message.threadId).length, 1);
  const taskId = result.record.progress.task?.taskId;
  assert.ok(taskId);
  const task = f.tasks.get(taskId);
  assert.ok(task?.entrustedWork);
  assert.equal(task.ownerCatId, f.principal.actor.actorId);
  assert.deepEqual(task.entrustedWork.admission.sourceRefs, [`message:${f.message.id}`]);
  const review = f.store.ledgers.get(before.reviewId);
  assert.ok(review);
  assert.equal(review.annotations.length, 1);
  assert.equal(review.annotations[0]?.projectHistory?.at(-1)?.kind, 'replied');
  assert.deepEqual(review.annotations[0]?.projectHistory?.at(-1)?.actor, f.principal.actor);
  assert.equal(f.messages.getByThread(f.message.threadId).length, 1, 'Human original and no resend');
  const repeat = await f.requests.takeOver({ sourceMessageId: f.message.id, operationId: randomUUID() }, f.principal);
  assert.equal(repeat.record.requestId, result.record.requestId);
  assert.equal(f.tasks.listByThread(f.message.threadId).length, 1);
  assert.equal(f.store.ledgers.get(before.reviewId)?.revision, review.revision);
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
  const snapshot = await projects.load({ principal: f.principal, contentRef: f.request.contentRef });
  snapshot.document.title = 'Actual Cat edit';
  const changed = await projects.save({
    principal: f.principal,
    contentRef: f.request.contentRef,
    expectedOwnerRevision: snapshot.ownerRevision,
    document: snapshot.document,
    operationId: 'cat-real-save',
  });
  assert.deepEqual(changed.actor, f.principal.actor);
  assert.deepEqual(f.errors, []);
  const source = f.messages.getById(f.message.id);
  assert.ok(source);
  source.content = 'Changed source';
  await assert.rejects(
    grants.authorize({ principal: f.principal, contentRef: f.request.contentRef, permission: 'write' }),
    { code: 'access_denied' },
  );
});

for (const flaw of [
  'unmentioned',
  'unrelated-child',
  'parent-only',
  'terminal-child',
  'queued',
  'withdrawn',
  'changed',
  'thread-denied',
] as const)
  test(`F326 explicit project takeover rejects ${flaw} without creating a Task`, async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const source = f.messages.getById(f.message.id);
    assert.ok(source);
    const principal = { ...f.principal };
    if (flaw === 'unmentioned') source.mentions = [];
    if (flaw === 'unrelated-child') {
      f.turns.createRunning({
        invocationId: 'other-child',
        parentInvocationId: 'parent-1',
        userId: principal.userId,
        catId: principal.actor.actorId,
        threadId: principal.threadId,
        startedAt: Date.now(),
        executionKind: 'ordinary',
        causal: {},
      });
      principal.invocationId = 'other-child';
    }
    if (flaw === 'parent-only') principal.invocationId = 'parent-1';
    if (flaw === 'terminal-child')
      f.turns.transitionTerminal(principal.invocationId, { status: 'succeeded', endedAt: Date.now() });
    if (flaw === 'queued') source.deliveryStatus = 'queued';
    if (flaw === 'withdrawn') source.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };
    if (flaw === 'changed') source.content = 'Edited after original mark';
    if (flaw === 'thread-denied')
      f.authority.authorizeSource = async () => {
        throw Object.assign(new Error('Denied'), { code: 'access_denied' });
      };
    await assert.rejects(f.requests.takeOver({ sourceMessageId: f.message.id, operationId: randomUUID() }, principal));
    assert.equal(f.tasks.listByThread(f.message.threadId).length, 0);
  });

test('F326 project takeover rejects a client-fabricated direct submit, retaining only the original Human message', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const source = await f.resolver({ sourceMessageId: f.message.id, operationId: randomUUID() });
  await assert.rejects(
    f.requests.submit(source.payload, {
      userId: f.principal.userId,
      actor: { kind: 'human', actorId: f.principal.userId },
    }),
    { code: 'invalid_progress' },
  );
  assert.equal(f.tasks.listByThread(f.message.threadId).length, 0);
});

test('F326 interrupted project Task admission recovers one Task and one canonical reply from the same SQLite journal', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const advance = f.store.requests.advance.bind(f.store.requests);
  let fail = true;
  f.store.requests.advance = (id, token, patch, now) => {
    if (patch.task && fail) {
      fail = false;
      throw new Error('Simulated DB interruption after real Task admission');
    }
    return advance(id, token, patch, now);
  };
  await assert.rejects(
    f.requests.takeOver({ sourceMessageId: f.message.id, operationId: randomUUID() }, f.principal),
    /Simulated DB interruption/,
  );
  assert.equal(f.tasks.listByThread(f.message.threadId).length, 1);
  const [pending] = f.store.requests.pending();
  assert.ok(pending);
  assert.equal(pending.progress.task, undefined);
  f.store.close();
  const restarted = new ArtifactReviewStore(join(f.root, 'artifact-reviews.sqlite'));
  t.after(() => restarted.close());
  const loaded = restarted.requests.get(pending.requestId, f.principal.userId);
  assert.ok(loaded);
  const recovered = await f
    .makeProject(restarted)
    .resume(loaded, { userId: f.principal.userId, actor: { kind: 'human', actorId: f.principal.userId } });
  assert.equal(recovered.stage, 'accepted');
  assert.equal(f.tasks.listByThread(f.message.threadId).length, 1);
  const source = recovered.record.payload.source;
  assert.equal(source.kind, 'video-project');
  if (source.kind !== 'video-project') throw new Error('Expected project source');
  const annotation = restarted.ledgers.get(source.reviewId)?.annotations[0];
  assert.equal(annotation?.replies.length, 1);
});

test('F326 project acknowledgement and journal review receipt roll back together on failed binding', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const bind = f.store.requests.bindReview.bind(f.store.requests);
  let fail = true;
  f.store.requests.bindReview = (id, token, commit, now) =>
    bind(
      id,
      token,
      () => {
        const receipt = commit();
        if (fail) {
          fail = false;
          throw new Error('Simulated crash in atomic bind');
        }
        return receipt;
      },
      now,
    );
  await assert.rejects(
    f.requests.takeOver({ sourceMessageId: f.message.id, operationId: randomUUID() }, f.principal),
    /Simulated crash/,
  );
  assert.equal(
    f.store.ledgers.getByContent(f.principal.userId, f.request.contentRef)?.annotations[0]?.replies.length,
    0,
  );
  const result = await f.requests.takeOver({ sourceMessageId: f.message.id, operationId: randomUUID() }, f.principal);
  assert.equal(result.stage, 'accepted');
  assert.equal(f.tasks.listByThread(f.message.threadId).length, 1);
  assert.equal(
    f.store.ledgers.getByContent(f.principal.userId, f.request.contentRef)?.annotations[0]?.replies.length,
    1,
  );
});

test('F326 multiple real causal sources select the accepted canonical Task instead of a preceding read-only mark', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const second = f.messages.append({
    userId: f.principal.userId,
    from: { kind: 'user', userId: f.principal.userId },
    threadId: f.message.threadId,
    mentions: [f.principal.actor.actorId],
    content: 'Please take over this second opening opinion',
    timestamp: Date.now() + 1,
    contentBlocks: [{ type: 'context_attachment', attachment: f.attachment }],
  });
  await f.importer.synchronize({
    principal: f.request.principal,
    contentRef: f.request.contentRef,
    threadId: second.threadId,
  });
  f.turns.bindCoveredMessageIds(f.principal.invocationId, [f.message.id, second.id]);
  const accepted = await f.requests.takeOver({ sourceMessageId: second.id, operationId: randomUUID() }, f.principal);
  assert.equal(accepted.stage, 'accepted');
  const grants = new ProjectMessageCatGrants({
    turns: f.turns,
    authority: f.authority,
    ledgers: f.store.ledgers,
    takeover: f.project,
  });
  await grants.authorize({ principal: f.principal, contentRef: f.request.contentRef, permission: 'write' });
  assert.equal((await grants.sourceWitness(f.principal, f.request.contentRef)).sourceMessageId, second.id);
});

test('F326 an 8000-character canonical opinion remains complete through Task takeover without silent truncation', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const long = f.messages.append({
    userId: f.principal.userId,
    from: { kind: 'user', userId: f.principal.userId },
    threadId: f.message.threadId,
    mentions: [f.principal.actor.actorId],
    content: '改'.repeat(8000),
    timestamp: Date.now() + 1,
    contentBlocks: [{ type: 'context_attachment', attachment: f.attachment }],
  });
  await f.importer.synchronize({
    principal: f.request.principal,
    contentRef: f.request.contentRef,
    threadId: long.threadId,
  });
  f.turns.bindCoveredMessageIds(f.principal.invocationId, [f.message.id, long.id]);
  const result = await f.requests.takeOver({ sourceMessageId: long.id, operationId: randomUUID() }, f.principal);
  assert.equal(result.stage, 'accepted');
  assert.equal(result.record.payload.intent.body, long.content);
  assert.equal(result.record.payload.intent.selections?.[0]?.instruction, long.content);
  const taskId = result.record.progress.task?.taskId;
  assert.ok(taskId);
  const task = f.tasks.get(taskId);
  assert.ok(task?.entrustedWork);
  assert.ok(task.entrustedWork.intendedOutcome.length <= 4000);
  assert.ok(task.entrustedWork.admission.sourceRefs.includes(`message:${long.id}`));
});

test('F326 a Task owner change during asynchronous source validation revokes the existing project write grant', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const accepted = await f.requests.takeOver({ sourceMessageId: f.message.id, operationId: randomUUID() }, f.principal);
  const grants = new ProjectMessageCatGrants({
    turns: f.turns,
    authority: f.authority,
    ledgers: f.store.ledgers,
    takeover: f.project,
  });
  const witness = await grants.sourceWitness(f.principal, f.request.contentRef);
  const taskId = accepted.record.progress.task?.taskId;
  assert.ok(taskId);
  const task = f.tasks.get(taskId);
  assert.ok(task);
  const authorize = f.authority.authorizeSource;
  f.authority.authorizeSource = async (input) => {
    await authorize(input);
    task.ownerCatId = 'codex' as typeof task.ownerCatId;
  };
  assert.equal(await f.project.hasGrant(witness), false);
});
