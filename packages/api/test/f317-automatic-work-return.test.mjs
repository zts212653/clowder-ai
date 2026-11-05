import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { LiveRecoveryReader } from '../src/domains/concierge/live/recovery/LiveRecoveryReader.ts';
import { readCompanionWork } from '../src/domains/concierge/live/work/companion-work-read.ts';
import { F232PreparedArtifactReader } from '../src/domains/growing/F232PreparedArtifactReader.ts';
import { GlobalArtifactWorkLineageResolver } from '../src/domains/video-studio/content-owner/global-artifact-work-lineage.ts';
import { PublishedMediaAccess } from '../src/domains/video-studio/content-owner/published-media-access.ts';
import { PublishedMediaService } from '../src/domains/video-studio/content-owner/published-media-service.ts';
import { PublishedMediaSource } from '../src/domains/video-studio/content-owner/published-media-source.ts';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.ts';
import { automaticReturnFixture, eventually } from './helpers/f317-automatic-return-fixture.mjs';
import { workFixture } from './helpers/f317-companion-work-fixture.mjs';

test('normal callback dispatch automatically starts the partner and returns both revisions while Live keeps its slot', async (t) => {
  const f = await workFixture(t);
  const taskId = await f.admit();
  const root = await mkdtemp(join(tmpdir(), 'f317-automatic-return-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = new ProjectContentOwnerService({ dataDir: root });
  const access = new PublishedMediaAccess({ tasks: f.tasks, threads: f.threads });
  const sources = new PublishedMediaSource({
    access,
    artifacts: new F232PreparedArtifactReader({ messages: f.messages }),
    messages: f.messages,
    uploadDir: root,
  });
  const media = new PublishedMediaService({ owner, access, sources });
  f.options.artifactLineage = new GlobalArtifactWorkLineageResolver({ owner, access, sources, media });
  const principal = { userId: 'owner', threadId: f.thread.id, actor: { kind: 'cat', actorId: 'codex-sol' } };
  let firstAsset;
  const release = Promise.withResolvers();
  let returned;
  let version = 0;
  const h = await automaticReturnFixture(t, f, async ({ auth, post, read }) => {
    version++;
    if (version === 1) await release.promise;
    const name = `checklist-v${version}.png`;
    const bytes = await sharp({
      create: { width: 4, height: 3, channels: 3, background: version === 1 ? '#f5b942' : '#2180d4' },
    })
      .png()
      .toBuffer();
    await writeFile(join(root, name), bytes);
    const rich = {
      v: 1,
      blocks: [{ kind: 'media_gallery', v: 1, id: name, items: [{ url: `/uploads/${name}`, alt: `第${version}版` }] }],
    };
    await read(auth);
    const published = await post(
      auth,
      `同一工作 task:work:${taskId} 的第${version}版。\n\`\`\`cc_rich\n${JSON.stringify(rich)}\n\`\`\``,
      [],
    );
    await f.lifecycle.update({
      taskId,
      expectedRevision: f.tasks.get(taskId).entrustedWork.revision,
      artifactRefs: [...f.tasks.get(taskId).entrustedWork.artifactRefs, `/uploads/${name}`],
      progress: { summary: `第${version}版已发布`, sourceRef: `message:${published.messageId}` },
    });
    const publication = f.messages.getById(published.messageId);
    if (version === 1) {
      firstAsset = await media.prepare({
        taskId,
        expectedTaskRevision: f.tasks.get(taskId).entrustedWork.revision,
        artifactRef: `/uploads/${name}`,
        expectedArtifactRevision: String(publication.timestamp),
        operationId: 'prepare-first-return',
        principal,
      });
    } else {
      await owner.settle({
        contentRef: firstAsset.contentRef,
        expectedOwnerRevision: 1,
        bytes,
        operationId: 'second-return',
        actor: principal.actor,
        sourcePublication: {
          artifactRef: `/uploads/${name}`,
          sourceRef: `message:${f.thread.id}:${publication.id}`,
          revision: String(publication.timestamp),
        },
      });
    }
    returned = await post(
      auth,
      `@codex-astra\n同一工作 task:work:${taskId} 的第${version}版已发布，来源 ${f.thread.id}#${published.messageId}。`,
      ['codex-astra'],
    );
  });
  t.after(() => release.resolve());
  const dispatch = await h.post(h.live, `@codex-sol\n请完成这件已托付工作 task:work:${taskId}：回家清单。`, [
    'codex-sol',
  ]);
  await eventually(() => h.starts.length === 1, 'normal post_message must wake the real QueueProcessor');
  assert.equal(h.starts[0].messageId, dispatch.messageId);
  assert.equal(h.tracker.has(f.thread.id, 'codex-astra'), true);
  assert.equal(h.tracker.has(f.thread.id, 'codex-sol'), true);
  const working = await readCompanionWork(f.options);
  assert.equal(working.work.items[0].taskId, taskId);
  assert.equal(h.appends.length, 0);
  release.resolve();
  await eventually(() => returned, 'the partner persists its publication through post_message');
  await eventually(
    () => h.appends.length === 1,
    () => JSON.stringify({ errors: h.errors, queue: h.queue.list(f.thread.id, 'owner') }),
  );
  assert.ok(h.appends[0].text.includes('第1版'), 'actual full input is appended, with no read-notice turn');
  assert.doesNotMatch(h.appends[0].text, /freshness notice|readIntent/);
  const first = await h.read(h.live);
  assert.ok(first.messages.some((message) => message.id === returned.messageId && message.content.includes('第1版')));
  await eventually(() => !h.tracker.has(f.thread.id, 'codex-sol'), 'first partner execution must finish');
  const firstReturn = returned.messageId;
  await h.post(h.live, `@codex-sol\n继续同一工作 task:work:${taskId}，第二版加入雨伞。`, ['codex-sol']);
  await eventually(() => h.appends.length === 2, 'the second return must also arrive automatically');
  assert.equal(h.starts.length, 2);
  assert.ok(h.starts[1].content.includes(taskId));
  assert.notEqual(returned.messageId, firstReturn);
  const second = await h.read(h.live);
  assert.ok(second.messages.some((message) => message.id === returned.messageId && message.content.includes('第2版')));
  await eventually(() => !h.tracker.has(f.thread.id, 'codex-sol'), 'second partner execution must finish');
  assert.deepEqual(h.errors, []);
  const reentered = await new LiveRecoveryReader({
    tasks: f.tasks,
    messages: f.messages,
    inbox: h.source,
    epochs: { get: async () => null },
    approvals: { listSettled: async () => [] },
    authorize: async () => true,
  }).read(
    { ...h.scope, callId: 'reentered-call', invocationId: 'reentered-invocation' },
    { signal: new AbortController().signal },
  );
  assert.equal(reentered.tasks.items[0].taskId, taskId);
  const work = await readCompanionWork(f.options);
  assert.equal(work.deliveries.items.length, 2);
  assert.ok(work.deliveries.items.every((row) => row.taskRef === `task:work:${taskId}`));
  assert.deepEqual(work.deliveries.items.map((row) => row.version.ownerRevision).sort(), [1, 2]);
  assert.ok(work.deliveries.items.every((row) => row.version.contentRef === firstAsset.contentRef));
  const original = await media.read(firstAsset.contentRef, 1, principal);
  const changed = await media.read(firstAsset.contentRef, 2, principal);
  assert.notEqual(original.blobDigest, changed.blobDigest);
  assert.equal(f.tasks.listByThread(f.thread.id).length, 1);
  assert.deepEqual(h.errors, []);
});
