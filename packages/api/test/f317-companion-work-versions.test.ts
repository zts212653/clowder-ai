import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { CompanionWorkOverview } from '../src/domains/concierge/live/work/companion-work-overview.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

test('a real Artifact owner retains two versions under one work across independent overview instances', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f317-work-versions-'));
  const png = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#f5b942' } })
    .png()
    .toBuffer();
  await writeFile(join(root, 'review-input.png'), png);
  const f = await createLiveReviewFixture(root);
  t.after(async () => {
    await f.dispatch.close();
    f.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const first = await f.media.prepare({ ...f.prepare, principal: f.human });
  const opened: { artifact?: { contentRef: string; ownerRevision: number } }[] = [];
  const options = {
    ownerUserId: 'operator',
    artifactLineage: f.globalArtifactWorkLineage,
    projectPath: root,
    tasks: f.tasks,
    messages: f.messages,
    threads: f.threads,
    assertCurrent: async () => {},
  };
  const overview = new CompanionWorkOverview({
    ...options,
    open: async (destination) => {
      opened.push(destination);
      return 'unconfirmed';
    },
  });
  const firstRef = (await overview.read()).recentDeliveries[0]?.entryRef;
  assert.ok(firstRef);
  const secondPng = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#2180d4' } })
    .png()
    .toBuffer();
  await writeFile(join(root, 'version-2.png'), secondPng);
  const nextMessage = f.publish('version-2.png');
  await f.owner.settle({
    contentRef: first.contentRef,
    expectedOwnerRevision: 1,
    bytes: secondPng,
    operationId: 'second-version',
    actor: f.cat.actor,
    sourcePublication: {
      artifactRef: '/uploads/version-2.png',
      sourceRef: `message:${f.thread.id}:${nextMessage.id}`,
      revision: String(nextMessage.timestamp),
    },
  });
  assert.equal(await overview.open(firstRef), 'unconfirmed', 'publishing v2 must not revoke the still-readable v1');
  assert.deepEqual(opened[0]?.artifact, { contentRef: first.contentRef, ownerRevision: 1 });
  const view = await overview.read();
  assert.equal(view.recentDeliveries.find((row) => row.artifact?.version === '1')?.entryRef, firstRef);
  assert.deepEqual(view.recentDeliveries.map((row) => row.artifact?.version).sort(), ['1', '2']);
  assert.ok(view.recentDeliveries.every((row) => row.artifact?.artifactId === first.contentRef));
  assert.ok(
    view.recentDeliveries.every((row) => row.taskId === f.taskId),
    'both owner versions must retain their original Task link',
  );
  assert.equal(
    view.recentDeliveries.find((row) => row.artifact?.version === '1')?.artifact?.versionState,
    'superseded',
  );
  assert.equal(view.recentDeliveries.find((row) => row.artifact?.version === '2')?.artifact?.versionState, 'current');
  const reopened = await new CompanionWorkOverview(options).read();
  assert.equal(reopened.active[0]?.taskId, f.taskId);
  assert.deepEqual(
    reopened.recentDeliveries.map((row) => row.sourceRef),
    view.recentDeliveries.map((row) => row.sourceRef),
  );
  const v1 = await f.media.read(first.contentRef, 1, f.human);
  const v2 = await f.media.read(first.contentRef, 2, f.human);
  assert.equal(v1.ownerRevision, 1);
  assert.equal(v2.ownerRevision, 2);
  assert.notEqual(v1.blobDigest, v2.blobDigest, 'the second version contains the actual changed artifact bytes');
  assert.equal(f.tasks.listByThread(f.thread.id).length, 1, 'projection/reentry must not mint another Task');
});
