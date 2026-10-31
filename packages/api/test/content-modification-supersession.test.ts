import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ArtifactReviewView, ContentModificationRequest } from '@cat-cafe/shared';
import sharp from 'sharp';
import { createContentModificationIntegration } from '../src/domains/collaborative-content/modification/composition.js';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

for (const linked of [false, true])
  test(`a new explicit request supersedes only the cancelled decision on the same Task/round (linked=${linked})`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f309-supersession-'));
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: 'blue' } })
      .png()
      .toBuffer();
    await writeFile(join(root, 'review-input.png'), png);
    const source = new WorkspaceContentSourceService({
      ownerUserId: 'operator',
      resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'work' }),
    });
    const f = await createLiveReviewFixture(root, 'image/png', undefined, source);
    const filesStore = new WorkspaceContentReviewStore(join(root, 'files.sqlite'));
    const integration = createContentModificationIntegration({
      dataDir: root,
      source,
      files: new WorkspaceContentReviewService({ store: filesStore, source }),
      artifacts: f,
      tasks: f.tasks,
      messages: f.messages,
      changed: () => {},
      onError: () => {},
    });
    t.after(async () => {
      integration.writer.close();
      filesStore.close();
      await f.dispatch.close();
      f.store.close();
      await rm(root, { recursive: true, force: true });
    });
    if (linked) {
      const asset = await f.media.prepare({ ...f.prepare, principal: f.human });
      await f.ledgers!.prepare({ principal: f.human, publication: asset, operationId: 'existing-ledger' });
    }
    const initial = await f.reviews.prepare(f.prepare, f.human);
    assert.equal(Boolean(initial.review.rounds[0]!.ledgerRef), linked);
    const requestFor = (view: ArtifactReviewView, body: string): ContentModificationRequest => {
      const round = view.review.rounds.at(-1)!;
      return {
        operationId: randomUUID(),
        targetCatId: 'codex-astra',
        threadId: f.thread.id,
        intent: { body },
        taskContext: {
          kind: 'media',
          taskId: f.taskId,
          expectedTaskRevision: view.authority.taskRevision,
          reviewId: view.review.reviewId,
          expectedReviewRevision: view.review.revision,
          round: round.number,
        },
        source: round.ledgerRef
          ? {
              kind: 'publication',
              contentRef: round.asset.contentRef,
              ownerRevision: round.asset.ownerRevision,
              ledgerRef: round.ledgerRef,
              expectedLedgerRevision: round.ledgerRevision!,
            }
          : {
              kind: 'artifact-review',
              reviewId: view.review.reviewId,
              round: round.number,
              expectedReviewRevision: view.review.revision,
            },
      };
    };
    const first = await integration.requests.submit(requestFor(initial, '第一次明确请求'), f.human);
    assert.equal(first.stage, 'queued');
    const beforeCancel = await f.reviews.read(initial.review.reviewId, f.human);
    const cancellation = await integration.requests.cancel(first.record.requestId, f.human);
    assert.equal(cancellation.record.control?.taskResolution, 'preserved');
    const taskBefore = structuredClone(await f.tasks.get(f.taskId));
    const beforeNew = await f.reviews.read(initial.review.reviewId, f.human);
    const nextCommand = requestFor(beforeNew, '旧请求已取消，现在按这个新说明修改');
    const contexts = await integration.context.read(nextCommand.source, f.human);
    assert.ok(contexts.contexts[0]?.taskContext, 'a cancelled decision has an explicit same-Task continuation');
    const second = await integration.requests.submit(nextCommand, f.human);
    assert.equal(second.stage, 'queued', JSON.stringify(second.record.issue));
    const after = await f.reviews.read(initial.review.reviewId, f.cat);
    const round = after.review.rounds.at(-1)!;
    assert.equal(second.record.progress.task?.taskId, f.taskId);
    assert.deepEqual(await f.tasks.get(f.taskId), taskBefore);
    assert.equal(round.number, 1);
    assert.equal(round.ledgerRef, initial.review.rounds[0]!.ledgerRef);
    assert.equal(round.decision?.receiptRef, second.record.progress.review?.receiptRef);
    const history = f.store.history(after.review.reviewId);
    const change = history.find((item) => item.receipt.receiptRef === second.record.progress.review?.receiptRef)!;
    assert.equal(change.kind, 'supersede_request');
    const detail = change.detail as {
      predecessor: { decision: { receiptRef: string } };
      request: { supersedes: { requestId: string; cancellationReceiptRef: string } };
    };
    assert.equal(detail.predecessor.decision.receiptRef, first.record.progress.review?.receiptRef);
    assert.equal(detail.request.supersedes.requestId, first.record.requestId);
    assert.equal(detail.request.supersedes.cancellationReceiptRef, cancellation.record.control?.receiptRef);
    assert.equal(f.store.returns.get(second.record.progress.review!.receiptRef)?.requestId, second.record.requestId);
    await writeFile(join(root, 'returned.png'), png);
    const publication = f.publish('returned.png');
    const response = {
      reviewId: after.review.reviewId,
      expectedRevision: after.review.revision,
      expectedTaskRevision: after.authority.taskRevision,
      expectedLedgerRevision: round.ledgerRevision,
      expectedOwnerRevision: round.asset.ownerRevision,
      operationId: randomUUID(),
      artifactRef: '/uploads/returned.png',
      expectedArtifactRevision: String(publication.timestamp),
      responses: round.annotations.map((item) => ({
        annotationId: item.id,
        disposition: 'addressed',
        explanation: '按新请求处理，旧请求保留历史。',
      })),
    };
    for (const expectedRevision of [beforeCancel.review.revision, after.review.revision])
      await assert.rejects(
        f.reviews.respond({ ...response, expectedRevision, requestId: first.record.requestId }, f.cat),
        /request_superseded/,
      );
    await assert.rejects(f.reviews.respond(response, f.cat), /request_superseded/);
    const returned = await f.reviews.respond({ ...response, requestId: second.record.requestId }, f.cat);
    assert.equal(returned.view.review.rounds.length, 2);
    assert.deepEqual(await integration.results.candidates(first.record, f.human), []);
    assert.equal((await integration.results.candidates(second.record, f.human)).length, 1);
    assert.equal((await integration.requests.submit(nextCommand, f.human)).record.requestId, second.record.requestId);
  });
