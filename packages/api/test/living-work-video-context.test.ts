import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { artifactReviewAnchorSchema } from '@cat-cafe/shared';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { WorkVideoContextService } from '../src/domains/collaborative-content/works/video-context.js';

const reference = { contentRef: `work:${'a'.repeat(64)}`, ownerRevision: 1 };
const principal = { userId: 'owner', threadId: 'production', actor: { kind: 'cat' as const, actorId: 'director' } };
const opening = { id: 'opening', title: '开场', text: '保留原话', streamId: '0', startPts: 512, endPts: 1024 };
const context = {
  format: 'video' as const,
  extractorVersion: 'timeline-v1',
  provenance: [{ ref: 'timeline.json@release-v1', digest: `sha256:${'b'.repeat(64)}` }],
  story: [opening],
  assets: [],
};
const command = {
  action: 'set-context' as const,
  reference,
  operationId: 'first-index',
  expectedMetadataRevision: 0,
  context,
};

test('a story opinion verifies the retained quote, range and version rather than the newest metadata', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'f326-story-proof-'));
  const store = new ArtifactReviewStore(join(dir, 'review.sqlite'));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  let allowed = true;
  const service = new WorkVideoContextService({
    store: store.works.contexts,
    authorize: async () => {
      if (!allowed) throw new Error('authority revoked');
    },
    media: async () => ({ kind: 'video', streamId: '0', startTick: 0, durationTicks: 48000 }),
  });
  await service.save(command, principal);
  await service.save(
    {
      ...command,
      operationId: 'new-index',
      expectedMetadataRevision: 1,
      context: { ...context, story: [{ ...opening, text: '新原话', startPts: 600 }] },
    },
    principal,
  );
  const anchor = artifactReviewAnchorSchema.parse({
    kind: 'video-range',
    streamId: '0',
    startTick: 512,
    endTick: 1024,
    storyEvidence: { metadataRevision: 1, paragraphId: opening.id, quote: opening.text },
  });
  await service.verifyStory(reference, anchor, principal);
  for (const changed of [
    { ...anchor, startTick: 600 },
    { ...anchor, storyEvidence: { metadataRevision: 2, paragraphId: opening.id, quote: opening.text } },
    { ...anchor, storyEvidence: { metadataRevision: 1, paragraphId: 'missing', quote: opening.text } },
    { ...anchor, storyEvidence: { metadataRevision: 1, paragraphId: opening.id, quote: '伪造原话' } },
  ])
    await assert.rejects(
      service.verifyStory(reference, artifactReviewAnchorSchema.parse(changed), principal),
      /invalid_media/,
    );
  await assert.rejects(service.verifyStory({ ...reference, ownerRevision: 2 }, anchor, principal), /invalid_media/);
  allowed = false;
  await assert.rejects(service.verifyStory(reference, anchor, principal), /revoked/);
});

test('video context CAS retains exact versions and old metadata without becoming a work head', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'f326-context-'));
  const store = new ArtifactReviewStore(join(dir, 'review.sqlite'));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  let allowed = true;
  const deps = {
    store: store.works.contexts,
    authorize: async () => {
      if (!allowed) throw new Error('authority revoked');
    },
    media: async () => ({ kind: 'video' as const, streamId: '0', startTick: 0, durationTicks: 48000 }),
  };
  const service = new WorkVideoContextService(deps);
  const first = await service.save(command, principal);
  assert.equal(first.metadataRevision, 1);
  assert.deepEqual(await service.save(command, principal), first);
  await assert.rejects(service.save({ ...command, context: { ...context, story: [] } }, principal), /idempotency/);
  await assert.rejects(service.save({ ...command, operationId: 'stale' }, principal), /conflict/);
  const second = await service.save(
    {
      ...command,
      operationId: 'update',
      expectedMetadataRevision: 1,
      context: { ...context, story: [{ ...opening, text: '新版索引，原文仍可回看' }] },
    },
    principal,
  );
  assert.equal(second.metadataRevision, 2);
  assert.equal((await service.read(reference, principal, 1))?.context.story[0]?.text, '保留原话');
  assert.equal((await new WorkVideoContextService(deps).read(reference, principal))?.metadataRevision, 2);
  assert.equal(await service.read({ ...reference, ownerRevision: 2 }, principal), null);
  assert.deepEqual(second.reference, reference);
  allowed = false;
  await assert.rejects(service.read(reference, principal), /revoked/);
  await assert.rejects(service.save(command, principal), /revoked/);
});

test('story PTS and selected asset versions must describe this actual decoded film', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'f326-context-clock-'));
  const store = new ArtifactReviewStore(join(dir, 'review.sqlite'));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const service = new WorkVideoContextService({
    store: store.works.contexts,
    authorize: async () => {},
    media: async () => ({ kind: 'video' as const, streamId: '0', startTick: 100, durationTicks: 1000 }),
  });
  for (const story of [
    [{ ...opening, startPts: 99 }],
    [{ ...opening, endPts: 1101 }],
    [{ ...opening, streamId: 'wrong' }],
    [opening, opening],
  ])
    await assert.rejects(service.save({ ...command, context: { ...context, story } }, principal));
  for (const chapter of [
    { ...opening, startPts: 99 },
    { ...opening, endPts: 1101 },
    { ...opening, streamId: 'wrong' },
  ])
    await assert.rejects(
      service.save(
        {
          ...command,
          context: {
            ...context,
            story: [],
            chapters: [
              {
                id: chapter.id,
                title: chapter.title,
                streamId: chapter.streamId,
                startPts: chapter.startPts,
                endPts: chapter.endPts,
              },
            ],
          },
        },
        principal,
      ),
      /invalid_media/,
    );
  assert.equal(await service.read(reference, principal), null);
});

test('a source binding needs its original owner proof on save, replay and read', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'f326-context-binding-'));
  const store = new ArtifactReviewStore(join(dir, 'review.sqlite'));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const bound = {
    ...command,
    context: {
      ...context,
      sourceBinding: {
        sourceProjectContentRef: 'video-project:original',
        sourceOwnerRevision: 1,
        sourceDigest: `sha256:${'c'.repeat(64)}`,
        screeningId: 'original-screening',
        reviewId: 'original-review',
      },
    },
  };
  const deps = {
    store: store.works.contexts,
    authorize: async () => {},
    media: async () => ({ kind: 'video', streamId: '0', startTick: 0, durationTicks: 48000 }),
  };
  await assert.rejects(new WorkVideoContextService(deps).save(bound, principal), /access_denied/);
  let permitted = true,
    verified = 0;
  const verifiedService = new WorkVideoContextService({
    ...deps,
    verifyBinding: async (ref, binding, actor) => {
      verified++;
      assert.deepEqual(ref, reference);
      assert.deepEqual(binding, bound.context.sourceBinding);
      assert.deepEqual(actor, principal);
      if (!permitted) throw new Error('source authority revoked');
    },
  });
  const saved = await verifiedService.save(bound, principal);
  assert.ok(verified > 0);
  assert.deepEqual(await verifiedService.read(reference, principal), saved);
  permitted = false;
  await assert.rejects(verifiedService.save(bound, principal), /revoked/);
  await assert.rejects(verifiedService.read(reference, principal), /revoked/);
});
