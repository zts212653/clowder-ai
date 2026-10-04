import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { MessageMediaPublicationSource } from '@cat-cafe/shared';
import Fastify from 'fastify';
import sharp from 'sharp';
import { registerPublishedContentRoutes } from '../src/routes/published-content-routes.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'f309-message-continuity-'));
  const bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#abcdef' } })
    .png()
    .toBuffer();
  await writeFile(join(root, 'review-input.png'), bytes);
  await writeFile(join(root, 'returned.png'), bytes);
  const f = await createLiveReviewFixture(root);
  const app = Fastify();
  registerPublishedContentRoutes(app, { media: f.media });
  t.after(async () => {
    await app.close();
    await f.dispatch.close();
    f.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const source: MessageMediaPublicationSource = {
    kind: 'message',
    threadId: f.thread.id,
    messageId: f.publication.id,
    messageRevision: String(f.publication.timestamp),
    expectedUrl: '/uploads/review-input.png',
    item: { kind: 'media-gallery', blockId: 'review-input.png', itemIndex: 0 },
  };
  const resolve = (value = source, selection?: { contentRef: string; ownerRevision: number }) =>
    app.inject({
      method: 'POST',
      url: '/api/content-publications/resolve',
      headers: { 'x-cat-cafe-user': 'operator' },
      payload: { source: value, operationId: 'open-from-message', ...(selection ? { selection } : {}) },
    });
  return { ...f, app, source, resolve };
}

test('opening the exact original message reuses the retained Task asset and inline discussion', async (t) => {
  const f = await fixture(t);
  const opened = await f.reviews.prepare(f.prepare, f.human);
  const annotated = await f.reviews.act(
    {
      reviewId: opened.review.reviewId,
      round: 1,
      expectedRevision: 1,
      expectedTaskRevision: 1,
      operationId: 'original-comment',
      action: {
        kind: 'annotate',
        annotationId: 'original',
        body: '原来的标记',
        anchor: { kind: 'image-point', x: 4, y: 5 },
      },
    },
    f.human,
  );
  const oldAsset = annotated.view.review.rounds[0]!.asset;
  const fromMessage = await f.media.prepare({ source: f.source, operationId: 'chat-open', principal: f.human });
  assert.deepEqual(fromMessage, oldAsset, 'opening a message must not import a second publication');
  const response = await f.resolve();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().status, 'resolved');
  assert.deepEqual(response.json().asset, oldAsset);
  assert.equal(f.store.get(opened.review.reviewId)?.rounds[0]?.annotations[0]?.body, '原来的标记');
  assert.equal(f.store.ledgers.getByContent('operator', `${oldAsset.contentRef}#version:1`), null);
});

