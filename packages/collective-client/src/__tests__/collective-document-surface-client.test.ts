import { collectiveDocumentRequestSchema } from '@cat-cafe/shared';
import { expect, it, vi } from 'vitest';
import type { collectiveArtifactClient } from '../collective-artifact-client.js';
import { serveCollectiveDocumentRequest } from '../collective-document-surface-client.js';
import { annotationView, annotationArtifact as artifact } from './shared-artifact-annotation-pages.fixture.js';

const request = collectiveDocumentRequestSchema.parse({
  type: 'collective:host-document-request',
  requestId: '191d3ccd-24da-4671-a079-fa1c0bc16950',
  ref: {
    bridgeId: 'bridge-id',
    contextId: 'context-id',
    contextRevision: 1,
    serviceInstanceId: 'service',
    collectiveId: 'collective',
    connectionId: 'connection',
    humanId: 'human',
    channelId: 'general',
    artifactId: artifact.artifactId,
    sourceEventId: artifact.sourceEventId,
    ownerRevision: 1,
  },
  operation: { kind: 'read', ownerRevision: 1 },
});

it('reads exact owner bytes through the existing authorized reader, and denies a missing/revoked source without a read', async () => {
  const read = vi.fn(async () => annotationView());
  let available = true;
  const api = { list: async () => (available ? [artifact] : []), read } as unknown as ReturnType<
    typeof collectiveArtifactClient
  >;
  expect(await serveCollectiveDocumentRequest(request, api)).toMatchObject({
    kind: 'read',
    title: artifact.title,
    value: { text: '# 同一份作品', ownerRevision: 1 },
  });
  expect(read).toHaveBeenCalledWith(artifact, 1);
  available = false;
  read.mockClear();
  expect(await serveCollectiveDocumentRequest(request, api)).toEqual({ kind: 'error', code: 'access_denied' });
  expect(read).not.toHaveBeenCalled();
});

it('rejects unrelated version and source tuples before any owner bytes can leave', async () => {
  const read = vi.fn(async () => annotationView());
  const api = { list: async () => [artifact], read } as unknown as ReturnType<typeof collectiveArtifactClient>;
  expect(
    await serveCollectiveDocumentRequest({ ...request, operation: { kind: 'read', ownerRevision: 99 } }, api),
  ).toEqual({ kind: 'error', code: 'access_denied' });
  expect(
    await serveCollectiveDocumentRequest({ ...request, ref: { ...request.ref, sourceEventId: 'different' } }, api),
  ).toEqual({ kind: 'error', code: 'access_denied' });
  expect(read).not.toHaveBeenCalled();
});
