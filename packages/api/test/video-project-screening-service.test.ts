import assert from 'node:assert/strict';
import { unlink, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { VideoProjectScreeningService } from '../src/domains/video-studio/project/screening-service.js';
import { VideoProjectService } from '../src/domains/video-studio/project/service.js';
import { screeningFixture } from './helpers/video-project-screening.js';

test('actual F063 source freezes media and references an existing input in the subsequent F138 revision', async (t) => {
  const fixture = await screeningFixture();
  t.after(fixture.cleanup);
  const service = fixture.make();
  const { receipt, screening } = await service.register(fixture.request);
  assert.equal(receipt.ownerRevision, 2);
  assert.equal(screening.input.ownerRevision, 1);
  assert.equal(screening.input.blobDigest, fixture.request.input.blobDigest);
  assert.equal(screening.media.ownerRevision, 1);
  assert.deepEqual(screening.media.media.frameRate, { numerator: 30, denominator: 1 });
  assert.notEqual(receipt.blobDigest, screening.input.blobDigest);
  assert.deepEqual((await fixture.projects.load(fixture.request)).document.screenings, [screening]);
  const restoredOwner = new ProjectContentOwnerService({ dataDir: fixture.dataDir });
  const restoredProjects = new VideoProjectService({ owner: restoredOwner, ownerUserId: fixture.principal.userId });
  const restored = fixture.make(restoredOwner, restoredProjects);
  await writeFile(fixture.path, 'different source now');
  const descriptor = await restored.descriptor({ ...fixture.request, screeningId: screening.id });
  assert.equal(descriptor.screening.media.blobDigest, screening.media.blobDigest);
  assert.ok(!JSON.stringify(descriptor).includes(fixture.root));
  const opened = await restored.open({ ...fixture.request, screeningId: screening.id });
  try {
    assert.deepEqual(await opened.handle.readFile(), fixture.bytes);
  } finally {
    await opened.handle.close();
  }
  assert.deepEqual(
    await restored.register(fixture.request),
    { receipt, screening },
    'exact retry survives changed mutable original',
  );
  await assert.rejects(
    restored.register({ ...fixture.request, title: 'reused operation with other meaning' }),
    /reused/,
  );
});

test('wrong historical digest, another input project, bounds and changed source are rejected', async (t) => {
  const fixture = await screeningFixture();
  t.after(fixture.cleanup);
  const service = fixture.make();
  await assert.rejects(
    service.register({
      ...fixture.request,
      input: { ...fixture.request.input, blobDigest: `sha256:${'f'.repeat(64)}` },
    }),
    /input_changed/,
  );
  await assert.rejects(
    service.register({ ...fixture.request, input: { ...fixture.request.input, contentRef: 'video-project:other' } }),
    /input_changed/,
  );
  await assert.rejects(
    service.register({
      ...fixture.request,
      mapping: { ...fixture.request.mapping, frame: { ...fixture.request.mapping.frame, canvasWidth: 20 } },
    }),
    /invalid_screening/,
  );
  const next = { ...fixture.request, operationId: 'changed-source' };
  await writeFile(fixture.path, 'changed');
  await assert.rejects(service.register(next), /media_changed/);
  await unlink(fixture.path);
  await assert.rejects(service.register({ ...fixture.request, operationId: 'missing-source' }), /not_found/);
});

test('HTTP-facing service does not let ordinary Cat project permission authorize source publication', async (t) => {
  const fixture = await screeningFixture();
  t.after(fixture.cleanup);
  let allow = true;
  const projects = new VideoProjectService({
    owner: fixture.owner,
    ownerUserId: fixture.principal.userId,
    authorizeCat: async () => {
      if (!allow) throw new Error('Video project access denied');
    },
  });
  const cat = {
    userId: fixture.principal.userId,
    actor: { kind: 'cat' as const, actorId: 'sol' },
    invocationId: 'actual-invocation',
  };
  const service = fixture.make(fixture.owner, projects);
  await assert.rejects(service.register({ ...fixture.request, principal: cat }), /access_denied/);
  const saved = await service.register(fixture.request);
  allow = false;
  await assert.rejects(
    service.open({ ...fixture.request, principal: cat, screeningId: saved.screening.id }),
    /access denied/,
  );
  await assert.rejects(
    service.descriptor({
      ...fixture.request,
      principal: { userId: 'other', actor: { kind: 'human', actorId: 'other' } },
      screeningId: saved.screening.id,
    }),
    /access denied/,
  );
});

test('failed project append can recover the same imported immutable snapshot without source reread', async (t) => {
  const fixture = await screeningFixture();
  t.after(fixture.cleanup);
  const failing = new VideoProjectScreeningService({
    owner: fixture.owner,
    projects: fixture.projects,
    workspace: fixture.workspace,
    appendScreening: async () => {
      throw new Error('append unavailable');
    },
    now: () => '2026-10-10T00:00:00.000Z',
  });
  await assert.rejects(failing.register(fixture.request), /append unavailable/);
  assert.equal((await fixture.projects.load(fixture.request)).ownerRevision, 1);
  await unlink(fixture.path);
  const result = await fixture.make().register(fixture.request);
  assert.equal(result.receipt.ownerRevision, 2);
  assert.equal(result.screening.at, '2026-10-10T00:00:00.000Z');
});

test('source revalidation rejects bytes replaced after the actual F063 snapshot was opened', async (t) => {
  const fixture = await screeningFixture();
  t.after(fixture.cleanup);
  const open = fixture.workspace.openMedia.bind(fixture.workspace);
  fixture.workspace.openMedia = async (input) => {
    const snapshot = await open(input);
    await writeFile(fixture.path, 'source replaced while registering');
    return snapshot;
  };
  await assert.rejects(fixture.make().register(fixture.request), /media_changed/);
});

test('archive revokes playback and delayed registration while retained facts remain readable', async (t) => {
  const fixture = await screeningFixture();
  t.after(fixture.cleanup);
  const service = fixture.make();
  const saved = await service.register(fixture.request);
  await fixture.projects.archive({
    ...fixture.request,
    operationId: 'archive',
    expectedOwnerRevision: 2,
    archived: true,
  });
  await assert.rejects(service.descriptor({ ...fixture.request, screeningId: saved.screening.id }), /archived/);
  await assert.rejects(service.open({ ...fixture.request, screeningId: saved.screening.id }), /archived/);
  await assert.rejects(
    service.register({ ...fixture.request, operationId: 'delayed', expectedOwnerRevision: 3, id: 'late-screening' }),
    /archived/,
  );
  assert.equal((await fixture.projects.load(fixture.request)).document.screenings?.length, 1);
});

test('a separately verified Cat source grant retains the real Cat actor and is rechecked', async (t) => {
  const fixture = await screeningFixture();
  t.after(fixture.cleanup);
  const projects = new VideoProjectService({
    owner: fixture.owner,
    ownerUserId: fixture.principal.userId,
    authorizeCat: async () => {},
  });
  let checks = 0;
  const cat = {
    userId: fixture.principal.userId,
    actor: { kind: 'cat' as const, actorId: 'sol' },
    invocationId: 'authenticated',
  };
  const service = new VideoProjectScreeningService({
    owner: fixture.owner,
    projects,
    workspace: fixture.workspace,
    authorizeCatSource: async (command) => {
      checks++;
      assert.equal(command.principal.invocationId, 'authenticated');
      assert.equal(command.source.expectedSourceRevision, fixture.request.source.expectedSourceRevision);
      assert.equal(command.contentRef, fixture.request.contentRef);
    },
    appendScreening: (command) => projects.appendScreening(command),
  });
  const saved = await service.register({ ...fixture.request, principal: cat });
  assert.deepEqual(saved.screening.actor, cat.actor);
  assert.deepEqual(saved.receipt.actor, cat.actor);
  assert.ok(checks >= 3);
});

test('ordinary save cannot remove, rewrite or append screening facts after real registration', async (t) => {
  const fixture = await screeningFixture();
  t.after(fixture.cleanup);
  const saved = await fixture.make().register(fixture.request);
  const snapshot = await fixture.projects.load(fixture.request);
  for (const screenings of [
    [],
    [{ ...saved.screening, title: 'rewritten' }],
    [saved.screening, { ...saved.screening, id: 'new' }],
  ]) {
    await assert.rejects(
      fixture.projects.save({
        ...fixture.request,
        expectedOwnerRevision: 2,
        operationId: `ordinary-${screenings.length}-${screenings[0]?.title}`,
        document: { ...snapshot.document, screenings },
      }),
      /registration|unique/,
    );
  }
  assert.equal((await fixture.projects.load(fixture.request)).ownerRevision, 2);
});