test('a retained F138 version is found even before the review projection commits', async (t) => {
  const f = await fixture(t);
  const original = await f.media.prepare({ ...f.prepare, principal: f.human });
  const returned = f.publish('returned.png');
  const asset = await f.media.publishVersion({
    ...f.prepare,
    principal: f.cat,
    contentRef: original.contentRef,
    expectedOwnerRevision: 1,
    operationId: 'owner-only-return',
    artifactRef: '/uploads/returned.png',
    expectedArtifactRevision: String(returned.timestamp),
  });
  const response = await f.resolve({
    ...f.source,
    messageId: returned.id,
    messageRevision: String(returned.timestamp),
    expectedUrl: '/uploads/returned.png',
    item: { kind: 'media-gallery', blockId: 'returned.png', itemIndex: 0 },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().asset, asset);
  assert.equal(asset.ownerRevision, 2);
  assert.equal(f.store.directory.ids().length, 0, 'resolution needs neither a fake Task nor a review projection');
});

test('legacy duplicate items require a named choice; known revoked lineage cannot become a new import', async (t) => {
  const f = await fixture(t);
  const original = await f.media.prepare({ ...f.prepare, principal: f.human });
  f.publication.contentBlocks = [{ type: 'image', url: f.source.expectedUrl }];
  const ambiguous = await f.resolve();
  assert.equal(ambiguous.statusCode, 200, ambiguous.body);
  assert.equal(ambiguous.json().status, 'choice-required');
  assert.equal(ambiguous.json().choices.length, 1);
  assert.equal(ambiguous.json().choices[0].match, 'legacy-ambiguous');
  assert.equal(ambiguous.json().choices[0].taskTitle, '猫咖秋日封面');
  assert.equal(ambiguous.json().choices[0].threadTitle, '一起完成发布');
  const selected = await f.resolve(f.source, {
    contentRef: original.contentRef,
    ownerRevision: original.ownerRevision,
  });
  assert.equal(selected.statusCode, 200, selected.body);
  assert.deepEqual(selected.json().asset, original);
  await assert.rejects(
    f.media.prepare({ ...f.prepare, principal: f.human, operationId: 'new-task-ambiguous' }),
    /publication_changed/,
  );
  const forged = await f.resolve(f.source, { contentRef: 'prepared-media:' + 'f'.repeat(64), ownerRevision: 1 });
  assert.equal(forged.statusCode, 409);
  const readTask = f.tasks.get.bind(f.tasks);
  f.tasks.get = (id) => (id === f.taskId ? null : readTask(id));
  const revoked = await f.resolve();
  assert.equal(revoked.statusCode, 403, revoked.body);
});

test('exact selectors keep equal URLs distinct and multiple retained Task publications require explicit selection', async (t) => {
  const f = await fixture(t);
  const original = await f.media.prepare({ ...f.prepare, principal: f.human });
  const second = await f.lifecycle.admitOrResume({
    task: {
      threadId: f.thread.id,
      userId: 'operator',
      ownerCatId: f.publication.catId!,
      createdBy: f.publication.catId!,
      title: '另一份委托',
      why: '同一作品的另一用途',
    },
    admission: {
      basis: 'explicit_entrustment',
      idempotencyKey: 'other-context',
      sourceRefs: ['message:other-human-request'],
      intendedOutcome: '另做一个宣传版本',
    },
    closure: { condition: '返回宣传版', expectedSignal: 'version-ready' },
    artifactRefs: [f.source.expectedUrl],
  });
  assert.ok('subjectRef' in second && second.subjectRef);
  const secondAsset = await f.media.prepare({
    ...f.prepare,
    taskId: second.subjectRef.replace(/^task:work:/, ''),
    principal: f.human,
  });
  assert.notEqual(original.contentRef, secondAsset.contentRef);
  const ambiguous = await f.resolve();
  assert.equal(ambiguous.json().status, 'choice-required');
  assert.equal(ambiguous.json().choices.length, 2);
  assert.ok(ambiguous.json().choices.every((choice: { match: string }) => choice.match === 'exact'));
  const chosen = await f.resolve(f.source, { contentRef: secondAsset.contentRef, ownerRevision: 1 });
  assert.equal(chosen.json().asset.contentRef, secondAsset.contentRef);

  const published = f.publish('returned.png');
  published.contentBlocks = [{ type: 'image', url: '/uploads/returned.png' }];
  const rich: MessageMediaPublicationSource = {
    ...f.source,
    messageId: published.id,
    messageRevision: String(published.timestamp),
    expectedUrl: '/uploads/returned.png',
    item: { kind: 'media-gallery', blockId: 'returned.png', itemIndex: 0 },
  };
  const one = await f.resolve(rich);
  const two = await f.resolve({ ...rich, item: { kind: 'content-block', index: 0 } });
  assert.equal(one.json().status, 'resolved');
  assert.equal(two.json().status, 'resolved');
  assert.notEqual(
    one.json().asset.contentRef,
    two.json().asset.contentRef,
    'equal bytes and URL are not item identity',
  );
  assert.deepEqual((await f.resolve(rich)).json().asset, one.json().asset);
});

test('message resolver requires direct human and current exact message visibility', async (t) => {
  const f = await fixture(t);
  await f.media.prepare({ ...f.prepare, principal: f.human });
  for (const headers of [
    {},
    { 'x-cat-cafe-user': 'other' },
    { 'x-cat-cafe-user': 'operator', 'x-invocation-id': 'cat' },
  ]) {
    const denied = await f.app.inject({
      method: 'POST',
      url: '/api/content-publications/resolve',
      headers,
      payload: { source: f.source, operationId: 'probe' },
    });
    assert.ok([401, 403].includes(denied.statusCode), denied.body);
  }
  assert.equal((await f.resolve({ ...f.source, messageRevision: '0' })).statusCode, 409);
  f.publication.recall = { recalledBy: 'operator', recalledAt: Date.now() };
  assert.equal((await f.resolve()).statusCode, 403);
});

test('message-scope source revocation already checks its exact selector before the legacy tuple path', async (t) => {
  const f = await fixture(t);
  const block = f.publication.extra?.rich?.blocks?.[0];
  assert.ok(block?.kind === 'media_gallery');
  block.items.push({ url: f.source.expectedUrl, alt: '被选中的 A' });
  const selected = { ...f.source, item: { kind: 'media-gallery' as const, blockId: 'review-input.png', itemIndex: 1 } };
  const asset = await f.media.prepare({ source: selected, operationId: 'selected-A', principal: f.human });
  block.items.pop();
  assert.equal(block.items[0]?.url, selected.expectedUrl, 'same-URL sibling B remains visible');
  await assert.rejects(f.media.read(asset.contentRef, asset.ownerRevision, f.human), /publication_changed/);
});

test('Task-scoped publication can be admitted after message-scoped publication; an O(1) early return would hide it', async (t) => {
  const f = await fixture(t);
  const fromMessage = await f.media.prepare({ source: f.source, operationId: 'message-first', principal: f.human });
  const laterTask = await f.reviews.prepare(f.prepare, f.human);
  assert.notEqual(laterTask.review.contentRef, fromMessage.contentRef);
  const reopened = await f.resolve();
  assert.equal(reopened.json().status, 'choice-required');
  assert.equal(reopened.json().choices.length, 2);
});

test('a partially inaccessible source catalogue does not silently choose the single accessible object', async (t) => {
  const f = await fixture(t);
  await f.media.prepare({ source: f.source, operationId: 'message-first', principal: f.human });
  await f.reviews.prepare(f.prepare, f.human);
  const readTask = f.tasks.get.bind(f.tasks);
  f.tasks.get = (id) => (id === f.taskId ? null : readTask(id));
  const reopened = await f.resolve();
  assert.equal(reopened.json().status, 'choice-required');
  assert.equal(reopened.json().unavailableContexts, true);
  assert.equal(reopened.json().choices.length, 1);
  assert.equal(reopened.body.includes(f.taskId), false, 'unavailable coordinates and titles are not disclosed');
});
