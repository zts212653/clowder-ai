import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CollectiveArtifactConstraint, WorkspaceContentReview } from '@cat-cafe/shared';
import sharp from 'sharp';
import { CollectivePublishedMediaOwner } from '../src/domains/collaborative-content/collective-artifact/published-media-owner.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { createReviewFixture, reviewHuman } from './helpers/artifact-review-fixture.js';

export async function publishedCollectiveFixture(t: { after(fn: () => Promise<unknown>): void }, mime = 'image/png') {
  const root = await mkdtemp(join(tmpdir(), 'collective-retained-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uploads = join(root, 'uploads');
  await mkdir(uploads);
  const f = createReviewFixture(root, uploads);
  let prepare = f.prepare;
  assert.ok(f.task.current?.entrustedWork);
  const artifactRefs = f.task.current.entrustedWork.artifactRefs;
  if (mime === 'video/mp4') {
    await promisify(execFile)(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=160x96:r=24:d=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        join(uploads, 'clip.mp4'),
      ],
      { timeout: 15000 },
    );
    const source = f.publish('/uploads/clip.mp4', mime);
    artifactRefs.push('/uploads/clip.mp4');
    prepare = { ...prepare, artifactRef: '/uploads/clip.mp4', expectedArtifactRevision: String(source.timestamp) };
  } else {
    await writeFile(
      join(uploads, 'cover.png'),
      await sharp({ create: { width: 160, height: 100, channels: 3, background: 'red' } })
        .png()
        .toBuffer(),
    );
    if (mime === 'image/jpeg') {
      await writeFile(
        join(uploads, 'cover.jpg'),
        await sharp({ create: { width: 160, height: 100, channels: 3, background: 'red' } })
          .jpeg()
          .toBuffer(),
      );
      const source = f.publish('/uploads/cover.jpg', mime);
      artifactRefs.push('/uploads/cover.jpg');
      prepare = { ...prepare, artifactRef: '/uploads/cover.jpg', expectedArtifactRevision: String(source.timestamp) };
    }
  }
  const asset = await f.media.prepare(prepare);
  const bytes = await readFile(
    join(uploads, mime === 'video/mp4' ? 'clip.mp4' : mime === 'image/jpeg' ? 'cover.jpg' : 'cover.png'),
  );
  let reviews = new WorkspaceContentReviewStore(join(root, 'shared.sqlite'));
  t.after(async () => reviews.close());
  let port = new CollectivePublishedMediaOwner({ media: f.media, reviews, ownerUserId: 'operator' });
  const scope = {
    serviceInstanceId: 'service',
    collectiveId: 'collective',
    artifactId: `artifact_${createHash('sha256')
      .update(JSON.stringify(['service', 'collective', asset.contentRef]))
      .digest('hex')}`,
    sourceEventId: 'public-original-source',
    custodyRevision: 1,
  };
  const share = (target = asset, selected = scope) =>
    port.prepareShare({
      contentRef: target.contentRef,
      ownerRevision: target.ownerRevision,
      scope: selected,
      principal: reviewHuman,
    });
  const revoked = new Set<string>();
  const execute = (
    humanId: string,
    action: CollectiveArtifactConstraint['action'] = 'read',
    payload: Record<string, unknown> = {},
    requestId = 'read',
    selected = asset,
    drift: Partial<CollectiveArtifactConstraint> = {},
  ) => {
    const constraint: CollectiveArtifactConstraint = {
      ...scope,
      humanId,
      contentRef: selected.contentRef,
      ownerRevision: selected.ownerRevision,
      blobDigest: selected.blobDigest,
      action,
      membershipRevision: 1,
      revocationEpoch: 1,
      decisionRef: 'test-service-authority',
      expiresAt: Date.now() + 30000,
      ...drift,
    };
    return port.execute(
      { relayRef: 'test-relay', requestId, constraint, payload, expiresAt: constraint.expiresAt },
      {
        reauthorize: async () => {
          if (revoked.has(humanId)) throw new Error('test-authoritative-access-denied');
          return structuredClone(constraint);
        },
      },
    );
  };
  return {
    ...f,
    root,
    uploads,
    asset,
    bytes,
    scope,
    share,
    execute,
    revoked,
    get port() {
      return port;
    },
    get reviews() {
      return reviews;
    },
    reopen() {
      reviews.close();
      reviews = new WorkspaceContentReviewStore(join(root, 'shared.sqlite'));
      port = new CollectivePublishedMediaOwner({ media: f.media, reviews, ownerUserId: 'operator' });
    },
  };
}

export function mediaValue(result: { status: string; value?: Record<string, unknown> }) {
  if (result.status !== 'ok' || !result.value) throw new Error(JSON.stringify(result));
  return result.value as {
    contentRef: string;
    ownerRevision: number;
    blobDigest: string;
    media: import('@cat-cafe/shared').ImmutableMedia;
    view: {
      review: Omit<WorkspaceContentReview, 'ownerUserId'>;
      historyReadOnly: boolean;
      canWrite: boolean;
      canReply: boolean;
    };
    receipt?: { revision: number; actor: { actorId: string } };
    annotationId?: string;
  };
}
