import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { ModificationFileLineage } from '../src/domains/collaborative-content/modification/file-lineage.js';
import { ModificationMediaBinding } from '../src/domains/collaborative-content/modification/media-binding.js';
import { ContentModificationService } from '../src/domains/collaborative-content/modification/service.js';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

test('lost snapshot response resumes the exact F138 object after file drift and retains the original comments as read-only lineage', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-workspace-modification-'));
  const bytes = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#abc123' } })
    .png()
    .toBuffer();
  await writeFile(join(root, 'ordinary.png'), bytes);
  let sourceAllowed = true;
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => {
      if (!sourceAllowed) throw new Error('workspace revoked');
      return { root, canonicalWorktreeId: 'fixture' };
    },
  });
  const f = await createLiveReviewFixture(root, 'image/png', undefined, source);
  const fileStore = new WorkspaceContentReviewStore(join(root, 'files.sqlite'));
  t.after(async () => {
    await f.dispatch.close();
    fileStore.close();
    f.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const files = new WorkspaceContentReviewService({ store: fileStore, source });
  assert.ok(f.ledgers);
  const ledgers = f.ledgers;
  const first = (
    await files.prepare({
      principal: f.human,
      locator: { worktreeId: 'fixture', path: 'ordinary.png' },
      operationId: 'open-file',
    })
  ).review;
  const marked = await files.annotate({
    principal: f.human,
    reviewId: first.reviewId,
    expectedRevision: 1,
    operationId: 'comment',
    body: '保留猫',
    target: { kind: 'media_anchor', anchor: { kind: 'image-point', x: 10, y: 10 } },
  });
  const fileLineage = new ModificationFileLineage({ store: f.store, media: f.media, messages: f.messages });
  const content = new ModificationMediaBinding({
    media: f.media,
    reviews: f.reviews,
    store: f.store,
    ledgers,
    files,
    fileLineage,
  });
  const service = new ContentModificationService({
    store: f.store,
    messages: f.messages,
    tasks: f.tasks,
    lifecycle: f.lifecycle,
    content,
    authorizeTarget: async () => ({ targetName: '小星星', threadTitle: '一起完成封面' }),
    dispatch: () => f.dispatcher.drain(),
    onError: () => {},
  });
  const payload = {
    operationId: randomUUID(),
    threadId: f.thread.id,
    targetCatId: 'codex-astra',
    source: {
      kind: 'workspace',
      locator: { worktreeId: 'fixture', path: 'ordinary.png' },
      expectedSourceRevision: first.source.revision,
      reviewId: first.reviewId,
      expectedReviewRevision: 2,
    },
    intent: {
      body: '保留猫，把右下角多余的字移除。',
      imageEdit: { kind: 'erase-region', region: { x: 100, y: 50, width: 20, height: 20 } },
    },
  };
  const prepare = f.media.prepare.bind(f.media);
  let lost = true;
  f.media.prepare = async (input) => {
    const result = await prepare(input);
    if ('source' in input && input.source.kind === 'workspace-snapshot' && lost) {
      lost = false;
      throw new Error('snapshot response lost');
    }
    return result;
  };
  const unknown = await service.submit(payload, f.human);
  assert.equal(unknown.stage, 'preparing_content');
  assert.equal(unknown.record.progress.task, undefined);
  const taskCount = f.tasks.listByThread(f.thread.id).length;
  sourceAllowed = false;
  await service.recover();
  const denied = f.store.requests.get(unknown.record.requestId, 'operator');
  assert.ok(denied?.issue, 'recovery reports revoked authority instead of borrowing the old confirmation');
  assert.equal(denied.progress.task, undefined);
  assert.equal(denied.progress.review, undefined);
  assert.equal(f.tasks.listByThread(f.thread.id).length, taskCount);
  assert.equal(f.store.returns.pending().length, 0);
  sourceAllowed = true;
  assert.deepEqual(await readFile(join(root, 'ordinary.png')), bytes);
  const retained = await files.retainedRevision({ principal: f.human, reviewId: first.reviewId, revision: 2 });
  assert.equal(retained.annotations[0]?.body, '保留猫');
  const changed = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#abcdef' } })
    .png()
    .toBuffer();
  await writeFile(join(root, 'ordinary.png'), changed);
  await files.refresh({
    principal: f.human,
    reviewId: first.reviewId,
    expectedRevision: 2,
    operationId: 'refresh-file',
  });
  const annotationId = marked.review.annotations[0]?.id;
  assert.ok(annotationId);
  await files.act({
    principal: f.human,
    reviewId: first.reviewId,
    expectedRevision: 3,
    operationId: 'later-reply',
    action: { kind: 'reply', annotationId, replyId: 'later', body: '之后追加的意见' },
  });
  const resumed = await service.submit(payload, f.human);
  assert.equal(resumed.stage, 'queued', JSON.stringify(resumed.record.issue));
  const prepared = resumed.record.progress.prepared;
  assert.ok(prepared?.kind === 'media');
  assert.deepEqual(
    await f.media.bytes(prepared.contentRef, prepared.ownerRevision, f.human),
    bytes,
    'the accepted snapshot is recovered, not replaced by today’s bytes',
  );
  assert.deepEqual(await readFile(join(root, 'ordinary.png')), changed, 'dispatch never writes the original file');
  assert.deepEqual(
    (await files.retainedRevision({ principal: f.human, reviewId: first.reviewId, revision: 2 })).annotations[0]
      ?.replies,
    [],
  );
  assert.equal(
    (await files.read({ principal: f.human, reviewId: first.reviewId })).review.annotations[0]?.replies?.length,
    1,
  );
  assert.equal(
    f.messages.getByThread(f.thread.id).filter((message) => message.catId !== null).length,
    1,
    'snapshot admission does not manufacture a published media chat message',
  );
  const task = f.tasks.get(resumed.record.progress.task?.taskId ?? '');
  assert.equal(task?.entrustedWork?.closure.expectedSignal, `${resumed.record.requestId}#file-writeback-applied`);
});
