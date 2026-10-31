import assert from 'node:assert/strict';
import {
  deriveGrowingSourceMessageRevision,
  MessageStore,
} from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { VideoProjectReviewService } from '../src/domains/collaborative-content/workspace-review/video-project-review-service.js';
import { at, cat, contentRef, fixture, principal } from './workspace-review-video-project.fixture.js';

export async function setup(recipients: string[] = ['astra']) {
  const f = await fixture();
  const messages = new MessageStore();
  const source = messages.append({
    userId: 'operator',
    from: { kind: 'user', userId: 'operator' },
    content: 'A private issue',
    mentions: [],
    threadId: 'thread-1',
    visibility: 'whisper',
    whisperTo: recipients as (typeof cat.actor.actorId)[],
    timestamp: Date.now(),
  });
  const messageAuthority = { messages, authorizeSource: async () => {} };
  const service = new VideoProjectReviewService({ store: f.store.ledgers, projects: f.projects, messageAuthority });
  const opened = await service.prepare({ principal, contentRef, operationId: 'prepare' });
  const marked = await service.annotate({
    principal,
    reviewId: opened.review.reviewId,
    expectedRevision: 1,
    operationId: 'mark',
    body: source.content,
    target: { kind: 'project' },
  });
  const annotation = marked.review.annotations[0];
  assert.ok(annotation);
  const frozen = await f.projects.load({ principal, contentRef });
  f.store.ledgers.mutate(
    {
      reviewId: opened.review.reviewId,
      expectedRevision: 2,
      operationId: 'seed-import-facts',
      actor: principal.actor,
      kind: 'test-seed-source',
      now: at,
      request: {},
    },
    (review) => ({
      ...review,
      revision: 3,
      annotations: review.annotations.map((item) => ({
        ...item,
        projectMessage: {
          source: {
            threadId: source.threadId,
            messageId: source.id,
            messageRevision: deriveGrowingSourceMessageRevision(source),
            attachmentId: 'attachment-1',
            selectionId: 'selection-1',
            visibility: 'whisper',
            whisperTo: recipients,
          },
          screeningId: 'screening-1',
          input: { contentRef, ownerRevision: 1, blobDigest: frozen.blobDigest },
          media: { contentRef: 'media-1', ownerRevision: 1, blobDigest: frozen.blobDigest },
          selection: { id: 'selection-1', mediaRange: { startPts: 0, endPts: 1 }, target: { kind: 'project' } },
        },
      })),
    }),
  );
  return {
    ...f,
    get store() {
      return f.store;
    },
    service,
    messages,
    source,
    reviewId: opened.review.reviewId,
    annotationId: annotation.id,
  };
}
