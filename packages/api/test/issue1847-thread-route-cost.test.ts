import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import Fastify from 'fastify';
import sharp from 'sharp';
import { WorkCatalogue } from '../src/domains/collaborative-content/works/catalogue.js';
import { LivingWorkService } from '../src/domains/collaborative-content/works/service.js';
import { threadsRoutes } from '../src/routes/threads.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

test('real thread Works HTTP includes media lineage without owner-wide scans at tenfold unrelated scale', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'issue1847-route-'));
  await fs.writeFile(
    join(root, 'review-input.png'),
    await sharp({ create: { width: 4, height: 3, channels: 3, background: '#eee' } })
      .png()
      .toBuffer(),
  );
  const f = await createLiveReviewFixture(root);
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await f.dispatch.close();
    f.store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await f.media.prepare({ ...f.prepare, principal: f.human });
  const bytes = Buffer.from('synthetic video source');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
  const works = new LivingWorkService({
    owner: f.owner,
    versions: f.store.works,
    authorize: async ({ principal, scope }) => {
      if (scope) assert.equal(scope.ownerUserId, principal.userId);
    },
    source: {
      open: async () => ({
        stream: Readable.from([bytes]),
        byteLength: bytes.length,
        blobDigest: digest,
        mediaType: 'video/mp4',
        publication: { sourceRef: 'workspace:fixture:video.mp4', artifactRef: 'video.mp4', revision: digest },
        revalidate: async () => undefined,
      }),
      openCurrent: async () => {
        throw new Error('not a workspace reader');
      },
      inspect: async () => {
        throw new Error('not a workspace reader');
      },
    },
  });
  const create = (id: string, threadId: string) =>
    works.commit(
      {
        action: 'create',
        operationId: id,
        title: id,
        changeSummary: 'synthetic',
        source: { worktreeId: 'fixture', path: 'video.mp4', expectedSourceRevision: digest },
      },
      { ...f.human, threadId },
    );
  await Promise.all(Array.from({ length: 3 }, (_, i) => create(`selected-${i}`, f.thread.id)));
  const other = f.threads.create(f.human.userId, 'Other', root);
  await Promise.all(Array.from({ length: 10 }, (_, i) => create(`small-${i}`, other.id)));
  await app.register(threadsRoutes, {
    threadStore: f.threads,
    messageStore: f.messages,
    taskStore: f.tasks,
    artifactWorkLineage: { current: f.globalArtifactWorkLineage, independent: new WorkCatalogue(works) },
  });
  const request = () =>
    app.inject({
      url: `/api/threads/${f.thread.id}/artifacts?view=works`,
      headers: { 'x-cat-cafe-user': f.human.userId },
    });
  assert.equal((await request()).statusCode, 200, 'backfill completes before steady-state measurements');
  const ownerRoot = join(root, 'projects', 'content-owner-v1');
  const read = fs.readFile,
    open = fs.opendir;
  let manifests = 0,
    walks = 0;
  fs.readFile = async (path, ...args) => {
    if (String(path).startsWith(ownerRoot) && basename(String(path)) === 'state.json') manifests++;
    return read(path, ...args);
  };
  fs.opendir = async (path, ...args) => {
    if (String(path) === ownerRoot) walks++;
    return open(path, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFile = read;
    fs.opendir = open;
    syncBuiltinESMExports();
  });
  const measure = async () => {
    manifests = 0;
    walks = 0;
    const started = performance.now();
    const response = await request();
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.workLineage, 'resolved');
    assert.ok(
      body.artifacts.some(
        (item: { sourceMessageId?: string; work?: unknown }) => item.sourceMessageId === f.publication.id && item.work,
      ),
    );
    return { manifests, walks, elapsedMs: performance.now() - started, total: body.total };
  };
  const small = await measure();
  await Promise.all(Array.from({ length: 90 }, (_, i) => create(`large-${i}`, other.id)));
  const large = await measure();
  t.diagnostic(JSON.stringify({ unrelatedWorks: [10, 100], small, large }));
  assert.equal(small.walks, 0);
  assert.equal(large.walks, 0);
  assert.equal(large.manifests, small.manifests);
  assert.equal(large.total, small.total);
});
