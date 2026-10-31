import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createCatId, type MediaContextAttachment } from '@cat-cafe/shared';
import Fastify from 'fastify';
import sharp from 'sharp';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { TurnExecutionSourceReadPort } from '../../src/domains/cats/services/stores/ports/TurnExecutionStore.js';
import { createContentModificationIntegration } from '../../src/domains/collaborative-content/modification/composition.js';
import { WorkspaceContentReviewService } from '../../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentReviewStore } from '../../src/domains/collaborative-content/workspace-review/store.js';
import { WorkspaceContentSourceService } from '../../src/domains/workspace/workspace-content-source.js';
import { registerCallbackArtifactReviewRoutes } from '../../src/routes/callback-artifact-review-routes.js';
import { registerCallbackContentModificationRoutes } from '../../src/routes/callback-content-modification-routes.js';
import { registerContentModificationRoutes } from '../../src/routes/content-modification-routes.js';
import { createLiveReviewFixture } from './artifact-review-live-fixture.js';

export async function mediaMessageFixture(
  t: { after: (callback: () => Promise<void>) => void },
  mediaType: 'image/png' | 'video/mp4' = 'image/png',
  turnExecutions?: TurnExecutionSourceReadPort,
  options?: { authenticatedQueue?: boolean; nativeImageArchiveDirectory?: string; publicationLedger?: boolean },
) {
  const root = await mkdtemp(join(tmpdir(), 'f309-media-intake-'));
  const extension = mediaType === 'image/png' ? 'png' : 'mp4';
  async function writeMedia(name: string, color: string) {
    if (mediaType === 'image/png')
      return sharp({ create: { width: 160, height: 100, channels: 3, background: color } })
        .png()
        .toFile(join(root, name));
    await promisify(execFile)(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=160x100:r=25:d=0.12`,
        '-c:v',
        'libx264',
        join(root, name),
      ],
      { timeout: 15000 },
    );
  }
  await writeMedia(`review-input.${extension}`, 'blue');
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'media-worktree' }),
  });
  const registry = new InvocationRegistry();
  const f = await createLiveReviewFixture(
    root,
    mediaType,
    undefined,
    source,
    undefined,
    options?.authenticatedQueue ? registry : undefined,
  );
  const filesStore = new WorkspaceContentReviewStore(join(root, 'files.sqlite'));
  const files = new WorkspaceContentReviewService({ source, store: filesStore });
  const errors: unknown[] = [];
  const integration = createContentModificationIntegration(
    Object.assign(
      {
        dataDir: root,
        source,
        files,
        artifacts: f,
        tasks: f.tasks,
        messages: f.messages,
        ...(turnExecutions ? { turnExecutions } : {}),
        delivery: f.dispatch.delivery,
        changed: () => {},
        receiptChanged: () => {},
        onError: (error) => errors.push(error),
      },
      options?.nativeImageArchiveDirectory ? { nativeImageArchiveDirectory: options.nativeImageArchiveDirectory } : {},
    ),
  );
  const app = Fastify();
  const actor = await registry.create('operator', 'codex-astra', f.thread.id);
  registerContentModificationRoutes(app, integration);
  await registerCallbackContentModificationRoutes(app, {
    ...integration,
    threads: f.threads,
    registry,
    changed: () => {},
  });
  await registerCallbackArtifactReviewRoutes(app, {
    reviews: f.reviews,
    threads: f.threads,
    registry,
    changed: () => {},
  });
  t.after(async () => {
    await app.close();
    await f.dispatch.close();
    integration.writer.close();
    filesStore.close();
    f.store.close();
    console.info(`retained owned media review data: ${root}`);
  });
  if (options?.publicationLedger) {
    const asset = await f.media.prepare({ ...f.prepare, principal: f.human });
    const ledgers = new WorkspaceContentReviewService({ source, store: f.store.ledgers, publications: f.media });
    await ledgers.prepare({ publication: asset, principal: f.human, operationId: randomUUID() });
  }
  const opened = await f.reviews.prepare(f.prepare, f.human);
  const linkedRound = opened.review.rounds[0];
  let attachmentSource: MediaContextAttachment['source'] = {
    kind: 'artifact-review',
    reviewId: opened.review.reviewId,
    expectedReviewRevision: opened.review.revision,
    round: 1,
  };
  if (options?.publicationLedger) {
    assert.ok(linkedRound?.ledgerRef);
    assert.ok(linkedRound.ledgerRevision);
    attachmentSource = {
      kind: 'publication',
      contentRef: linkedRound.asset.contentRef,
      ownerRevision: linkedRound.asset.ownerRevision,
      ledgerRef: linkedRound.ledgerRef,
      expectedLedgerRevision: linkedRound.ledgerRevision,
    };
  }
  const attachment: MediaContextAttachment = {
    v: 1,
    id: 'image',
    kind: 'media',
    title: opened.review.title,
    mediaType,
    source: attachmentSource,
    taskContext: {
      kind: 'media',
      taskId: f.taskId,
      expectedTaskRevision: opened.authority.taskRevision,
      reviewId: opened.review.reviewId,
      expectedReviewRevision: opened.review.revision,
      round: 1,
    },
    selections: [
      {
        id: '1',
        selection: { kind: 'image-region', x: 10, y: 20, width: 40, height: 30 },
        instruction: '移除这里的字',
      },
      { id: '2', selection: { kind: 'image-point', x: 120, y: 70 }, instruction: '这里加星星' },
    ],
  };
  const originalMedia = opened.review.rounds[0]?.asset.media;
  if (originalMedia?.kind === 'video') {
    const midpoint = originalMedia.startTick + Math.floor(originalMedia.durationTicks / 2);
    attachment.selections = [
      {
        id: '1',
        selection: {
          kind: 'video-range',
          streamId: originalMedia.streamId,
          startTick: originalMedia.startTick,
          endTick: midpoint,
        },
        instruction: '修改片头',
      },
      {
        id: '2',
        selection: {
          kind: 'video-range',
          streamId: originalMedia.streamId,
          startTick: midpoint,
          endTick: originalMedia.startTick + originalMedia.durationTicks,
        },
        instruction: '修改片尾',
      },
    ];
  }
  function send(reference = attachment, body = '请一起修改这两处。') {
    return f.messages.append({
      userId: 'operator',
      from: { kind: 'user', userId: 'operator' },
      threadId: f.thread.id,
      mentions: [createCatId('codex-astra')],
      visibility: 'whisper',
      whisperTo: [createCatId('codex-astra')],
      timestamp: Date.now(),
      content: body,
      contentBlocks: [
        { type: 'context_attachment', attachment: reference },
        { type: 'image', url: '/uploads/untrusted-preview.png' },
      ],
    });
  }
  async function takeOver(messageId: string) {
    return integration.requests.takeOver({ sourceMessageId: messageId, operationId: randomUUID() }, f.cat);
  }
  async function candidateCommand(requestId: string, name = `candidate.${extension}`) {
    await writeMedia(name, 'green');
    const publication = f.publish(name);
    const record = f.store.requests.get(requestId, 'operator');
    if (!record?.progress.review) throw new Error('Request not bound');
    const view = await f.reviews.readCurrent(record.progress.review.reviewId, f.cat);
    const round = view.review.rounds.at(-1);
    if (!round) throw new Error('No source round');
    return {
      requestId,
      reviewId: view.review.reviewId,
      expectedRevision: view.review.revision,
      expectedTaskRevision: view.authority.taskRevision,
      expectedOwnerRevision: round.asset.ownerRevision,
      expectedLedgerRevision: round.ledgerRevision,
      operationId: randomUUID(),
      artifactRef: `/uploads/${name}`,
      expectedArtifactRevision: String(publication.timestamp),
      responses: round.annotations.map((annotation) => ({
        annotationId: annotation.id,
        disposition: 'addressed',
        explanation: '按此处修改了。',
      })),
    };
  }
  async function candidate(requestId: string, name?: string) {
    const command = await candidateCommand(requestId, name);
    return { ...(await f.reviews.respond(command, f.cat)), command };
  }
  return {
    ...f,
    app,
    registry,
    actor,
    source,
    files,
    filesStore,
    integration,
    attachment,
    send,
    takeOver,
    candidate,
    candidateCommand,
    errors,
    root,
  };
}
