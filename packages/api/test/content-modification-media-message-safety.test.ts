import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { handleTakeOverContentModification } from '../../mcp-server/src/tools/content-modification-tools.js';
import { ArtifactReviewService } from '../src/domains/collaborative-content/artifact-review/service.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { createContentModificationIntegration } from '../src/domains/collaborative-content/modification/composition.js';
import { mediaMessageFixture } from './helpers/media-message-fixture.js';

test('authenticated HTTP media takeover races two cats once and exposes the stable selection join', async (t) => {
  const f = await mediaMessageFixture(t);
  const opened = await f.files.prepare({
    principal: f.human,
    locator: { worktreeId: 'media-worktree', path: 'review-input.png' },
    operationId: 'workspace',
  });
  const message = f.send({
    ...f.attachment,
    taskContext: undefined,
    source: {
      kind: 'workspace',
      locator: opened.review.source.locator,
      expectedSourceRevision: opened.review.source.revision,
      reviewId: opened.review.reviewId,
      expectedReviewRevision: opened.review.revision,
    },
  });
  const secondId = 'f309-media-second-cat';
  if (!catRegistry.has(secondId))
    catRegistry.register(secondId, {
      ...catRegistry.getOrThrow('codex-astra').config,
      id: createCatId(secondId),
      displayName: '媒体第二只测试猫',
    });
  message.mentions.push(createCatId(secondId));
  message.whisperTo?.push(createCatId(secondId));
  const second = await f.registry.create('operator', secondId, f.thread.id);
  const count = f.tasks.listByThread(f.thread.id).length;
  const payload = { sourceMessageId: message.id, operationId: randomUUID() };
  const send = (auth = f.actor) =>
    f.app.inject({
      method: 'POST',
      url: '/api/callbacks/content-modification/take-over',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload,
    });
  const unauthorized = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/content-modification/take-over',
    payload,
  });
  assert.equal(unauthorized.statusCode, 401);
  const [left, right] = await Promise.all([send(), send(second)]);
  assert.equal(left.statusCode, 200, left.body);
  assert.equal(right.statusCode, 200, right.body);
  assert.equal(left.json().record.requestId, right.json().record.requestId);
  const settled = await send();
  assert.equal(settled.json().stage, 'queued', settled.body);
  assert.equal(f.tasks.listByThread(f.thread.id).length, count + 1);
  assert.deepEqual(
    settled.json().selectionAnnotations.map((item: { selectionId: string }) => item.selectionId),
    ['1', '2'],
  );
  assert.equal(
    new Set(settled.json().selectionAnnotations.map((item: { annotationId: string }) => item.annotationId)).size,
    2,
  );
  assert.equal((await send()).json().delivery.messageId, settled.json().delivery.messageId);
  const current = await f.app.inject({
    method: 'GET',
    url: `/api/content-modifications/${left.json().record.requestId}`,
    headers: { 'x-cat-cafe-user': 'operator' },
  });
  assert.equal(current.statusCode, 200, current.body);
  assert.deepEqual(current.json().selectionAnnotations, settled.json().selectionAnnotations);
});

test('the real MCP takeover handler uses invocation auth against the live API and preserves the two-range request', async (t) => {
  const f = await mediaMessageFixture(t);
  const message = f.send();
  const url = await f.app.listen({ port: 0, host: '127.0.0.1' });
  const keys = ['CAT_CAFE_API_URL', 'CAT_CAFE_INVOCATION_ID', 'CAT_CAFE_CALLBACK_TOKEN'] as const;
  const prior = keys.map((key) => process.env[key]);
  process.env.CAT_CAFE_API_URL = url;
  process.env.CAT_CAFE_INVOCATION_ID = f.actor.invocationId;
  process.env.CAT_CAFE_CALLBACK_TOKEN = f.actor.callbackToken;
  try {
    const result = await handleTakeOverContentModification({ sourceMessageId: message.id, operationId: randomUUID() });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const content = result.content[0];
    assert.ok(content?.type === 'text');
    const request = JSON.parse(content.text);
    assert.equal(request.stage, 'queued');
    assert.equal(request.record.progress.task.taskId, f.taskId);
    assert.equal(request.record.progress.sourceMessageId, message.id);
    assert.deepEqual(
      request.selectionAnnotations.map((item: { selectionId: string }) => item.selectionId),
      ['1', '2'],
    );
  } finally {
    keys.forEach((key, i) => {
      if (prior[i] === undefined) delete process.env[key];
      else process.env[key] = prior[i];
    });
  }
});

test('media source recall during owner resolution wins before any request or annotations persist', async (t) => {
  const f = await mediaMessageFixture(t);
  const message = f.send();
  const read = f.reviews.readCurrent.bind(f.reviews);
  f.reviews.readCurrent = async (...args) => {
    const view = await read(...args);
    message.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };
    return view;
  };
  await assert.rejects(f.takeOver(message.id), /not_found/);
  assert.equal(f.store.requests.recentForProjection(100).length, 0);
  assert.equal(f.store.get(f.attachment.taskContext?.reviewId ?? '')?.rounds[0]?.annotations.length, 0);
});

