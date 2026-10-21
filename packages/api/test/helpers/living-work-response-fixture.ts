import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ImmutableMedia, ReviewedMediaAsset } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { ArtifactReviewStore } from '../../src/domains/collaborative-content/artifact-review/store.js';
import { WorkReviewResponseService } from '../../src/domains/collaborative-content/works/review-response.js';
import { LivingWorkService } from '../../src/domains/collaborative-content/works/service.js';
import { ProjectContentOwnerService } from '../../src/domains/video-studio/content-owner/service.js';

export const now = '2026-10-20T20:30:00.000Z';
export const cat = {
  userId: 'operator',
  threadId: 'production',
  actor: { kind: 'cat' as const, actorId: 'director' },
  invocationId: 'active',
};
export const human = {
  userId: 'operator',
  threadId: 'production',
  actor: { kind: 'human' as const, actorId: 'operator' },
};
const sha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}` as const;
const clock: ImmutableMedia = {
  kind: 'video',
  width: 100,
  height: 100,
  codedWidth: 100,
  codedHeight: 100,
  rotation: 0,
  pixelAspectRatio: { numerator: 1, denominator: 1 },
  streamId: '0:0x1',
  streamIndex: 0,
  timebase: { numerator: 1, denominator: 1000 },
  startTick: 0,
  durationTicks: 10000,
  containerStartSeconds: 0,
};
const source = (name: string) => ({ worktreeId: 'authorized', path: `${name}.mp4`, expectedSourceRevision: sha(name) });
export const submission = (name: string) => ({
  operationId: name,
  title: 'One work',
  changeSummary: name,
  source: source(name),
});
export async function workResponseFixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'f326-work-response-'));
  const owner = new ProjectContentOwnerService({ dataDir: root });
  const store = new ArtifactReviewStore(join(root, 'review.sqlite'));
  const injector = new Database(join(root, 'review.sqlite'));
  t.after(async () => {
    injector.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  let allowed = true;
  let opens = 0;
  const responses = new WorkReviewResponseService({
    store,
    owner,
    now: () => now,
    authorize: async ({ permission }) => {
      if (permission === 'respond' && !allowed) throw new Error('revoked original request');
    },
    readAsset: async (_review, revision) => readAsset(revision),
  });
  const service = new LivingWorkService({
    responses,
    owner,
    versions: store.works,
    authorize: async () => {
      if (!allowed) throw new Error('revoked production caller');
    },
    source: {
      inspect: async () => ({ source: source('v4'), mediaType: 'video/mp4', media: clock, byteLength: 2 }),
      open: async ({ source: input }) => {
        opens++;
        const name = input.path.replace('.mp4', '');
        return {
          stream: Readable.from([Buffer.from(name)]),
          byteLength: Buffer.byteLength(name),
          blobDigest: sha(name),
          mediaType: 'video/mp4' as const,
          media: { ...clock, durationTicks: name === 'v4' ? 5000 : 10000 },
          publication: {
            artifactRef: input.path,
            sourceRef: `workspace:authorized:${input.path}`,
            revision: input.expectedSourceRevision,
          },
          revalidate: async () => undefined,
        };
      },
    },
  });
  const first = await service.commit({ action: 'create', ...submission('v1') }, cat);
  const readAsset = async (ownerRevision: number): Promise<ReviewedMediaAsset> => {
    const description = await owner.describe(first.reference.contentRef, ownerRevision);
    const receipt = (await owner.listOutbox(first.reference.contentRef)).find(
      (item) => item.ownerRevision === ownerRevision,
    )!;
    return {
      contentRef: first.reference.contentRef,
      ownerRevision,
      blobDigest: description.blobDigest,
      mediaType: 'video/mp4',
      media: { ...clock, durationTicks: ownerRevision === 4 ? 5000 : 10000 },
      sourcePublication: description.sourcePublication!,
      ownerReceiptRef: receipt.receiptId,
    };
  };
  store.create(
    {
      version: 1,
      reviewId: 'review',
      revision: 1,
      title: 'Original opinions',
      contentRef: first.reference.contentRef,
      task: { taskId: 'original-task', threadId: 'production', ownerUserId: 'operator', observedRevision: 1 },
      createdAt: now,
      updatedAt: now,
      rounds: [
        {
          number: 1,
          asset: await readAsset(1),
          openedAt: now,
          state: 'changes_requested',
          responses: [],
          annotations: [
            {
              id: 'opinion',
              body: 'shorten',
              author: human.actor,
              createdAt: now,
              updatedAt: now,
              replies: [],
              state: 'open',
              anchor: { kind: 'video-range', streamId: '0:0x1', startTick: 8000, endTick: 9000 },
            },
          ],
        },
      ],
    },
    { operationId: 'prepare', actor: human.actor, now },
  );
  for (const version of [2, 3])
    await service.commit(
      {
        action: 'submit',
        contentRef: first.reference.contentRef,
        expectedOwnerRevision: version - 1,
        ...submission(`v${version}`),
      },
      cat,
    );
  const command = {
    action: 'submit' as const,
    contentRef: first.reference.contentRef,
    expectedOwnerRevision: 3,
    ...submission('v4'),
    reviewResponse: {
      reviewId: 'review',
      sourceRound: 1,
      expectedReviewRevision: 1,
      expectedTaskRevision: 1,
      responses: [
        {
          annotationId: 'opinion',
          disposition: 'addressed' as const,
          explanation: 'shortened in v4',
          resultAnchor: { kind: 'video-range' as const, streamId: '0:0x1', startTick: 2000, endTick: 3000 },
        },
      ],
    },
  };
  return {
    owner,
    store,
    injector,
    service,
    responses,
    command,
    readAsset,
    opens: () => opens,
    revoke: () => {
      allowed = false;
    },
  };
}
