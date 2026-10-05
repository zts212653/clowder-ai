import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { createContentModificationIntegration } from '../src/domains/collaborative-content/modification/composition.js';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

async function writeMedia(file: string, kind: 'png' | 'mp4', color: string) {
  if (kind === 'png')
    await writeFile(
      file,
      await sharp({ create: { width: 160, height: 100, channels: 3, background: color } })
        .png()
        .toBuffer(),
    );
  else
    await promisify(execFile)(
      'ffmpeg',
      ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x100:r=25:d=0.12`, '-c:v', 'libx264', file],
      { timeout: 15000 },
    );
}

for (const kind of ['png', 'mp4'] as const)
  test(`${kind}: a freeform publication edit delivers to the named Task owner and returns a real new version`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `f309-modification-${kind}-`));
    await writeMedia(join(root, `review-input.${kind}`), kind, 'blue');
    const mediaType = kind === 'png' ? 'image/png' : 'video/mp4';
    const source = new WorkspaceContentSourceService({
      ownerUserId: 'operator',
      resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'work' }),
    });
    const f = await createLiveReviewFixture(root, mediaType, undefined, source);
    const fileStore = new WorkspaceContentReviewStore(join(root, 'files.sqlite'));
    const integration = createContentModificationIntegration({
      dataDir: root,
      source,
      files: new WorkspaceContentReviewService({ store: fileStore, source }),
      artifacts: f,
      tasks: f.tasks,
      messages: f.messages,
      turnExecutions: f.dispatch.turns,
      changed: () => {},
      onError: () => {},
    });
    t.after(async () => {
      integration.writer.close();
      fileStore.close();
      await f.dispatch.close();
      f.store.close();
      await rm(root, { recursive: true, force: true });
    });
    const asset = await f.media.prepare({
      operationId: 'open-message',
      principal: f.human,
      source: {
        kind: 'message',
        threadId: f.thread.id,
        messageId: f.publication.id,
        messageRevision: String(f.publication.timestamp),
        expectedUrl: `/uploads/review-input.${kind}`,
        item:
          kind === 'png'
            ? { kind: 'media-gallery', blockId: `review-input.${kind}`, itemIndex: 0 }
            : { kind: 'rich-file', blockId: `review-input.${kind}` },
      },
    });
    assert.ok(f.ledgers);
    const ledger = (await f.ledgers.prepare({ principal: f.human, publication: asset, operationId: 'open-ledger' }))
      .review;
    const requested = await integration.requests.submit(
      {
        operationId: randomUUID(),
        targetCatId: 'codex-astra',
        threadId: f.thread.id,
        source: {
          kind: 'publication',
          contentRef: asset.contentRef,
          ownerRevision: 1,
          ledgerRef: ledger.reviewId,
          expectedLedgerRevision: ledger.revision,
        },
        intent: { body: '请把背景改成绿色，保留原有尺寸和内容。' },
      },
      f.human,
    );
    assert.equal(requested.stage, 'queued', JSON.stringify(requested.record.issue));
    const pendingContext = await integration.context.read(requested.record.payload.source, f.human);
    assert.equal(pendingContext.suggestedCatId, 'codex-astra');
    assert.equal(
      pendingContext.contexts[0]?.taskContext,
      undefined,
      'a pending decision cannot be overwritten by another request',
    );
    const binding = requested.record.progress.review;
    const task = requested.record.progress.task;
    assert.ok(binding && task);
    const bound = await f.reviews.read(binding.reviewId, f.cat);
    const round = bound.review.rounds.at(-1);
    assert.ok(round?.annotations[0]);
    const command = {
      reviewId: bound.review.reviewId,
      expectedRevision: bound.review.revision,
      expectedLedgerRevision: round.ledgerRevision,
      expectedTaskRevision: task.revision,
      round: 1,
      operationId: 'ask-for-edit',
      action: {
        kind: 'request_media_edit',
        mediaType,
        annotationId: 'color-change',
        body: '请把背景改成绿色，保留原有尺寸和内容。',
      },
    };
    await assert.rejects(f.reviews.act(command, f.cat), /human_required/);
    assert.equal(round.annotations[0].anchor.kind, kind === 'png' ? 'image-region' : 'video-range');
    await f.changed('operator', bound.review.reviewId);
    const delivery = f.store.returns.get(binding.receiptRef);
    assert.equal(delivery?.state, 'queued');
    assert.ok(delivery?.messageId);
    const invocationId = await f.dispatch.waitForAwakening(delivery.messageId);
    const executionView = await integration.requests.read(requested.record.requestId, f.human);
    assert.equal(
      executionView.execution?.state,
      'running',
      'a persisted actual start is shown separately from queue admission',
    );
    assert.equal(executionView.execution?.invocationId, invocationId);
    assert.equal(f.starts.length, 1);
    assert.deepEqual(f.messages.getById(delivery.messageId)?.mentions, ['codex-astra']);
    assert.equal(
      (
        await f.ownerReads.read({
          taskId: task.taskId,
          viewer: { surface: 'cat', userId: 'operator', catId: 'codex-astra', threadId: f.thread.id },
        })
      ).envelope.subjectRef,
      `task:work:${task.taskId}`,
    );
    await writeMedia(join(root, `returned.${kind}`), kind, 'green');
    const publication = f.publish(`returned.${kind}`);
    const unidentifiedResponse = {
      reviewId: bound.review.reviewId,
      expectedRevision: bound.review.revision,
      expectedLedgerRevision: round.ledgerRevision,
      expectedTaskRevision: task.revision,
      expectedOwnerRevision: 1,
      operationId: 'return-without-request-identity',
      artifactRef: `/uploads/returned.${kind}`,
      expectedArtifactRevision: String(publication.timestamp),
      responses: round.annotations.map((annotation) => ({
        annotationId: annotation.id,
        disposition: 'addressed',
        explanation: '旧执行的结果不能自动归到当前请求。',
      })),
    };
    assert.equal(bound.modificationRequest?.requestId, requested.record.requestId);
    await assert.rejects(f.reviews.respond(unidentifiedResponse, f.cat), /request_superseded/);
    for (const expectedRevision of [bound.review.revision - 1, bound.review.revision])
      await assert.rejects(
        f.reviews.respond(
          { ...unidentifiedResponse, expectedRevision, requestId: `f309-modification-${'0'.repeat(64)}` },
          f.cat,
        ),
        /request_superseded/,
      );
    assert.equal(await f.media.currentRevision(asset.contentRef, f.human), 1);
    const returned = await f.reviews.respond(
      {
        requestId: requested.record.requestId,
        reviewId: bound.review.reviewId,
        expectedRevision: bound.review.revision,
        expectedLedgerRevision: round.ledgerRevision,
        expectedTaskRevision: task.revision,
        expectedOwnerRevision: 1,
        operationId: 'return-edited-version',
        artifactRef: `/uploads/returned.${kind}`,
        expectedArtifactRevision: String(publication.timestamp),
        responses: [
          {
            annotationId: round.annotations[0].id,
            disposition: 'addressed',
            explanation: '背景已改为绿色，尺寸保持不变。',
          },
        ],
      },
      f.cat,
    );
    assert.equal(returned.view.review.rounds.length, 2);
    assert.equal(returned.view.review.rounds[1]?.asset.mediaType, mediaType);
    assert.notEqual(returned.view.review.rounds[1]?.asset.blobDigest, asset.blobDigest);
    assert.notEqual(returned.view.review.rounds[1]?.ledgerRef, returned.view.review.rounds[0]?.ledgerRef);
    assert.equal(returned.view.review.rounds[0]?.annotations[0]?.body, command.action.body);
    assert.equal((await f.media.read(asset.contentRef, 1, f.human)).blobDigest, asset.blobDigest);
    assert.notEqual(f.tasks.get(task.taskId)?.status, 'done', 'returning a version does not fabricate Task closure');
    const newRound = returned.view.review.rounds[1];
    assert.ok(newRound?.ledgerRef && newRound.ledgerRevision);
    const currentContext = await integration.context.read(
      {
        kind: 'publication',
        contentRef: asset.contentRef,
        ownerRevision: 2,
        ledgerRef: newRound.ledgerRef,
        expectedLedgerRevision: newRound.ledgerRevision,
      },
      f.human,
    );
    assert.equal(currentContext.contexts[0]?.taskContext?.taskId, task.taskId);
    assert.equal(currentContext.contexts[0]?.taskContext?.kind, 'media');
    assert.equal(currentContext.requests[0]?.record.requestId, requested.record.requestId);
    f.dispatch.turns.transitionTerminal(invocationId, {
      status: kind === 'png' ? 'failed' : 'canceled',
      terminalReason: 'fixture_terminal',
      endedAt: Date.now(),
    });
    const terminal = await integration.requests.read(requested.record.requestId, f.human);
    assert.equal(terminal.execution?.state, kind === 'png' ? 'failed' : 'cancelled');
    assert.notEqual(
      f.tasks.get(task.taskId)?.status,
      'done',
      'execution terminal truth never manufactures Task completion',
    );
  });
