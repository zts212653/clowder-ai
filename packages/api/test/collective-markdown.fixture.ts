import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectiveArtifactConstraint, CollectiveArtifactRelayOperation } from '@cat-cafe/shared';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { CollectiveMarkdownOwner } from '../src/domains/collaborative-content/collective-artifact/markdown-owner.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { collectiveContentScopeRef } from '../src/domains/video-studio/content-owner/collective-scope.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';

export const text = '# Guide\n\nA unique shared quote.\n';
export const digest = `sha256:${createHash('sha256').update(text).digest('hex')}` as const;
export const scope = {
  kind: 'collective-artifact',
  serviceInstanceId: 'service-shared',
  collectiveId: 'collective-shared',
  artifactId: 'artifact-shared',
  contentRef: 'collective-content:shared',
  sourceEventId: 'evt_00000000-0000-4000-8000-000000000001',
  publishedByHumanId: 'human-alice',
} as const;
export const baseConstraint: CollectiveArtifactConstraint = {
  serviceInstanceId: scope.serviceInstanceId,
  collectiveId: scope.collectiveId,
  artifactId: scope.artifactId,
  contentRef: scope.contentRef,
  sourceEventId: scope.sourceEventId,
  action: 'read',
  humanId: 'human-alice',
  ownerRevision: 1,
  blobDigest: digest,
  membershipRevision: 1,
  revocationEpoch: 1,
  custodyRevision: 1,
  decisionRef: 'domain-allow:alice',
  expiresAt: Date.now() + 60000,
};

export async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'f290-markdown-owner-'));
  const owner = new ProjectContentOwnerService({ dataDir });
  const reviews = new WorkspaceContentReviewStore(join(dataDir, 'workspace-reviews.sqlite'));
  const modifications = new ArtifactReviewStore(join(dataDir, 'artifact-reviews.sqlite'));
  t.after(async () => {
    modifications.close();
    reviews.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await owner.importContent({
    contentRef: scope.contentRef,
    collectiveScope: scope,
    bytes: Buffer.from(text),
    mediaType: 'text/markdown',
    actor: { kind: 'human', actorId: 'human-alice' },
    operationId: 'publish-shared',
    authorizeEffect: async () => {},
    operationContext: {
      kind: 'collective-artifact:publish',
      actorHumanId: 'human-alice',
      scopeRef: collectiveContentScopeRef(scope),
      custodyRevision: 1,
      dispositionId: 'publish-shared',
      requestDigest: digest,
    },
  });
  const errors: unknown[] = [];
  const port = new CollectiveMarkdownOwner({
    owner,
    reviews,
    modifications,
    ownerUserId: 'real-local-owner',
    custodyDataDir: dataDir,
    onError: (error) => {
      errors.push(error);
    },
  });
  const execute = (
    constraint: CollectiveArtifactConstraint,
    payload: Record<string, unknown> = {},
    requestId = 'owner-read',
  ) => {
    const operation: CollectiveArtifactRelayOperation = {
      relayRef: 'relay-one',
      requestId,
      constraint,
      payload,
      expiresAt: Date.now() + 10000,
    };
    return port.execute(operation, { reauthorize: async () => constraint });
  };
  return { owner, reviews, modifications, port, execute, errors, dataDir };
}
