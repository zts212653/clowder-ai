import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { runProjectCommand } from '../src/domains/collaborative-content/modification/project/command.js';
import { VideoProjectSelfReviewService } from '../src/domains/video-studio/project/self-review.js';
import { projectTakeoverFixture } from './helpers/video-project-message-takeover.js';

for (const method of ['act', 'annotate', 'refresh'] as const)
  for (const revoked of ['owner', 'done', 'source', 'none'] as const)
    test(`F326 final ${method} authority observes late ${revoked} revocation before canonical commit`, async (t) => {
      const f = await projectTakeoverFixture();
      t.after(f.cleanup);
      const accepted = await f.requests.takeOver(
        { sourceMessageId: f.message.id, operationId: randomUUID() },
        f.principal,
      );
      const source = accepted.record.payload.source;
      if (source.kind !== 'video-project') throw new Error('Expected project source');
      const taskId = accepted.record.progress.task?.taskId;
      assert.ok(taskId);
      const annotationId = source.annotationIds[0];
      assert.ok(annotationId);
      const view = await f.importer.reviews.read({ principal: f.principal, reviewId: source.reviewId });
      const before = structuredClone(f.store.ledgers.get(source.reviewId));
      const snapshot = await f.projects.load({ principal: f.principal, contentRef: source.contentRef });
      const authorize = f.projects.authorize.bind(f.projects);
      let successfulWrites = 0;
      let reachedWindow = false;
      f.projects.authorize = async (input) => {
        await authorize(input);
        if (input.permission !== 'write' || ++successfulWrites !== 3) return;
        reachedWindow = true;
        const task = f.tasks.get(taskId);
        assert.ok(task);
        if (revoked === 'owner') task.ownerCatId = createCatId('codex');
        if (revoked === 'done') task.status = 'done';
        if (revoked === 'source') {
          const message = f.messages.getById(f.message.id);
          assert.ok(message);
          message.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };
        }
      };
      const operationId = `final-${method}-${revoked}`;
      const input = {
        principal: f.principal,
        reviewId: source.reviewId,
        expectedRevision: view.review.revision,
        operationId,
      };
      const selfReviews = new VideoProjectSelfReviewService({
        projects: f.projects,
        appendSelfReview: (command) => f.projects.appendSelfReview(command),
        authorizeSource: async () => {
          throw new Error('This journey never attests a self-review');
        },
      });
      const operation = () => {
        if (method === 'act')
          return runProjectCommand(
            { projects: f.projects, reviews: f.importer.reviews, takeover: f.project, selfReviews },
            {
              requestId: accepted.record.requestId,
              command: {
                kind: 'review-act',
                expectedRevision: input.expectedRevision,
                operationId,
                action: { kind: 'replied', annotationId, replyId: operationId, body: 'Keep original authority' },
              },
            },
            f.principal,
          );
        if (method === 'annotate')
          return f.importer.reviews.annotate({
            ...input,
            body: 'New actual project opinion',
            target: { kind: 'project' },
          });
        return f.importer.reviews.refresh({ ...input, expectedOwnerRevision: snapshot.ownerRevision });
      };
      if (revoked === 'none') {
        await operation();
        assert.ok(f.store.ledgers.operationReceipt(source.reviewId, operationId));
      } else {
        await assert.rejects(operation, (error: unknown) => {
          if (error === null || typeof error !== 'object' || !('code' in error)) return false;
          return error.code === 'access_denied' || (revoked === 'source' && error.code === 'revision_conflict');
        });
        assert.equal(f.store.ledgers.operationReceipt(source.reviewId, operationId), null);
        assert.deepEqual(
          f.store.ledgers.get(source.reviewId),
          before,
          'Denied writes create no reply, opinion or refresh',
        );
      }
      assert.equal(reachedWindow, true, 'The real final asynchronous authority window must be reached');
    });

for (const window of ['metadata', 'original-message'] as const)
  test(`F326 current Task grant is rechecked after the actual ${window} authorization await`, async (t) => {
    const f = await projectTakeoverFixture();
    t.after(f.cleanup);
    const accepted = await f.requests.takeOver(
      { sourceMessageId: f.message.id, operationId: randomUUID() },
      f.principal,
    );
    const source = accepted.record.payload.source;
    if (source.kind !== 'video-project') throw new Error('Expected project source');
    const taskId = accepted.record.progress.task?.taskId;
    assert.ok(taskId);
    const before = structuredClone(f.store.ledgers.get(source.reviewId));
    let inGrant = 0;
    let sourceAuthorized = false;
    let reachedWindow = false;
    const revoke = () => {
      if (reachedWindow) return;
      reachedWindow = true;
      const task = f.tasks.get(taskId);
      assert.ok(task);
      task.ownerCatId = createCatId('codex');
    };
    const grant = f.project.hasGrant.bind(f.project);
    f.project.hasGrant = async (witness) => {
      inGrant++;
      try {
        return await grant(witness);
      } finally {
        inGrant--;
      }
    };
    const sourceAccess = f.authority.authorizeSource.bind(f.authority);
    f.authority.authorizeSource = async (
      input: Parameters<typeof sourceAccess>[0] & { permission?: 'read' | 'write' },
    ) => {
      await sourceAccess(input);
      if (input.principal === f.principal && input.permission === 'write') sourceAuthorized = true;
    };
    const message = f.messages.getById.bind(f.messages);
    f.messages.getById = (id) => {
      const current = message(id);
      if (window === 'original-message' && sourceAuthorized && !inGrant && id === f.message.id) revoke();
      return current;
    };
    const describe = f.owner.describe.bind(f.owner);
    f.owner.describe = async (...args) => {
      const metadata = await describe(...args);
      if (window === 'metadata' && !inGrant) revoke();
      return metadata;
    };
    await assert.rejects(
      f.projects.authorize({ principal: f.principal, contentRef: source.contentRef, permission: 'write' }),
      { code: 'access_denied' },
    );
    assert.equal(reachedWindow, true);
    assert.deepEqual(f.store.ledgers.get(source.reviewId), before);
  });
