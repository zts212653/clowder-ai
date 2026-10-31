import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { CatId, ProjectScreeningContextAttachment, VideoProjectScreening } from '@cat-cafe/shared';
import { mapScreeningMediaRange } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { type AppendMessageInput, MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { ArtifactReviewStore } from '../../src/domains/collaborative-content/artifact-review/store.js';
import { WorkspaceContentReviewError } from '../../src/domains/collaborative-content/workspace-review/errors.js';
import { VideoProjectMessageImporter } from '../../src/domains/collaborative-content/workspace-review/project-message/import.js';
import { createProjectMessageProducer } from '../../src/domains/collaborative-content/workspace-review/project-message/producer.js';
import type { VideoProjectMessageAuthority } from '../../src/domains/collaborative-content/workspace-review/project-message/types.js';
import { VideoProjectService } from '../../src/domains/video-studio/project/service.js';
import { importStoredProjectMessage } from '../../src/routes/messages-project-review.js';
import { registerVideoProjectReviewRoutes } from '../../src/routes/video-project-review-routes.js';
import { screeningFixture } from './video-project-screening.js';

export function projectOpinionAttachment(screening: VideoProjectScreening): ProjectScreeningContextAttachment {
  const mediaRange = {
    startPts: screening.media.media.startTick,
    endPts: screening.media.media.startTick + screening.media.media.durationTicks,
  };
  const mapped = mapScreeningMediaRange(screening, mediaRange);
  assert.ok(mapped);
  return {
    v: 1,
    kind: 'project-screening',
    id: 'selected-screening',
    title: 'Actual frozen film',
    contentRef: screening.input.contentRef,
    screeningId: screening.id,
    input: screening.input,
    media: {
      contentRef: screening.media.contentRef,
      ownerRevision: screening.media.ownerRevision,
      blobDigest: screening.media.blobDigest,
    },
    selections: [
      {
        id: 'selected-range',
        mediaRange,
        target: {
          kind: 'moment',
          tick: mapped.startTick,
          endTick: mapped.endTick,
          timebase: { numerator: 1, denominator: 30 },
        },
      },
    ],
  };
}

export async function projectReviewHttpFixture() {
  const f = await screeningFixture();
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const thread = threads.create(f.principal.userId, 'Actual review source');
  const notifications: { userId: string; reviewId: string }[] = [];
  const failures: unknown[] = [];
  // Named test-only Cat project grants isolate the audience intersection; this is not a Host takeover grant.
  const projects = new VideoProjectService({
    owner: f.owner,
    ownerUserId: f.principal.userId,
    authorizeCat: async ({ principal }) => {
      if (
        principal.invocationId !== `test:${principal.actor.actorId}` ||
        !['sol', 'astra'].includes(principal.actor.actorId)
      )
        throw new Error('Unverified test Cat');
    },
  });
  const screenings = f.make(f.owner, projects);
  const { screening } = await screenings.register(f.request);
  const authority: VideoProjectMessageAuthority = {
    messages,
    authorizeSource: async ({ principal, threadId, messageId }) => {
      const current = threads.get(threadId);
      if (!current || current.createdBy !== principal.userId || current.deletedAt)
        throw new WorkspaceContentReviewError('access_denied');
      if (messageId) {
        const source = messages.getById(messageId);
        if (!source || source.userId !== principal.userId || source.threadId !== threadId)
          throw new WorkspaceContentReviewError('access_denied');
      }
    },
  };
  const storePath = join(f.dataDir, 'artifact-reviews.sqlite');
  let store = new ArtifactReviewStore(storePath);
  let importer = new VideoProjectMessageImporter({ store: store.ledgers, projects, screenings, authority });
  let session: string | null = f.principal.userId;
  const createApp = () => {
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      if (session) request.sessionUserId = session;
    });
    registerVideoProjectReviewRoutes(app, importer);
    return app;
  };
  let app = createApp();
  const changed = (userId: string, reviewId: string) => notifications.push({ userId, reviewId });
  const append = (extra: Partial<AppendMessageInput> = {}) =>
    messages.append({
      userId: f.principal.userId,
      from: { kind: 'user', userId: f.principal.userId },
      content: 'Human disagrees with this actual selected range',
      mentions: [],
      threadId: thread.id,
      timestamp: Date.now(),
      contentBlocks: [{ type: 'context_attachment', attachment: projectOpinionAttachment(screening) }],
      ...extra,
    });
  const deliver = (message: ReturnType<typeof append>) =>
    importStoredProjectMessage(message, createProjectMessageProducer({ importer, changed }), (error) =>
      failures.push(error),
    );
  return {
    ...f,
    projects,
    screenings,
    messages,
    threads,
    thread,
    screening,
    notifications,
    failures,
    append,
    deliver,
    url: `/api/video-projects/${encodeURIComponent(f.request.contentRef)}/review`,
    get app() {
      return app;
    },
    get store() {
      return store;
    },
    get importer() {
      return importer;
    },
    setSession(userId: string | null) {
      session = userId;
    },
    cat(catId: 'sol' | 'astra') {
      return {
        userId: f.principal.userId,
        actor: { kind: 'cat' as const, actorId: catId as CatId },
        invocationId: `test:${catId}`,
      };
    },
    async restart() {
      await app.close();
      store.close();
      store = new ArtifactReviewStore(storePath);
      importer = new VideoProjectMessageImporter({ store: store.ledgers, projects, screenings, authority });
      app = createApp();
    },
    async cleanup() {
      await app.close();
      store.close();
      await f.cleanup();
    },
  };
}
