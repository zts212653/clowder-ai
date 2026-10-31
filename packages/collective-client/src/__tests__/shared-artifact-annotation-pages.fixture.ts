import { createHash } from 'node:crypto';
import type { SharedArtifact, SharedMarkdownView } from '../collective-artifact-client.js';

const text = '# 同一份作品';
const blobDigest = `sha256:${createHash('sha256').update(text).digest('hex')}`;
const at = '2026-10-16T00:00:00Z';
export const annotationArtifact: SharedArtifact = {
  serviceInstanceId: 'service',
  collectiveId: 'collective',
  artifactId: 'artifact',
  contentRef: 'content',
  publishedByHumanId: 'publisher',
  title: '作品',
  mediaType: 'text/markdown',
  sourceEventId: 'source',
  sourceLocation: { channelId: 'general' },
  revision: 1,
  accessRevision: 1,
  canApply: false,
  availability: 'available',
  versionCount: 1,
  versions: [{ ownerRevision: 1, blobDigest, receiptRef: 'receipt', recordedAt: at }],
  createdAt: at,
  updatedAt: at,
};
export function annotationView(offset = 0): SharedMarkdownView {
  const annotations = [0, 1, 2].slice(offset, offset + 2).map((index) => ({
    id: `annotation-${index}`,
    body: `批注意见 ${index}`,
    author: { kind: 'human' as const, actorId: 'publisher' },
    state: 'open' as const,
    createdAt: at,
    updatedAt: at,
    replies: [],
    anchor: {
      kind: 'text_quote' as const,
      baseRevision: blobDigest,
      start: 0,
      end: 1,
      quote: '#',
      quoteDigest: `sha256:${'a'.repeat(64)}`,
      contextDigest: `sha256:${'b'.repeat(64)}`,
    },
  }));
  const source = {
    kind: 'collective-artifact' as const,
    revision: blobDigest,
    ownerRevision: 1,
    mime: 'text/markdown' as const,
    byteLength: Buffer.byteLength(text),
  };
  return {
    text,
    contentRef: 'content',
    ownerRevision: 1,
    blobDigest,
    view: {
      review: {
        version: 1,
        reviewId: 'review',
        contentRef: 'content',
        revision: 1,
        source,
        collaborationScope: {
          kind: 'collective-artifact',
          scopeRef: 'scope',
          serviceInstanceId: 'service',
          collectiveId: 'collective',
          artifactId: 'artifact',
        },
        annotations,
        sourceHistory: [source],
        createdAt: at,
        updatedAt: at,
      },
      historyReadOnly: false,
      canWrite: false,
      canReply: false,
      annotationPage: { offset, total: 3, ...(offset === 0 ? { nextOffset: 2 } : {}) },
      replyPages: annotations.map((annotation) => ({ annotationId: annotation.id, offset: 0, total: 0 })),
      annotationResolutions: annotations.map((annotation) => ({ annotationId: annotation.id, status: 'attached' })),
    },
  };
}
