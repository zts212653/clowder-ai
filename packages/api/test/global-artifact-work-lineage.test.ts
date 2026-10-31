import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GlobalArtifactDTO, MessageMediaPublicationSource, ReviewedMediaAsset } from '@cat-cafe/shared';
import { GlobalArtifactWorkLineageResolver } from '../src/domains/video-studio/content-owner/global-artifact-work-lineage.js';
import { MediaOwnerError } from '../src/domains/video-studio/content-owner/media-errors.js';

const OWNER_USER_ID = 'alice';
const THREAD_ID = 'thread-lineage';
const DIGEST = `sha256:${'a'.repeat(64)}` as const;
type Candidate = { contentRef: string; ownerRevision: number; sourceRevision: string };
const CANDIDATES_BY_MESSAGE_ID: Readonly<Record<string, readonly Candidate[]>> = {
  choice: [
    { contentRef: 'work-choice-a', ownerRevision: 1, sourceRevision: 'exact:choice' },
    { contentRef: 'work-choice-b', ownerRevision: 1, sourceRevision: 'exact:choice' },
  ],
  legacy: [{ contentRef: 'work-legacy', ownerRevision: 1, sourceRevision: '100' }],
  'version-1': [{ contentRef: 'work-versioned', ownerRevision: 1, sourceRevision: 'exact:version-1' }],
  'version-2': [{ contentRef: 'work-versioned', ownerRevision: 2, sourceRevision: 'exact:version-2' }],
  revoked: [{ contentRef: 'work-revoked', ownerRevision: 1, sourceRevision: 'exact:revoked' }],
  exact: [{ contentRef: 'work-exact', ownerRevision: 1, sourceRevision: 'exact:exact' }],
};

function artifact(messageId: string, overrides: Partial<GlobalArtifactDTO> = {}): GlobalArtifactDTO {
  return {
    type: 'image',
    name: `${messageId}.png`,
    catId: 'codex-sol',
    createdAt: 100,
    sourceMessageId: messageId,
    url: `/uploads/${messageId}.png`,
    publicationItem: { kind: 'media-gallery', blockId: messageId, itemIndex: 0 },
    threadId: THREAD_ID,
    threadTitle: 'Lineage',
    ...overrides,
  };
}

function publication(source: MessageMediaPublicationSource) {
  return {
    artifactRef: source.expectedUrl,
    sourceRef: `message:${source.threadId}:${source.messageId}`,
    revision: `exact:${source.messageId}`,
  };
}

function asset(contentRef: string, ownerRevision: number, sourceRevision: string): ReviewedMediaAsset {
  return {
    contentRef,
    ownerRevision,
    blobDigest: DIGEST,
    mediaType: 'image/png',
    media: { kind: 'image', width: 1, height: 1 },
    sourcePublication: {
      artifactRef: `/uploads/${contentRef}.png`,
      sourceRef: `message:${THREAD_ID}:source`,
      revision: sourceRevision,
    },
    ownerReceiptRef: `receipt-${contentRef}-${ownerRevision}`,
  };
}

