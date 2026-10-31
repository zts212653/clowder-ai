import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveGrowingSourceMessageRevision } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { modificationMessageRequestId } from '../src/domains/collaborative-content/modification/journal.js';
import { WorkspaceContentReviewError } from '../src/domains/collaborative-content/workspace-review/errors.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { firstFileFixture } from './helpers/content-modification-first-file-fixture.js';

for (const path of ['guide.md', 'greeting.ts']) {
  test(`first-use ${path}: authenticated Human takeover prepares its canonical empty owner without annotation UI`, async (t) => {
    const f = await firstFileFixture(t, path);
    const original = await readFile(join(f.root, path), 'utf8');
    assert.equal(f.fileStore.get(f.reviewId), null);
    const result = await f.takeover();
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().record.payload.source.reviewId, f.reviewId);
    const review = f.fileStore.get(f.reviewId);
    assert.equal(review?.revision, 1);
    assert.deepEqual(review?.annotations, []);
    assert.equal(review?.source.revision, f.description.revision);
    const receipt = f.fileStore.operationReceipt(f.reviewId, f.operationId);
    assert.deepEqual(receipt?.actor, f.cat.actor);
    assert.deepEqual(receipt?.preparationSource, {
      kind: 'human_message',
      threadId: f.thread.id,
      messageId: f.message.id,
      messageRevision: deriveGrowingSourceMessageRevision(f.message),
    });
    const reopened = new WorkspaceContentReviewStore(join(f.root, 'files.sqlite'));
    try {
      assert.deepEqual(
        reopened.operationReceipt(f.reviewId, f.operationId),
        receipt,
        'Cat and Human provenance survives a new database connection',
      );
    } finally {
      reopened.close();
    }
    assert.equal(f.tasks.listByThread(f.thread.id).length, f.taskCount + 1);
    const replay = await f.takeover(f.message.id, randomUUID());
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().record.requestId, result.json().record.requestId);
    assert.equal(f.tasks.listByThread(f.thread.id).length, f.taskCount + 1);
    assert.equal(f.fileStore.get(f.reviewId)?.revision, 1);
    assert.equal(await readFile(join(f.root, path), 'utf8'), original);
  });
}

for (const boundary of ['recalled', 'root-revoked'] as const) {
  test(`takeover replay after ${boundary} does not repeat preparation or admission`, async (t) => {
    const f = await firstFileFixture(t);
    const first = await f.takeover();
    assert.equal(first.statusCode, 200, first.body);
    const review = f.fileStore.get(f.reviewId);
    if (boundary === 'recalled') f.message.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };
    else f.revoke();
    const replay = await f.takeover(f.message.id, randomUUID());
    if (boundary === 'recalled') assert.notEqual(replay.statusCode, 200, replay.body);
    else {
      // Existing resume truth returns its durable error view; HTTP 200 does not restore file authority.
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(replay.json().record.issue.code, 'access_denied');
      assert.equal(replay.json().record.requestId, first.json().record.requestId);
    }
    assert.deepEqual(f.fileStore.get(f.reviewId), review);
    assert.equal(f.tasks.listByThread(f.thread.id).length, f.taskCount + 1);
  });
}

test('same bytes under a different canonical file owner cannot prepare a review or request', async (t) => {
  const f = await firstFileFixture(t);
  const batch = f.source.resolveRenderedTextSelections.bind(f.source);
  f.source.resolveRenderedTextSelections = async (input) => {
    const result = await batch(input);
    await f.rebind();
    return result;
  };
  const result = await f.takeover();
  const rebound = await f.source.describe({ principal: { userId: 'operator' }, locator: f.locator });
  assert.notEqual(rebound.contentRef, f.description.contentRef);
  assert.equal(
    f.fileStore.getByContent('operator', rebound.contentRef),
    null,
    'identity drift leaves no other-owner review',
  );
  assert.equal(f.fileStore.get(f.reviewId), null);
  assert.equal(result.statusCode, 409, result.body);
  assert.equal(f.store.requests.get(modificationMessageRequestId('operator', f.message.id), 'operator'), null);
  assert.equal(f.tasks.listByThread(f.thread.id).length, f.taskCount);
});

for (const boundary of ['recalled', 'root-revoked', 'file-drift', 'unmapped-quote'] as const) {
  test(`first-use ${boundary}: rejected takeover creates neither review, request nor Task`, async (t) => {
    const f = await firstFileFixture(t);
    if (boundary === 'recalled') f.message.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };
    if (boundary === 'root-revoked') f.revoke();
    if (boundary === 'file-drift') await writeFile(join(f.root, f.locator.path), 'Different source bytes.');
    const sourceMessageId =
      boundary === 'unmapped-quote'
        ? f.messages.append({
            userId: 'operator',
            threadId: f.thread.id,
            catId: null,
            mentions: ['codex-astra'],
            timestamp: Date.now() + 1,
            content: 'Please change this.',
            contentBlocks: [f.block('No such passage')],
          }).id
        : f.message.id;
    const result = await f.takeover(sourceMessageId);
    assert.notEqual(result.statusCode, 200, result.body);
    assert.equal(f.fileStore.get(f.reviewId), null);
    assert.equal(f.store.requests.get(modificationMessageRequestId('operator', sourceMessageId), 'operator'), null);
    assert.equal(f.tasks.listByThread(f.thread.id).length, f.taskCount);
  });
}

