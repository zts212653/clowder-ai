import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import sharp from 'sharp';
import {
  readLiveCompanionWorkCandidates as read,
  resolveLiveCompanionWorkPublication as resolve,
} from '../src/domains/concierge/live/work/live-companion-work.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

test('normal Live source keeps two actual F309 byte versions on their original Task across a fresh reader', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f317-live-work-owner-'));
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
  const options = {
    ownerUserId: 'operator',
    projectPath: root,
    tasks: f.tasks,
    messages: f.messages,
    threads: f.threads,
    artifactLineage: f.globalArtifactWorkLineage,
    assertCurrent: async () => {},
  };
  const scope = { userId: 'operator', catId: createCatId(f.cat.actor.actorId), threadId: f.thread.id };
  const [v1] = await read(options, scope);
  assert.ok(v1);
  assert.equal(v1.destination.artifact?.contentRef, first.contentRef);
  const secondBytes = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#2180d4' } })
    .png()
    .toBuffer();
  await writeFile(join(root, 'second.png'), secondBytes);
  const second = f.publish('second.png');
  await f.owner.settle({
    contentRef: first.contentRef,
    expectedOwnerRevision: 1,
    bytes: secondBytes,
    operationId: 'second-version',
    actor: f.cat.actor,
    sourcePublication: {
      artifactRef: '/uploads/second.png',
      sourceRef: `message:${f.thread.id}:${second.id}`,
      revision: String(second.timestamp),
    },
  });
  const count = (await f.messages.getByThread(f.thread.id)).length;
  const fresh = await read({ ...options }, { ...scope });
  const v2 = fresh.find((row) => row.destination.artifact?.ownerRevision === 2);
  assert.ok(v2);
  assert.equal(v1.revision, fresh.find((row) => row.id === v1.id)?.revision);
  for (const [version, candidate] of [
    [1, v1],
    [2, v2],
  ] as const) {
    const publication = await resolve(options, scope, candidate);
    assert.equal(publication?.artifact?.contentRef, first.contentRef);
    assert.equal(publication?.artifact?.ownerRevision, version);
  }
  const firstBytes = await f.media.read(first.contentRef, 1, f.human);
  const nextBytes = await f.media.read(first.contentRef, 2, f.human);
  assert.notEqual(firstBytes.blobDigest, nextBytes.blobDigest);
  assert.equal(f.tasks.listByThread(f.thread.id).length, 1);
  assert.equal((await f.messages.getByThread(f.thread.id)).length, count);
});
