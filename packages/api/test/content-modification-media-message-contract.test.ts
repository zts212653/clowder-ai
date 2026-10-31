import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { ArtifactReviewService } from '../src/domains/collaborative-content/artifact-review/service.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { buildMessageContentBlocks, sendMessageSchema } from '../src/routes/messages.schema.js';
import { createReviewFixture, reviewHuman } from './helpers/artifact-review-fixture.js';

async function mediaSource(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'f309-media-message-contract-'));
  const uploads = join(root, 'uploads');
  await mkdir(uploads);
  await sharp({ create: { width: 160, height: 100, channels: 3, background: '#abcdef' } })
    .png()
    .toFile(join(uploads, 'cover.png'));
  const store = new ArtifactReviewStore(join(root, 'review.sqlite'));
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const f = createReviewFixture(root, uploads, store);
  const reviews = new ArtifactReviewService({ store, media: f.media });
  const { principal: _principal, ...request } = f.prepare;
  const view = await reviews.prepare(request, reviewHuman);
  return {
    v: 1,
    id: 'source-cover',
    kind: 'media',
    title: view.review.title,
    mediaType: 'image/png',
    source: {
      kind: 'artifact-review',
      reviewId: view.review.reviewId,
      round: 1,
      expectedReviewRevision: view.review.revision,
    },
    taskContext: {
      kind: 'media',
      taskId: view.review.task.taskId,
      expectedTaskRevision: view.authority.taskRevision,
      reviewId: view.review.reviewId,
      expectedReviewRevision: view.review.revision,
      round: 1,
    },
    selections: [
      {
        id: '1',
        selection: { kind: 'image-region', x: 10, y: 20, width: 40, height: 30 },
        instruction: '移除这里的文字',
      },
      { id: '2', selection: { kind: 'image-point', x: 120, y: 70 }, instruction: '这里加一颗星星' },
    ],
  };
}

test('one Human PNG send retains one original body, canonical ranges and separate display images', async (t) => {
  const attachment = await mediaSource(t);
  const body = '请一起改这两处。\n  保留原图的风格。';
  const idempotencyKey = randomUUID();
  const request = { content: body, idempotencyKey, contextAttachments: [attachment] };
  const result = sendMessageSchema.safeParse(request);
  assert.equal(result.success, true, 'the canonical message boundary must admit the real media-reference variant');
  if (!result.success) return;
  const screenshots = [
    { type: 'image' as const, url: '/uploads/display-region-1.png' },
    { type: 'image' as const, url: '/uploads/display-region-2.png' },
  ];
  const blocks = buildMessageContentBlocks(result.data.content, result.data.contextAttachments, screenshots);
  assert.deepEqual(
    blocks.filter((block) => block.type === 'text'),
    [{ type: 'text', text: body }],
  );
  assert.deepEqual(
    blocks.filter((block) => block.type === 'context_attachment'),
    [{ type: 'context_attachment', attachment }],
  );
  assert.deepEqual(
    blocks.filter((block) => block.type === 'image'),
    screenshots,
  );
  assert.deepEqual(sendMessageSchema.parse(request), result.data, 'send retries preserve the same idempotency key');
});

test('a Human whole-image send retains the same canonical source and original Task without invented ranges', async (t) => {
  const original = await mediaSource(t);
  const attachment = { ...original, selections: [] };
  const result = sendMessageSchema.safeParse({ content: '整体改成暖色。', contextAttachments: [attachment] });
  assert.equal(result.success, true, 'an empty media selection set means the whole identified work');
  if (!result.success) return;
  assert.deepEqual(result.data.contextAttachments, [attachment]);
  assert.equal('text' in attachment, false, 'a media source is not a fabricated text quote');
  assert.equal('url' in attachment, false, 'a display screenshot is not canonical source identity');
});

test('existing text quotes and display images still use one message content sequence', () => {
  const result = sendMessageSchema.parse({
    content: '这一段改一下。',
    contextAttachments: [
      { v: 1, kind: 'quote', id: 'text-one', text: '原文', source: { kind: 'workspace_file', path: 'README.md' } },
    ],
  });
  const blocks = buildMessageContentBlocks(result.content, result.contextAttachments, [
    { type: 'image', url: '/uploads/display-only.png' },
  ]);
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['text', 'context_attachment', 'image'],
  );
});