test('public prepare still rejects an authenticated callback Cat on a first-use file', async (t) => {
  const f = await firstFileFixture(t);
  const result = await f.app.inject({
    method: 'POST',
    url: '/api/workspace/content-reviews/prepare',
    headers: {
      'x-cat-cafe-user': 'operator',
      'x-invocation-id': f.auth.invocationId,
      'x-callback-token': f.auth.callbackToken,
    },
    payload: { locator: f.locator, operationId: randomUUID() },
  });
  assert.equal(result.statusCode, 401, result.body);
  assert.equal(f.fileStore.get(f.reviewId), null);
});

for (const boundary of [
  'late-recall',
  'late-message-edit',
  'late-root-revocation',
  'late-file-drift',
  'create-failure',
] as const) {
  test(`first-use ${boundary}: preparation failure precedes request and Task admission`, async (t) => {
    const f = await firstFileFixture(t);
    if (boundary === 'create-failure') {
      f.fileStore.create = () => {
        throw new WorkspaceContentReviewError('invalid_action');
      };
    } else {
      const batch = f.source.resolveRenderedTextSelections.bind(f.source);
      f.source.resolveRenderedTextSelections = async (input) => {
        const resolved = await batch(input);
        if (boundary === 'late-recall') f.message.recall = { version: 1, exposure: 'none', recalledAt: Date.now() };
        if (boundary === 'late-message-edit') f.message.content = 'Changed owner intent.';
        if (boundary === 'late-root-revocation') f.revoke();
        if (boundary === 'late-file-drift')
          await writeFile(join(f.root, f.locator.path), 'Changed after quote mapping.');
        return resolved;
      };
    }
    const result = await f.takeover();
    assert.notEqual(result.statusCode, 200, result.body);
    assert.equal(f.fileStore.get(f.reviewId), null);
    assert.equal(f.store.requests.get(modificationMessageRequestId('operator', f.message.id), 'operator'), null);
    assert.equal(f.tasks.listByThread(f.thread.id).length, f.taskCount);
  });
}

for (const boundary of [
  'wrong-owner',
  'wrong-thread',
  'cat-source',
  'no-mention',
  'whisper',
  'undelivered',
  'mixed-file',
  'mixed-revision',
] as const) {
  test(`first-use ${boundary}: invalid Human authority or quoted scope leaves no owner`, async (t) => {
    const f = await firstFileFixture(t);
    if (boundary === 'wrong-owner') f.message.userId = 'someone-else';
    if (boundary === 'wrong-thread') f.message.threadId = 'another-thread';
    if (boundary === 'cat-source') f.message.catId = f.cat.actor.actorId;
    if (boundary === 'no-mention') f.message.mentions = [];
    if (boundary === 'whisper') {
      f.message.visibility = 'whisper';
      f.message.whisperTo = [];
    }
    if (boundary === 'undelivered') f.message.deliveryStatus = 'queued';
    if (boundary === 'mixed-file' || boundary === 'mixed-revision') {
      const block = f.block();
      block.attachment.id = 'second-selection';
      if (boundary === 'mixed-file') block.attachment.source.path = 'other.md';
      else block.attachment.source.revision = `sha256:${'0'.repeat(64)}`;
      f.message.contentBlocks?.push(block);
    }
    const result = await f.takeover();
    assert.notEqual(result.statusCode, 200, result.body);
    assert.equal(f.fileStore.get(f.reviewId), null);
    assert.equal(f.tasks.listByThread(f.thread.id).length, f.taskCount);
  });
}

test('first-use ambiguous rendered quote is rejected before canonical preparation', async (t) => {
  const f = await firstFileFixture(t, 'guide.md', 'First unique paragraph.\n\nFirst unique paragraph.\n');
  const result = await f.takeover();
  assert.equal(result.statusCode, 409, result.body);
  assert.equal(f.fileStore.get(f.reviewId), null);
  assert.equal(f.tasks.listByThread(f.thread.id).length, f.taskCount);
});

for (const state of ['current', 'changed'] as const) {
  test(`existing ${state} review: takeover preserves annotations and revision, without automatic refresh`, async (t) => {
    const f = await firstFileFixture(t);
    await f.files.prepare({ principal: f.human, locator: f.locator, operationId: 'human-open' });
    await f.files.annotate({
      principal: f.human,
      reviewId: f.reviewId,
      expectedRevision: 1,
      operationId: 'human-annotation',
      body: 'Keep this discussion.',
      target: { kind: 'text_quote', quote: 'First unique paragraph.' },
    });
    const before = f.fileStore.get(f.reviewId);
    if (state === 'changed') {
      await writeFile(join(f.root, f.locator.path), '# Revised guide\nFirst unique paragraph.\n');
      const fresh = await f.source.describe({ principal: { userId: 'operator' }, locator: f.locator });
      const block = f.block();
      block.attachment.source.revision = fresh.revision;
      f.message.contentBlocks = [block];
    }
    const result = await f.takeover();
    assert.equal(result.statusCode, state === 'current' ? 200 : 409, result.body);
    assert.deepEqual(f.fileStore.get(f.reviewId), before);
    assert.equal(
      f.fileStore.operationReceipt(f.reviewId, f.operationId),
      null,
      'reused owner has no new prepare receipt',
    );
    assert.equal(f.tasks.listByThread(f.thread.id).length, f.taskCount + (state === 'current' ? 1 : 0));
  });
}
