import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { ContentModificationRecord, ContentModificationRequest } from '@cat-cafe/shared';
import sharp from 'sharp';
import { inspectArtifactReview } from '../src/domains/collaborative-content/artifact-review/inspection.js';
import { createContentModificationIntegration } from '../src/domains/collaborative-content/modification/composition.js';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { signEditToken } from '../src/domains/workspace/workspace-edit.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

for (const kind of ['png', 'mp4'] as const)
  test(`${kind}: file modification continues in its original Task and advances writeback base only from actual applied receipts`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f309-file-continuation-'));
    const image = async (color: string) => {
      if (kind === 'png')
        return sharp({ create: { width: 160, height: 100, channels: 3, background: color } })
          .png()
          .toBuffer();
      const path = join(root, `fixture-${color}.mp4`);
      await promisify(execFile)(
        'ffmpeg',
        ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x100:r=25:d=0.12`, '-c:v', 'libx264', path],
        { timeout: 15000 },
      );
      return readFile(path);
    };
    const original = await image('blue');
    await writeFile(join(root, `original.${kind}`), original);
    const source = new WorkspaceContentSourceService({
      ownerUserId: 'operator',
      resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'work' }),
    });
    const f = await createLiveReviewFixture(root, kind === 'png' ? 'image/png' : 'video/mp4', undefined, source);
    const fileStore = new WorkspaceContentReviewStore(join(root, 'files.sqlite'));
    const files = new WorkspaceContentReviewService({ store: fileStore, source });
    const integration = createContentModificationIntegration({
      dataDir: root,
      source,
      files,
      artifacts: f,
      tasks: f.tasks,
      messages: f.messages,
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
    const opened = await files.prepare({
      principal: f.human,
      locator: { worktreeId: 'work', path: `original.${kind}` },
      operationId: 'open-file',
    });
    assert.equal(opened.review.source.kind, 'media');
    if (opened.review.source.kind !== 'media') throw new Error('expected media source');
    const media = opened.review.source.media;
    const originalNote = '原文件中的选区意见' + '\\'.repeat(6900);
    const originalDiscussion = await files.annotate({
      principal: f.human,
      reviewId: opened.review.reviewId,
      expectedRevision: opened.review.revision,
      operationId: 'file-original-comment',
      body: originalNote,
      target: {
        kind: 'media_anchor',
        anchor:
          media.kind === 'image'
            ? { kind: 'image-point', x: 10, y: 20 }
            : {
                kind: 'video-range',
                streamId: media.streamId,
                startTick: media.startTick,
                endTick: media.startTick + 1,
              },
      },
    });
    const firstSource: ContentModificationRequest['source'] = {
      kind: 'workspace',
      locator: { worktreeId: 'work', path: `original.${kind}` },
      expectedSourceRevision: opened.review.source.revision,
      reviewId: opened.review.reviewId,
      expectedReviewRevision: originalDiscussion.review.revision,
    };
    const submit = async (
      requestSource: ContentModificationRequest['source'],
      taskContext?: ContentModificationRequest['taskContext'],
    ) => {
      const result = await integration.requests.submit(
        {
          operationId: randomUUID(),
          targetCatId: 'codex-astra',
          threadId: f.thread.id,
          source: requestSource,
          intent: { body: '请修改背景并保留尺寸。' },
          ...(taskContext ? { taskContext } : {}),
        },
        f.human,
      );
      assert.equal(result.stage, 'queued', JSON.stringify(result.record.issue));
      return result.record;
    };
    const returnVersion = async (record: ContentModificationRecord, color: string) => {
      assert.ok(record.progress.review && record.progress.task);
      const view = await f.reviews.readCurrent(record.progress.review.reviewId, f.human);
      const round = view.review.rounds.at(-1);
      assert.ok(round);
      const bytes = await image(color),
        name = `returned-${round.number}.${kind}`;
      await writeFile(join(root, name), bytes);
      const publication = f.publish(name);
      const returned = await f.reviews.respond(
        {
          requestId: record.requestId,
          reviewId: view.review.reviewId,
          expectedRevision: view.review.revision,
          expectedLedgerRevision: round.ledgerRevision,
          expectedTaskRevision: record.progress.task.revision,
          expectedOwnerRevision: round.asset.ownerRevision,
          operationId: randomUUID(),
          artifactRef: '/uploads/' + name,
          expectedArtifactRevision: String(publication.timestamp),
          responses: round.annotations.map((annotation) => ({
            annotationId: annotation.id,
            disposition: 'addressed',
            explanation: '已按要求修改。',
          })),
        },
        f.cat,
      );
      const next = returned.view.review.rounds.at(-1);
      assert.ok(next?.ledgerRef && next.ledgerRevision);
      return {
        bytes,
        asset: next.asset,
        source: {
          kind: 'publication' as const,
          contentRef: next.asset.contentRef,
          ownerRevision: next.asset.ownerRevision,
          ledgerRef: next.ledgerRef,
          expectedLedgerRevision: next.ledgerRevision,
        },
      };
    };
    const command = (record: ContentModificationRecord, candidateRef: string, baseRevision: string) => ({
      requestId: record.requestId,
      candidateRef,
      acceptOperationId: randomUUID(),
      baseRevision,
      locator: firstSource.locator,
      editSessionToken: signEditToken('work'),
    });
    const first = await submit(firstSource),
      secondVersion = await returnVersion(first, 'green');
    await files.act({
      principal: f.human,
      reviewId: opened.review.reviewId,
      expectedRevision: originalDiscussion.review.revision,
      operationId: 'later-original-reply',
      action: {
        kind: 'reply',
        annotationId: originalDiscussion.review.annotations[0]!.id,
        replyId: 'later-reply',
        body: '这条讨论在提交之后才加入',
      },
    });
    const retained = await integration.sourceDiscussions.forRequest(first.requestId, f.cat);
    assert.equal(retained[0]?.review.annotations[0]?.body, originalNote);
    assert.equal(
      retained[0]?.review.annotations[0]?.replies?.length,
      0,
      'frozen source discussions never move to later original edits',
    );
    assert.deepEqual(await readFile(join(root, `original.${kind}`)), original);
    const firstAccept = command(first, secondVersion.asset.ownerReceiptRef, firstSource.expectedSourceRevision);
    const firstWritten = (await integration.results.accept(firstAccept, f.human)).receipt;
    assert.equal(firstWritten.state, 'applied');
    const taskCount = f.tasks.listByThread(f.thread.id).length;
    const contexts = await integration.context.read(secondVersion.source, f.human);
    const context = contexts.contexts[0]?.taskContext;
    assert.ok(context);
    const second = await submit(secondVersion.source, context),
      thirdVersion = await returnVersion(second, 'red');
    assert.deepEqual(
      await integration.sourceDiscussions.forRequest(second.requestId, f.cat),
      retained,
      'continued publication requests keep the same retained file lineage after writeback',
    );
    const sourceMessage = f.messages.getById(second.progress.sourceMessageId ?? '');
    assert.equal(sourceMessage?.extra?.contentModificationRequestV1?.completionRule, 'file-writeback-applied');
    assert.equal(second.progress.task?.taskId, first.progress.task?.taskId);
    assert.equal(f.tasks.listByThread(f.thread.id).length, taskCount);
    assert.deepEqual(await readFile(join(root, `original.${kind}`)), secondVersion.bytes);
    const secondAccept = command(second, thirdVersion.asset.ownerReceiptRef, secondVersion.asset.blobDigest);
    const secondWritten = (await integration.results.accept(secondAccept, f.human)).receipt;
    assert.equal(secondWritten.state, 'applied');
    assert.ok(
      firstWritten.appliedSequence &&
        secondWritten.appliedSequence &&
        secondWritten.appliedSequence > firstWritten.appliedSequence,
    );
    assert.deepEqual(await readFile(join(root, `original.${kind}`)), thirdVersion.bytes);
    assert.equal((await integration.results.accept(firstAccept, f.human)).receipt.state, 'applied');
    assert.deepEqual(
      await readFile(join(root, `original.${kind}`)),
      thirdVersion.bytes,
      'old applied retry must not restore old bytes',
    );
    const thirdContext = (await integration.context.read(thirdVersion.source, f.human)).contexts[0]?.taskContext;
    assert.ok(thirdContext);
    const third = await submit(thirdVersion.source, thirdContext),
      fourthVersion = await returnVersion(third, 'yellow');
    const external = await image('gray');
    await writeFile(join(root, `original.${kind}`), external);
    const conflict = await integration.results.accept(
      command(third, fourthVersion.asset.ownerReceiptRef, thirdVersion.asset.blobDigest),
      f.human,
    );
    assert.equal(conflict.receipt.state, 'conflict');
    assert.deepEqual(await readFile(join(root, `original.${kind}`)), external);
    const reviewId = third.progress.review!.reviewId;
    const beforeRecall = await inspectArtifactReview(f.reviews, { reviewId }, f.cat, integration.sourceDiscussions);
    assert.ok(beforeRecall.sourceSnapshot);
    assert.notEqual(beforeRecall.nextCursor, null, 'the retained long comment requires a real continuation page');
    const continuation = { reviewId, expectedRevision: beforeRecall.revision, cursor: beforeRecall.nextCursor };
    await assert.rejects(
      inspectArtifactReview(f.reviews, continuation, f.cat, integration.sourceDiscussions),
      /revision_conflict/,
      'a source-bearing overview cannot continue without its source snapshot',
    );
    const remaining = await inspectArtifactReview(
      f.reviews,
      { ...continuation, expectedSourceSnapshot: beforeRecall.sourceSnapshot },
      f.cat,
      integration.sourceDiscussions,
    );
    assert.equal(remaining.sourceSnapshot, beforeRecall.sourceSnapshot);
    const firstSourceMessage = f.messages.getById(first.progress.sourceMessageId ?? '');
    assert.ok(firstSourceMessage);
    firstSourceMessage.recall = { recalledAt: Date.now(), recalledBy: 'operator' };
    await assert.rejects(integration.sourceDiscussions.forRequest(third.requestId, f.cat), /access_denied/);
    const independentlyReadable = await f.reviews.read(third.progress.review!.reviewId, f.cat);
    assert.equal(independentlyReadable.review.reviewId, third.progress.review!.reviewId);
    assert.equal(
      independentlyReadable.review.revision,
      beforeRecall.revision,
      'source recall does not mutate the review ledger',
    );
    await assert.rejects(
      inspectArtifactReview(
        f.reviews,
        { ...continuation, expectedSourceSnapshot: beforeRecall.sourceSnapshot },
        f.cat,
        integration.sourceDiscussions,
      ),
      /revision_conflict/,
      'an unchanged review revision cannot authorize pages from a changed source projection',
    );
    const overview = await inspectArtifactReview(
      f.reviews,
      { reviewId: independentlyReadable.review.reviewId },
      f.cat,
      integration.sourceDiscussions,
    );
    assert.notEqual(overview.sourceSnapshot, beforeRecall.sourceSnapshot);
    assert.ok(
      overview.records.some((row) => row.path === '/sourceDiscussions/0/state' && row.value === 'source_unavailable'),
    );
    assert.deepEqual(
      overview.records.filter((row) => row.path.startsWith('/sourceDiscussions/')),
      [{ path: '/sourceDiscussions/0/state', value: 'source_unavailable' }],
      'unavailable source exposes no body or locator',
    );
    await assert.rejects(
      integration.results.accept(
        command(third, fourthVersion.asset.ownerReceiptRef, thirdVersion.asset.blobDigest),
        f.human,
      ),
      /access_denied/,
    );
    assert.deepEqual(await readFile(join(root, `original.${kind}`)), external);
  });
