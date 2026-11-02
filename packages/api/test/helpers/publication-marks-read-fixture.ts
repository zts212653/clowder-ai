import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createCatId, type MediaContextAttachment } from '@cat-cafe/shared';
import Fastify from 'fastify';
import sharp from 'sharp';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { StoredMessage } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { ArtifactReviewService } from '../../src/domains/collaborative-content/artifact-review/service.js';
import { ArtifactReviewStore } from '../../src/domains/collaborative-content/artifact-review/store.js';
import { WorkspaceContentReviewService } from '../../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentSourceService } from '../../src/domains/workspace/workspace-content-source.js';
import { registerCallbackArtifactReviewRoutes } from '../../src/routes/callback-artifact-review-routes.js';
import { createReviewFixture, reviewHuman } from './artifact-review-fixture.js';
import './setup-cat-registry.js';

export async function publicationMarksFixture(kind: 'image' | 'video' = 'image') {
  const root = await mkdtemp(join(tmpdir(), 'publication-marks-read-'));
  const uploads = join(root, 'uploads');
  await mkdir(uploads);
  const store = new ArtifactReviewStore(join(root, 'reviews.sqlite'));
  const f = createReviewFixture(root, uploads, store);
  f.task.current = null;
  const mime = kind === 'image' ? 'image/png' : 'video/mp4';
  const file = kind === 'image' ? 'cover.png' : 'film.mp4';
  if (kind === 'image') {
    await writeFile(
      join(uploads, file),
      await sharp({
        create: {
          width: 1810,
          height: 629,
          channels: 3,
          background: '#f8eada',
        },
      })
        .png()
        .toBuffer(),
    );
  } else {
    await promisify(execFile)('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x180:r=10',
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      join(uploads, file),
    ]);
  }
  const publication = kind === 'image' ? f.publication : f.publish('/uploads/film.mp4', mime);
  const asset = await f.media.prepare({
    principal: reviewHuman,
    operationId: 'open-publication',
    source: {
      kind: 'message',
      threadId: publication.threadId,
      messageId: publication.id,
      messageRevision: String(publication.timestamp),
      expectedUrl: `/uploads/${file}`,
      item:
        kind === 'image'
          ? { kind: 'media-gallery', blockId: 'image', itemIndex: 0 }
          : { kind: 'rich-file', blockId: 'video' },
    },
  });
  const workspace = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => {
      throw new Error('publication reads must not invent a file locator');
    },
  });
  const ledgers = new WorkspaceContentReviewService({ store: store.ledgers, source: workspace, publications: f.media });
  const opened = await ledgers.prepare({
    principal: reviewHuman,
    publication: {
      contentRef: asset.contentRef,
      ownerRevision: asset.ownerRevision,
    },
    operationId: 'open-ledger',
  });
  const drawings = [142, 150, 153].map((count, index) => ({
    id: `red-circle-${index}`,
    kind: 'stroke' as const,
    color: '#d04a3a' as const,
    strokeWidth: 6,
    points: Array.from({ length: count }, (_, i) => ({
      x: 20 + index * 55 + 10 * Math.cos((i / count) * 2 * Math.PI),
      y: 35 + 10 * Math.sin((i / count) * 2 * Math.PI),
    })),
    ...(asset.media.kind === 'video' ? { frame: { streamId: asset.media.streamId, tick: asset.media.startTick } } : {}),
  }));
  const saved = await ledgers.act({
    principal: reviewHuman,
    reviewId: opened.review.reviewId,
    expectedRevision: 1,
    operationId: 'save-three-red-circles',
    action: { kind: 'add_visual_marks', marks: drawings },
  });
  const attachment: MediaContextAttachment = {
    v: 1,
    id: 'question-media',
    kind: 'media',
    title: '三个红圈在哪里',
    mediaType: mime,
    source: {
      kind: 'publication',
      contentRef: asset.contentRef,
      ownerRevision: asset.ownerRevision,
      ledgerRef: saved.review.reviewId,
      expectedLedgerRevision: saved.review.revision,
    },
    selections: [],
  };
  const question: StoredMessage = {
    id: 'human-question',
    threadId: publication.threadId,
    userId: 'operator',
    catId: null,
    content: '我在这里用红色圈圈了三个，能看到吗？',
    timestamp: 2000,
    mentions: [createCatId('codex-astra')],
    contentBlocks: [{ type: 'context_attachment', attachment }],
  };
  f.messages.set(question.id, question);
  const registry = new InvocationRegistry();
  const auth = await registry.create('operator', createCatId('codex-astra'), publication.threadId);
  const app = Fastify();
  const publicationReads = { media: f.media, ledgers: store.ledgers, messages: f.messageStore };
  await registerCallbackArtifactReviewRoutes(app, {
    reviews: new ArtifactReviewService({ store, media: f.media }),
    threads: f.threadStore,
    registry,
    changed: async () => {},
    ...{ publicationReads },
  });
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const payload = {
    reviewId: saved.review.reviewId,
    sourceMessageId: question.id,
    attachmentId: attachment.id,
    view: 'marks',
  };
  const read = (extra: Record<string, unknown> = {}, credentials: Record<string, string> = headers) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/artifact-review/read',
      headers: credentials,
      payload: { ...payload, ...extra },
    });
  const close = async () => {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  };
  return {
    ...f,
    root,
    store,
    ledgers,
    publication,
    asset,
    question,
    attachment,
    saved,
    drawings,
    app,
    registry,
    auth,
    headers,
    payload,
    read,
    close,
  };
}
