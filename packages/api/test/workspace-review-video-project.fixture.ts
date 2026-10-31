import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VideoProjectDocumentV1 } from '@cat-cafe/shared';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { WorkspaceContentReviewError } from '../src/domains/collaborative-content/workspace-review/errors.js';
import { VideoProjectReviewService } from '../src/domains/collaborative-content/workspace-review/video-project-review-service.js';
import type { ContentSettlementReceiptV1 } from '../src/domains/video-studio/content-owner/types.js';
import type { VideoProjectPrincipal } from '../src/domains/video-studio/project/service.js';

export const principal = { userId: 'operator', actor: { kind: 'human' as const, actorId: 'operator' } };
export const cat = {
  userId: 'operator',
  actor: { kind: 'cat' as const, actorId: 'sol' },
  invocationId: 'trusted-invocation',
};
export const contentRef = 'video-project:test';
export const at = '2026-10-08T03:00:00.000Z';
const origin = { kind: 'imported' as const, actor: null, at, refs: ['source:test'] };

export function document(): VideoProjectDocumentV1 {
  return {
    schemaVersion: 1,
    title: 'Test film',
    kind: 'animation',
    tags: [],
    roles: [],
    origin,
    timeline: {
      timebase: { numerator: 1, denominator: 30 },
      durationTicks: 300,
      width: 1920,
      height: 1080,
      scenes: [{ id: 'scene-1', label: 'Scene 1' }],
      segments: [
        {
          id: 'shot-1',
          kind: 'shot',
          label: 'Shot 1',
          sceneId: 'scene-1',
          startTick: 0,
          durationTicks: 100,
          visuals: [{ id: 'visual-1', assetVersionRef: 'image-v1', startTick: 0, endTick: 100 }],
        },
        {
          id: 'shot-2',
          kind: 'shot',
          label: 'Shot 2',
          sceneId: 'scene-1',
          startTick: 100,
          durationTicks: 100,
          visuals: [{ id: 'visual-2', assetVersionRef: 'image-v1', startTick: 0, endTick: 100 }],
        },
      ],
      events: [],
    },
    assets: [
      {
        id: 'image',
        name: 'Artwork',
        kind: 'image',
        versions: [
          {
            id: 'image-v1',
            mediaType: 'image/png',
            byteLength: 12,
            sha256: `sha256:${'a'.repeat(64)}`,
            locator: { kind: 'workspace', rootId: 'registered-root', path: 'one.png' },
            recordedAt: at,
            origin,
            width: 640,
            height: 480,
          },
        ],
      },
    ],
    checkPages: [],
    checkResults: [],
    decisions: [],
  };
}

export const region = {
  coordinateSpace: 'display-pixels' as const,
  width: 1920,
  height: 1080,
  rotation: 0 as const,
  bbox: { x: 100, y: 100, width: 200, height: 150 },
};

export class ProjectAuthority {
  readonly snapshots = new Map<number, VideoProjectDocumentV1>([[1, document()]]);
  readonly receipts = new Map<string, ContentSettlementReceiptV1>();
  head = 1;
  async authorize(input: { principal: VideoProjectPrincipal; contentRef: string; permission: 'read' | 'write' }) {
    if (
      input.contentRef !== contentRef ||
      input.principal.userId !== 'operator' ||
      (input.principal.actor.kind === 'human'
        ? input.principal.actor.actorId !== 'operator'
        : !('invocationId' in input.principal) ||
          input.principal.invocationId !== 'trusted-invocation' ||
          input.principal.actor.actorId !== 'sol')
    )
      throw new WorkspaceContentReviewError('access_denied');
  }
  async load(input: { principal: VideoProjectPrincipal; contentRef: string; ownerRevision?: number }) {
    await this.authorize({ ...input, permission: 'read' });
    const ownerRevision = input.ownerRevision ?? this.head;
    const doc = this.snapshots.get(ownerRevision);
    if (!doc) throw new WorkspaceContentReviewError('not_found');
    return {
      contentRef,
      ownerRevision,
      document: structuredClone(doc),
      blobDigest: `sha256:${createHash('sha256').update(JSON.stringify(doc)).digest('hex')}` as const,
    };
  }
  async operationReceipt(input: { principal: VideoProjectPrincipal; contentRef: string; operationId: string }) {
    await this.authorize({ ...input, permission: 'read' });
    return this.receipts.get(input.operationId);
  }
  async save(doc: VideoProjectDocumentV1, operationId: string) {
    this.head += 1;
    this.snapshots.set(this.head, structuredClone(doc));
    const loaded = await this.load({ principal, contentRef });
    const receipt: ContentSettlementReceiptV1 = {
      receiptId: `receipt:${operationId}`,
      contentRef,
      previousOwnerRevision: this.head - 1,
      ownerRevision: this.head,
      blobDigest: loaded.blobDigest,
      actor: principal.actor,
      operationId,
      outboxSequence: this.head,
    };
    this.receipts.set(operationId, receipt);
    return { contentRef, ownerRevision: this.head, blobDigest: loaded.blobDigest, operationId };
  }
}

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'f326-project-ledger-'));
  const db = join(root, 'artifact-reviews.sqlite');
  let store = new ArtifactReviewStore(db);
  const projects = new ProjectAuthority();
  const service = () => new VideoProjectReviewService({ store: store.ledgers, projects, now: () => at });
  return {
    projects,
    service,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new ArtifactReviewStore(db);
      return service();
    },
    async cleanup() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
