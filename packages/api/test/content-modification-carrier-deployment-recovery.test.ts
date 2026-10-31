import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PersistedQueueDeliveryInput } from '../src/domains/cats/services/agents/invocation/PersistedQueueDelivery.js';
import { ArtifactReviewService } from '../src/domains/collaborative-content/artifact-review/service.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { ContentTextModificationService } from '../src/domains/collaborative-content/modification/text/text-service.js';
import { ArtifactReviewReturnDispatcher } from '../src/domains/growing/ArtifactReviewReturnDispatcher.js';
import { PublishedMediaAccess } from '../src/domains/video-studio/content-owner/published-media-access.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { cancellationFixture } from './helpers/content-modification-cancellation-fixture.js';

test('deployment recovery resumes an admitted pre-typed public carrier without replacing its Queue winner', async (t) => {
  const fixture = await cancellationFixture(t);
  const deliver = fixture.dispatch.delivery.deliver.bind(fixture.dispatch.delivery);
  const markQueued = fixture.store.returns.queued.bind(fixture.store.returns);

  fixture.dispatch.delivery.deliver = async (input: PersistedQueueDeliveryInput) => {
    assert.equal(input.visibility, 'public');
    assert.equal(input.source.meta?.kind, 'request_text_edit');
    return deliver({
      ownerAuthProvenance: input.ownerAuthProvenance,
      ownerUserId: input.ownerUserId,
      threadId: input.threadId,
      targetCatId: input.targetCatId,
      idempotencyKey: input.idempotencyKey,
      content: input.content,
      sourceCategory: input.sourceCategory,
      source: {
        connector: 'content-review',
        label: '产物审阅',
        icon: 'cat-cafe',
        meta: {
          reviewReceiptRef: input.source.meta.requestReceiptRef,
          taskId: input.source.meta.taskId,
          requestId: input.source.meta.requestId,
        },
      },
    });
  };
  fixture.store.returns.queued = () => {
    throw new Error('simulated old-version crash before outbox mark');
  };

  const submitted = await fixture.integration.requests.submit(fixture.payload, fixture.human);
  const receiptRef = submitted.record.progress.review?.receiptRef;
  assert.ok(receiptRef);
  assert.equal(fixture.store.returns.get(receiptRef)?.state, 'pending');
  const admitted = fixture.messages
    .getByThread(fixture.thread.id, 100, 'operator', { includeQueuedUserMessages: true })
    .find((message) => message.source?.meta?.requestId === submitted.record.requestId);
  assert.equal(admitted?.lifecycle?.kind, 'input');
  assert.ok(admitted);
  assert.equal(Object.hasOwn(admitted, 'queueCustody'), false);
  await fixture.dispatch.waitForAwakening(admitted.id);

  fixture.dispatch.delivery.deliver = deliver;
  fixture.store.returns.queued = markQueued;
  const reopened = new ArtifactReviewStore(join(fixture.root, 'collaborative-content', 'artifact-reviews.sqlite'));
  t.after(() => reopened.close());
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => ({ root: fixture.root, canonicalWorktreeId: 'work' }),
  });
  const text = new ContentTextModificationService({
    store: reopened,
    access: new PublishedMediaAccess({ tasks: fixture.tasks, threads: fixture.threads }),
    source,
    messages: fixture.messages,
    executionDirectory: join(fixture.root, 'reviewer-restarted-execution'),
  });
  const restarted = new ArtifactReviewReturnDispatcher({
    store: reopened,
    reviews: new ArtifactReviewService({ store: reopened, media: fixture.media }),
    text,
    delivery: fixture.dispatch.delivery,
    invalidate: () => {},
    emit: () => {},
  });

  await restarted.drain();

  assert.equal(reopened.returns.get(receiptRef)?.state, 'queued');
  assert.equal(reopened.returns.get(receiptRef)?.messageId, admitted.id);
  assert.equal(
    fixture.messages
      .getByThread(fixture.thread.id, 100, 'operator', { includeQueuedUserMessages: true })
      .filter((message) => message.source?.meta?.requestId === submitted.record.requestId).length,
    1,
  );
});
