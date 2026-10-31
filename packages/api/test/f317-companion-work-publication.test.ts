import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { resolveCompanionWorkPublication } from '../src/domains/concierge/live/host/home/companion-work-publication.js';
import { HomeHubDelivery } from '../src/domains/concierge/live/host/home/home-hub-delivery.js';
import { CompanionWorkOverview } from '../src/domains/concierge/live/work/companion-work-overview.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

test('C work.open retains each real F309 version through the original message resolver and owner Hub grant', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f317-home-publication-'));
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
  const clientId = randomUUID();
  let clientToken = '';
  const grants: {
    action: {
      source: { messageId: string; expectedUrl: string };
      artifact: { contentRef: string; ownerRevision: number };
    };
  }[] = [];
  const hub = new HomeHubDelivery({
    messages: f.messages,
    threads: f.threads,
    isCurrent: async () => true,
    emitter: {
      emit: () => {},
      emitWithAck: async (_owner, event, data) => {
        if (event === 'home:inspect')
          return [{ clientId, clientToken, route: '/', threadId: f.thread.id, composer: false, sections: [] }];
        const token = (data as { token: string }).token;
        const grant = await hub.consume('operator', token, clientId, clientToken);
        grants.push(grant as (typeof grants)[number]);
        return [{ token, clientId, clientToken, status: 'unconfirmed' }];
      },
    },
  });
  clientToken = hub.registerClient('operator', clientId).clientToken;
  const overview = new CompanionWorkOverview({
    ...options,
    open: (destination) =>
      hub.openWork('operator', () => resolveCompanionWorkPublication(options, destination), options.assertCurrent),
  });
  const originalRef = (await overview.read()).recentDeliveries[0]?.entryRef;
  assert.ok(originalRef);
  const nextPng = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#2180d4' } })
    .png()
    .toBuffer();
  await writeFile(join(root, 'second.png'), nextPng);
  const second = f.publish('second.png');
  await f.owner.settle({
    contentRef: first.contentRef,
    expectedOwnerRevision: 1,
    bytes: nextPng,
    operationId: 'second-version',
    actor: f.cat.actor,
    sourcePublication: {
      artifactRef: '/uploads/second.png',
      sourceRef: `message:${f.thread.id}:${second.id}`,
      revision: String(second.timestamp),
    },
  });
  const secondRef = (await overview.read()).recentDeliveries.find((row) => row.artifact?.version === '2')?.entryRef;
  assert.ok(secondRef);
  const count = (await f.messages.getByThread(f.thread.id)).length;
  assert.equal(await overview.open(originalRef), 'unconfirmed');
  assert.equal(await overview.open(secondRef), 'unconfirmed');
  assert.deepEqual(
    grants.map((grant) => grant.action.artifact),
    [
      { contentRef: first.contentRef, ownerRevision: 1 },
      { contentRef: first.contentRef, ownerRevision: 2 },
    ],
  );
  assert.notEqual(grants[0].action.source.messageId, grants[1].action.source.messageId);
  assert.equal(grants[1].action.source.expectedUrl, '/uploads/second.png');
  assert.equal(
    (await f.messages.getByThread(f.thread.id)).length,
    count,
    'opening must not send or write a new message',
  );
  assert.equal(f.tasks.listByThread(f.thread.id).length, 1);
  assert.notEqual(
    (await f.media.read(first.contentRef, 1, f.human)).blobDigest,
    (await f.media.read(first.contentRef, 2, f.human)).blobDigest,
  );
  hub.close();
});
