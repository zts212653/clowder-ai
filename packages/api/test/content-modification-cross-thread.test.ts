import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import sharp from 'sharp';
import { createContentModificationIntegration } from '../src/domains/collaborative-content/modification/composition.js';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

test('a confirmed execution conversation grants the named Task owner the exact source publication and returns to its original ledger', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-execution-thread-'));
  const image = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#abcdef' } })
    .png()
    .toBuffer();
  await writeFile(join(root, 'review-input.png'), image);
  await writeFile(join(root, 'returned.png'), image);
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'work' }),
  });
  const f = await createLiveReviewFixture(root, 'image/png', undefined, source);
  const fileStore = new WorkspaceContentReviewStore(join(root, 'files.sqlite'));
  const files = new WorkspaceContentReviewService({ store: fileStore, source });
  const errors: unknown[] = [];
  const integration = createContentModificationIntegration({
    dataDir: root,
    source,
    files,
    artifacts: f,
    tasks: f.tasks,
    messages: f.messages,
    changed: () => {},
    onError: (e) => errors.push(e),
  });
  t.after(async () => {
    integration.writer.close();
    await f.dispatch.close();
    fileStore.close();
    f.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const asset = await f.media.prepare({
    principal: f.human,
    operationId: 'open-source',
    source: {
      kind: 'message',
      threadId: f.thread.id,
      messageId: f.publication.id,
      messageRevision: String(f.publication.timestamp),
      expectedUrl: '/uploads/review-input.png',
      item: { kind: 'media-gallery', blockId: 'review-input.png', itemIndex: 0 },
    },
  });
  assert.ok(f.ledgers);
  const ledger = (await f.ledgers.prepare({ principal: f.human, publication: asset, operationId: 'open-ledger' }))
    .review;
  const execution = f.threads.create('operator', '明确选择的执行对话', root);
  const cat = { ...f.cat, threadId: execution.id };
  await assert.rejects(f.media.read(asset.contentRef, 1, cat), /access_denied/);
  const request = await integration.requests.submit(
    {
      operationId: randomUUID(),
      targetCatId: 'codex-astra',
      threadId: execution.id,
      source: {
        kind: 'publication',
        contentRef: asset.contentRef,
        ownerRevision: 1,
        ledgerRef: ledger.reviewId,
        expectedLedgerRevision: ledger.revision,
      },
      intent: { body: '保持画面风格，返回校对过的新版本。' },
    },
    f.human,
  );
  assert.equal(request.stage, 'queued', JSON.stringify(request.record.issue));
  assert.deepEqual(errors, []);
  assert.ok(request.record.progress.review);
  const view = await f.reviews.read(request.record.progress.review.reviewId, cat),
    round = view.review.rounds.at(-1);
  assert.ok(round);
  assert.equal(round.ledgerRef, ledger.reviewId);
  await assert.rejects(
    f.media.read(asset.contentRef, 1, cat),
    /access_denied/,
    'an arbitrary content read does not inherit another Task grant',
  );
  const published = f.messages.append({
    userId: 'operator',
    catId: f.cat.actor.actorId,
    threadId: execution.id,
    mentions: [],
    timestamp: Date.now(),
    content: '返回新版',
    extra: {
      rich: {
        v: 1,
        blocks: [
          { kind: 'media_gallery', id: 'returned', v: 1, items: [{ url: '/uploads/returned.png', alt: '新版' }] },
        ],
      },
    },
  });
  const result = await f.reviews.respond(
    {
      requestId: request.record.requestId,
      reviewId: view.review.reviewId,
      expectedRevision: view.review.revision,
      expectedTaskRevision: view.authority.taskRevision,
      expectedLedgerRevision: round.ledgerRevision,
      expectedOwnerRevision: 1,
      operationId: 'respond-across-thread',
      artifactRef: '/uploads/returned.png',
      expectedArtifactRevision: String(published.timestamp),
      responses: round.annotations.map((annotation) => ({
        annotationId: annotation.id,
        disposition: 'addressed',
        explanation: '已核对并返回新版。',
      })),
    },
    cat,
  );
  assert.equal(result.view.review.contentRef, asset.contentRef);
  assert.equal(result.view.review.rounds.at(-1)?.asset.ownerRevision, 2);
  assert.equal((await f.media.read(asset.contentRef, 2, f.human)).ownerRevision, 2);
  const candidates = await integration.results.candidates(request.record, f.human);
  assert.equal(candidates.length, 1);
  const grantedTask = request.record.progress.task;
  assert.ok(grantedTask);
  await f.lifecycle.update({ taskId: grantedTask.taskId, expectedRevision: grantedTask.revision, artifactRefs: [] });
  assert.equal(
    (await f.reviews.read(view.review.reviewId, cat)).review.contentRef,
    asset.contentRef,
    'mutable artifact membership neither creates nor removes the immutable human grant',
  );
  const requestSource = f.messages.getById(request.record.progress.sourceMessageId ?? '');
  assert.ok(requestSource);
  requestSource._tombstone = true;
  await assert.rejects(
    f.reviews.read(view.review.reviewId, cat),
    /access_denied/,
    'revoking the human request revokes its grant',
  );
  delete requestSource._tombstone;
  await assert.rejects(
    f.media.read(asset.contentRef, 1, { ...cat, contentTaskId: f.taskId }),
    /access_denied/,
    'a foreign Task id is not a grant',
  );
  const original = f.messages.getById(f.publication.id);
  assert.ok(original);
  original.visibility = 'whisper';
  original.whisperTo = [createCatId('opus')];
  await assert.rejects(
    f.reviews.read(view.review.reviewId, cat),
    /access_denied/,
    'the exact Task grant cannot borrow human visibility for a revoked source',
  );
  assert.equal((await f.reviews.read(view.review.reviewId, f.human)).review.contentRef, asset.contentRef);
});
