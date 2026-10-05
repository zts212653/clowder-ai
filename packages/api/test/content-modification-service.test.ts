import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { ModificationFileLineage } from '../src/domains/collaborative-content/modification/file-lineage.js';
import { ModificationMediaBinding } from '../src/domains/collaborative-content/modification/media-binding.js';
import { ContentModificationService } from '../src/domains/collaborative-content/modification/service.js';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

test('source -> Task -> ledger/outbox recovers each owner gap, exposes the undelivered Task and queues one named request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-modification-saga-'));
  await writeFile(
    join(root, 'review-input.png'),
    await sharp({ create: { width: 160, height: 100, channels: 3, background: '#abcdef' } })
      .png()
      .toBuffer(),
  );
  const f = await createLiveReviewFixture(root);
  const fileStore = new WorkspaceContentReviewStore(join(root, 'files.sqlite'));
  const raw = new Database(join(root, 'collaborative-content', 'artifact-reviews.sqlite'));
  t.after(async () => {
    await f.dispatch.close();
    raw.close();
    fileStore.close();
    f.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'fixture' }),
  });
  const files = new WorkspaceContentReviewService({ store: fileStore, source });
  const ledgers = new WorkspaceContentReviewService({ store: f.store.ledgers, source, publications: f.media });
  const asset = await f.media.prepare({
    operationId: 'open-message',
    principal: f.human,
    source: {
      kind: 'message',
      threadId: f.thread.id,
      messageId: f.publication.id,
      messageRevision: String(f.publication.timestamp),
      expectedUrl: '/uploads/review-input.png',
      item: { kind: 'media-gallery', blockId: 'review-input.png', itemIndex: 0 },
    },
  });
  const ledger = (await ledgers.prepare({ principal: f.human, publication: asset, operationId: 'open-ledger' })).review;
  const fileLineage = new ModificationFileLineage({ store: f.store, media: f.media, messages: f.messages });
  const content = new ModificationMediaBinding({
    media: f.media,
    reviews: f.reviews,
    store: f.store,
    ledgers,
    files,
    fileLineage,
  });
  const prepare = content.prepare.bind(content);
  let slowPreparation = true;
  content.prepare = async (...args) => {
    if (slowPreparation) {
      slowPreparation = false;
      await new Promise((resolve) => setTimeout(resolve, 1400));
    }
    return prepare(...args);
  };
  const failures: unknown[] = [];
  let preflights = 0;
  const service = new ContentModificationService({
    store: f.store,
    messages: f.messages,
    tasks: f.tasks,
    lifecycle: f.lifecycle,
    content,
    authorizeTarget: async (payload, ownerUserId) => {
      assert.equal(ownerUserId, 'operator');
      assert.equal(payload.targetCatId, 'codex-astra');
      assert.equal(payload.threadId, f.thread.id);
      preflights += 1;
      return { targetName: '小星星', threadTitle: '一起完成封面' };
    },
    dispatch: () => f.dispatcher.drain(),
    onError: (error) => failures.push(error),
    leaseDurationMs: 1000,
  });
  const payload = {
    operationId: randomUUID(),
    threadId: f.thread.id,
    targetCatId: 'codex-astra',
    source: {
      kind: 'publication',
      contentRef: asset.contentRef,
      ownerRevision: 1,
      ledgerRef: ledger.reviewId,
      expectedLedgerRevision: 1,
    },
    intent: { body: '背景换成绿色，保留猫和手写文字。' },
  };
  const priorTasks = f.tasks.listByThread(f.thread.id).length;
  const admit = f.lifecycle.admitOrResume.bind(f.lifecycle);
  let lost = true;
  f.lifecycle.admitOrResume = async (...args) => {
    const result = await admit(...args);
    if (lost) {
      lost = false;
      throw new Error('Task committed, response lost');
    }
    return result;
  };
  const unknown = await service.submit(payload, f.human);
  assert.equal(unknown.stage, 'admitting_task');
  assert.equal(unknown.record.issue?.code, 'recovery_pending');
  assert.equal(
    f.tasks.listByThread(f.thread.id).length,
    priorTasks + 1,
    'Task was actually committed before the response was lost',
  );
  assert.equal(f.store.returns.pending().length, 0);
  raw.exec(
    "CREATE TRIGGER fail_outbox BEFORE INSERT ON artifact_review_returns BEGIN SELECT RAISE(ABORT, 'outbox failure'); END",
  );
  const undelivered = await service.submit(payload, f.human);
  assert.equal(undelivered.stage, 'binding_request', 'a real Task without an outbox is not called queued or received');
  assert.ok(undelivered.record.progress.task?.taskId);
  assert.equal(undelivered.record.progress.review, undefined);
  assert.equal(
    f.store.ledgers.get(ledger.reviewId)?.annotations.length,
    0,
    'the ledger request rolled back with the outbox',
  );
  assert.equal(f.tasks.listByThread(f.thread.id).length, priorTasks + 1);
  assert.equal(f.store.returns.pending().length, 0);
  raw.exec('DROP TRIGGER fail_outbox');
  const queued = await service.submit(payload, f.human);
  assert.equal(queued.stage, 'queued');
  assert.ok(queued.delivery?.messageId);
  await f.dispatch.waitForAwakening(queued.delivery.messageId);
  assert.equal(f.starts.length, 1);
  assert.equal(f.store.ledgers.get(ledger.reviewId)?.annotations[0]?.body, payload.intent.body);
  assert.equal(f.tasks.listByThread(f.thread.id).length, priorTasks + 1);
  const humanSources = f.messages
    .getByThread(f.thread.id)
    .filter((message) => message.extra?.contentModificationRequestV1?.requestId === queued.record.requestId);
  assert.equal(humanSources.length, 1);
  assert.equal(humanSources[0]?.source, undefined);
  assert.equal(humanSources[0]?.catId, null);
  const owned = f.tasks.get(queued.record.progress.task?.taskId ?? '');
  assert.deepEqual(owned?.entrustedWork?.admission.sourceRefs, [`message:${humanSources[0]?.id}`]);
  assert.deepEqual(owned?.entrustedWork?.time, {});
  const replay = await service.submit(payload, f.human);
  assert.equal(replay.delivery?.messageId, queued.delivery.messageId);
  assert.equal(f.starts.length, 1);
  assert.equal(replay.record.issue, undefined);
  assert.equal(failures.length, 2);
  assert.ok(preflights >= 5, 'the explicit target is checked again at actual send');
  await assert.rejects(service.submit({ ...payload, targetCatId: 'opus5' }, f.human), /operation_reused/);
});