test('a Task-owned publication without a matching original review ledger never guesses a new Task', async (t) => {
  const f = await mediaMessageFixture(t);
  const view = await f.reviews.readCurrent(f.attachment.taskContext?.reviewId ?? '', f.human);
  const asset = view.review.rounds[0]?.asset;
  assert.ok(asset && f.ledgers);
  const message = f.send({
    ...f.attachment,
    taskContext: undefined,
    source: {
      kind: 'publication',
      contentRef: asset.contentRef,
      ownerRevision: asset.ownerRevision,
      ledgerRef: 'unrelated-publication-ledger',
      expectedLedgerRevision: 1,
    },
  });
  const count = f.tasks.listByThread(f.thread.id).length;
  await assert.rejects(f.takeOver(message.id), /task_changed/);
  assert.equal(f.tasks.listByThread(f.thread.id).length, count);
  assert.equal(f.store.requests.recentForProjection(100).length, 0);
});

test('failed multi-range request is atomic and a fresh journal/service recovers exactly the original Task', async (t) => {
  const f = await mediaMessageFixture(t);
  const message = f.send();
  const path = join(f.root, 'collaborative-content', 'artifact-reviews.sqlite');
  const db = new Database(path);
  db.exec(
    "CREATE TRIGGER fail_media_message_return BEFORE INSERT ON artifact_review_returns BEGIN SELECT RAISE(ABORT, 'media outbox crash'); END",
  );
  const failed = await f.takeOver(message.id);
  assert.equal(failed.stage, 'binding_request');
  assert.equal(failed.record.progress.review, undefined);
  assert.equal(f.store.get(f.attachment.taskContext?.reviewId ?? '')?.rounds[0]?.annotations.length, 0);
  assert.equal(f.store.history(f.attachment.taskContext?.reviewId ?? '').length, 1);
  assert.equal(f.store.returns.pending().length, 0);
  db.exec('DROP TRIGGER fail_media_message_return');
  db.close();
  const store = new ArtifactReviewStore(path);
  const reviews = new ArtifactReviewService({ store, media: f.media });
  const restarted = createContentModificationIntegration({
    dataDir: f.root,
    source: f.source,
    files: f.files,
    artifacts: { ...f, store, reviews },
    tasks: f.tasks,
    messages: f.messages,
    delivery: f.dispatch.delivery,
    changed: () => {},
    onError: (error) => f.errors.push(error),
  });
  t.after(async () => {
    restarted.writer.close();
    store.close();
  });
  // SQLite constraints are nonretryable; an explicit replay of the same Human source repairs this injected fault.
  const recovered = await restarted.requests.takeOver(
    { sourceMessageId: message.id, operationId: randomUUID() },
    f.cat,
  );
  await restarted.requests.recover();
  assert.equal(
    recovered.stage,
    'queued',
    JSON.stringify({ issue: recovered.record.issue, errors: f.errors.map((error) => String(error)) }),
  );
  assert.equal(recovered.record.progress.task?.taskId, f.taskId);
  assert.equal(store.get(recovered.record.progress.review?.reviewId ?? '')?.rounds[0]?.annotations.length, 2);
  assert.equal(store.history(f.attachment.taskContext?.reviewId ?? '').length, 2);
  assert.equal(
    (await restarted.requests.takeOver({ sourceMessageId: message.id, operationId: randomUUID() }, f.cat)).delivery
      ?.messageId,
    recovered.delivery?.messageId,
  );
});

test('cancelling media request preserves the original Task and fences a late real candidate', async (t) => {
  const f = await mediaMessageFixture(t);
  const request = await f.takeOver(f.send().id);
  const command = await f.candidateCommand(request.record.requestId);
  const cancelled = await f.integration.requests.cancel(request.record.requestId, f.human);
  assert.equal(cancelled.stage, 'cancelled');
  assert.equal(cancelled.record.control?.taskResolution, 'preserved');
  assert.equal(f.tasks.get(f.taskId)?.entrustedWork?.closure.state, 'open');
  await assert.rejects(f.reviews.respond(command, f.cat), /request_cancelled/);
  await f.integration.receipts.recover();
  assert.equal(
    f.messages.getByThread(f.thread.id).filter((item) => item.extra?.contentModificationReceiptV1).length,
    0,
  );
});

test('real MP4 multi-range and old single anchor stay compatible without changing source bytes', async (t) => {
  const f = await mediaMessageFixture(t, 'video/mp4');
  const before = await readFile(join(f.root, 'review-input.mp4'));
  const request = await f.takeOver(f.send().id);
  assert.equal(request.stage, 'queued');
  const round = f.store.get(request.record.progress.review?.reviewId ?? '')?.rounds[0];
  assert.deepEqual(
    round?.annotations.map((item) => item.anchor),
    f.attachment.selections.map((item) => item.selection),
  );
  const returned = await f.candidate(request.record.requestId);
  assert.equal(returned.view.review.rounds.at(-1)?.responses.length, 2);
  assert.deepEqual(await readFile(join(f.root, 'review-input.mp4')), before);
});