function fixture() {
  let batchCalls = 0;
  let identityCalls = 0;
  const currentRevision = new Map<string, number>([
    ['work-exact', 1],
    ['work-choice-a', 1],
    ['work-choice-b', 1],
    ['work-legacy', 1],
    ['work-revoked', 1],
    ['work-versioned', 2],
  ]);
  const owner = {
    async findSourcePublicationsBatch(
      lookups: readonly {
        lookupId: string;
        sourceRef: string;
        artifactRef: string;
        revisions: readonly string[];
      }[],
    ) {
      batchCalls += 1;
      const matches = new Map<string, { contentRef: string; ownerRevision: number; sourceRevision: string }[]>();
      for (const lookup of lookups) {
        const messageId = lookup.sourceRef.split(':').at(-1);
        if (!messageId) throw new Error('lookup sourceRef is missing a message id');
        const candidates = CANDIDATES_BY_MESSAGE_ID[messageId];
        if (candidates)
          matches.set(
            lookup.lookupId,
            candidates.map((candidate) => ({ ...candidate })),
          );
      }
      return matches;
    },
    async describe(contentRef: string, ownerRevision: number) {
      return {
        contentRef,
        ownerRevision,
        currentOwnerRevision: currentRevision.get(contentRef) ?? ownerRevision,
        blobDigest: DIGEST,
        mediaType: 'image/png',
        publicationScope: {
          kind: 'message' as const,
          ownerUserId: OWNER_USER_ID,
          threadId: THREAD_ID,
          source: {
            kind: 'message' as const,
            threadId: THREAD_ID,
            messageId: 'source',
            messageRevision: '100',
            expectedUrl: `/uploads/${contentRef}.png`,
            item: { kind: 'media-gallery' as const, blockId: 'source', itemIndex: 0 },
          },
        },
        sourcePublication: {
          artifactRef: `/uploads/${contentRef}.png`,
          sourceRef: `message:${THREAD_ID}:source`,
          revision: `owner:${ownerRevision}`,
        },
      };
    },
  };
  const access = {
    async authorizeThread() {},
    async authorize() {
      throw new Error('message-scoped publication must not request a Task');
    },
    async threadTitle() {
      return 'Lineage';
    },
  };
  const sources = {
    async messageIdentity(source: MessageMediaPublicationSource) {
      identityCalls += 1;
      return {
        matchingItemCount: source.messageId === 'legacy' ? 2 : 1,
        fileName: `${source.messageId}.png`,
        publisherCatId: 'codex-sol',
        mediaType: 'image/png' as const,
        publication: publication(source),
      };
    },
  };
  const media = {
    async currentRevision(contentRef: string) {
      return currentRevision.get(contentRef) ?? 1;
    },
    async read(contentRef: string, ownerRevision: number) {
      if (contentRef === 'work-revoked') throw new MediaOwnerError('access_denied');
      return asset(contentRef, ownerRevision, `owner:${ownerRevision}`);
    },
  };
  const resolver = new GlobalArtifactWorkLineageResolver({ owner, access, sources, media });
  return {
    resolver,
    batchCalls: () => batchCalls,
    identityCalls: () => identityCalls,
  };
}

test('global artifact lineage projects only unique exact authorized landings in one owner scan', async () => {
  const f = fixture();
  const artifacts = [
    artifact('exact'),
    artifact('choice'),
    artifact('legacy'),
    artifact('revoked'),
    artifact('version-1'),
    artifact('version-2', { createdAt: 101 }),
    artifact('human', { catId: null }),
    artifact('ledger', { fileLedgerRef: 'docs/ledger.md' }),
    artifact('code', { type: 'code' }),
    artifact('audio', { type: 'audio' }),
  ];

  const works = await f.resolver.resolve({ ownerUserId: OWNER_USER_ID, artifacts });

  assert.equal(f.batchCalls(), 1, 'the owner manifest catalogue must be scanned once for the whole batch');
  assert.equal(f.identityCalls(), 12, 'six admitted items are identity-checked before and after owner lookup');
  assert.deepEqual(works[0], {
    contentRef: 'work-exact',
    ownerRevision: 1,
    currentOwnerRevision: 1,
  });
  assert.equal(works[1], undefined, 'multiple exact publications require a choice');
  assert.equal(works[2], undefined, 'legacy-ambiguous publication is not projected');
  assert.equal(works[3], undefined, 'revoked publication is not projected');
  assert.deepEqual(works[4], {
    contentRef: 'work-versioned',
    ownerRevision: 1,
    currentOwnerRevision: 2,
  });
  assert.deepEqual(works[5], {
    contentRef: 'work-versioned',
    ownerRevision: 2,
    currentOwnerRevision: 2,
  });
  assert.deepEqual(works.slice(6), [undefined, undefined, undefined, undefined]);
});

test('an incomplete owner catalogue read rejects the whole projection instead of returning partial lineage', async () => {
  let batchCalls = 0;
  const broken = new GlobalArtifactWorkLineageResolver({
    owner: {
      findSourcePublicationsBatch: async () => {
        batchCalls += 1;
        throw new Error('EIO while reading owner manifest');
      },
      describe: async () => {
        throw new Error('unreachable');
      },
    },
    access: {
      authorizeThread: async () => {},
      authorize: async () => {
        throw new Error('unreachable');
      },
      threadTitle: async () => 'Lineage',
    },
    sources: {
      messageIdentity: async (source: MessageMediaPublicationSource) => ({
        matchingItemCount: 1,
        fileName: 'exact.png',
        publisherCatId: 'codex-sol',
        mediaType: 'image/png' as const,
        publication: publication(source),
      }),
    },
    media: {
      currentRevision: async () => {
        throw new Error('unreachable');
      },
      read: async () => {
        throw new Error('unreachable');
      },
    },
  });

  await assert.rejects(
    broken.resolve({ ownerUserId: OWNER_USER_ID, artifacts: [artifact('exact')] }),
    /EIO while reading owner manifest/,
  );
  assert.equal(batchCalls, 1);
});
