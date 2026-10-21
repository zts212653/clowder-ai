import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CollectiveArtifactCustodyTransfer, collectiveCustodyTransferSchema } from '@cat-cafe/shared';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { CollectiveMarkdownOwner } from '../src/domains/collaborative-content/collective-artifact/markdown-owner.js';
import type { CollectiveCustodyOwnerAuthority } from '../src/domains/collaborative-content/collective-artifact/owner-port.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { baseConstraint, digest, type fixture, scope, text } from './collective-markdown.fixture.js';

export async function custodyModification(f: Awaited<ReturnType<typeof fixture>>, eventId: string) {
  const annotated = await f.execute(
    { ...baseConstraint, action: 'annotate' },
    {
      kind: 'annotate',
      messageEventId: `${eventId}-note`,
      body: 'Please clarify.',
      quote: 'A unique shared quote.',
      location: { channelId: 'general', rootEventId: scope.sourceEventId },
      expectedReviewRevision: 1,
    },
    `${eventId}-annotate`,
  );
  if (annotated.status !== 'ok') throw new Error(f.errors.map(String).join('\n'));
  const requested = await f.execute(
    { ...baseConstraint, action: 'propose' },
    {
      kind: 'request-modification',
      messageEventId: eventId,
      annotationIds: [annotated.value.view.review.annotations[0].id],
      expectedReviewRevision: annotated.value.view.review.revision,
      instruction: 'Clarify the phrase.',
      location: { channelId: 'general', rootEventId: scope.sourceEventId },
      target: { humanId: 'human-bob', catId: 'codex61-sol', connectionId: 'connection-bob', participationRevision: 1 },
    },
    `${eventId}-request`,
  );
  if (requested.status !== 'ok') throw new Error(f.errors.map(String).join('\n'));
  const agent = {
    requestEventId: eventId,
    catId: 'codex61-sol',
    humanId: 'human-bob',
    connectionId: 'connection-bob',
    participationRevision: 1,
    membershipRevision: 1,
    revocationEpoch: 1,
  };
  const command = {
    kind: 'respond-modification',
    requestId: requested.value.request.requestId,
    operationId: '00000000-0000-4000-8000-000000000029',
    expectedOwnerRevision: 1,
    expectedProposalRevision: 0,
    baseRevision: digest,
    response: 'Clarified.',
    edits: [
      { start: text.indexOf('unique'), end: text.indexOf('unique') + 6, expectedText: 'unique', replacement: 'clear' },
    ],
  };
  return { requested, agent, command };
}

export async function emptyCustodyOwner(t: { after(fn: () => Promise<unknown>): void }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'f290-full-custody-target-'));
  const open = () => {
    const owner = new ProjectContentOwnerService({ dataDir });
    const reviews = new WorkspaceContentReviewStore(join(dataDir, 'reviews.sqlite'));
    const modifications = new ArtifactReviewStore(join(dataDir, 'modifications.sqlite'));
    const root = new CollectiveMarkdownOwner({
      owner,
      reviews,
      modifications,
      ownerUserId: 'destination-real-local-owner',
      custodyDataDir: dataDir,
    });
    return { owner, reviews, modifications, root };
  };
  let current = open();
  t.after(async () => {
    current.reviews.close();
    current.modifications.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    get current() {
      return current;
    },
    reopen() {
      current.reviews.close();
      current.modifications.close();
      current = open();
      return current;
    },
  };
}
export async function custodyTransfer(owner: ProjectContentOwnerService): Promise<CollectiveArtifactCustodyTransfer> {
  const last = (await owner.listOutbox(scope.contentRef)).at(-1);
  if (!last) throw new Error('Expected real source receipt');
  return collectiveCustodyTransferSchema.parse({
    v: 1,
    transferId: 'artifact-handoff:actual-owner-transfer',
    serviceInstanceId: scope.serviceInstanceId,
    collectiveId: scope.collectiveId,
    artifactId: scope.artifactId,
    sourceEventId: scope.sourceEventId,
    publishedByHumanId: scope.publishedByHumanId,
    sourceConnectionId: 'connection-alice',
    sourceEndpointId: 'endpoint-alice',
    sourceHumanId: 'human-alice',
    targetConnectionId: 'connection-bob',
    targetEndpointId: 'endpoint-bob',
    targetHumanId: 'human-bob',
    expectedCustodyRevision: 1,
    state: 'offered',
    version: {
      contentRef: scope.contentRef,
      ownerRevision: last.ownerRevision,
      blobDigest: last.blobDigest,
      receiptRef: last.receiptId,
    },
    offeredByHumanId: 'human-alice',
    offerRequestId: 'explicit-handoff-offer',
    createdAt: '2026-10-16T19:00:00.000Z',
    updatedAt: '2026-10-16T19:00:00.000Z',
  });
}
/** Controlled canonical metadata for owner-unit tests. Service/Connector issuer proofs have separate HTTP coverage. */
export function custodyAuthority(
  read: () => CollectiveArtifactCustodyTransfer,
  side: 'source' | 'target',
): CollectiveCustodyOwnerAuthority {
  return {
    authorize: async (operation) => {
      const current = read();
      const admitted =
        operation === 'finalize'
          ? ['committed', 'cancelled'].includes(current.state)
          : operation === 'prepareSource'
            ? side === 'source' && current.state === 'offered'
            : operation === 'readPage'
              ? side === 'source' && ['source_prepared', 'target_ready'].includes(current.state)
              : side === 'target' && current.state === 'source_prepared';
      if (!admitted) throw new Error('Canonical transfer phase refuses this operation');
      return structuredClone(current);
    },
  };
}
