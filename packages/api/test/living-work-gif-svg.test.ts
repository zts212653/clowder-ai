import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import sharp from 'sharp';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { createWorkAuthorizer } from '../src/domains/collaborative-content/works/access.js';
import { WorkCatalogue } from '../src/domains/collaborative-content/works/catalogue.js';
import { WorkReviewResponseService } from '../src/domains/collaborative-content/works/review-response.js';
import { LivingWorkService } from '../src/domains/collaborative-content/works/service.js';
import { createWorkWorkspaceSource } from '../src/domains/collaborative-content/works/workspace-source.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { registerPublishedContentRoutes } from '../src/routes/published-content-routes.js';
import { createReviewFixture, reviewHuman } from './helpers/artifact-review-fixture.js';

for (const kind of ['gif', 'svg'] as const)
  test(`${kind}: actual Workspace original → same Work v2 → retained Chat/Works and exact HTTP originals`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f309-native-work-'));
    const store = new ArtifactReviewStore(join(root, 'reviews.sqlite'));
    const f = createReviewFixture(root, root, store);
    const app = Fastify();
    t.after(async () => {
      await app.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    const registry = new InvocationRegistry();
    const credentials = await registry.create(
      'operator',
      'codex-astra',
      'thread-cover',
      undefined,
      undefined,
      undefined,
      undefined,
      'strict',
    );
    const principal = {
      userId: 'operator',
      threadId: 'thread-cover',
      actor: { kind: 'cat' as const, actorId: 'codex-astra' },
      invocationId: credentials.invocationId,
    };
    const workspace = new WorkspaceContentSourceService({
      ownerUserId: 'operator',
      resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'original' }),
    });
    const source = createWorkWorkspaceSource(workspace);
    const responses = new WorkReviewResponseService({
      owner: f.owner,
      store,
      // Review policy has its own coverage; this fixture exercises real file, owner and response effects.
      authorize: async () => undefined,
      readAsset: (review, revision, actor) => f.media.read(review.contentRef, revision, actor),
    });
    const service = new LivingWorkService({
      owner: f.owner,
      versions: store.works,
      source,
      responses,
      authorize: createWorkAuthorizer({
        ownerUserId: 'operator',
        access: f.access,
        invocation: (id) => registry.peekRecord(id),
      }),
    });
    async function bytes(version: number) {
      if (kind === 'svg')
        return Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 20 40 24"><rect id="target" x="-10" y="20" width="${10 + version}" height="10" fill="red"/></svg>`,
        );
      const pixels = Buffer.alloc(4 * 4 * 2 * 4, version * 70);
      pixels.fill(version * 70 + 20, pixels.length / 2);
      for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
      return sharp(pixels, { raw: { width: 4, height: 8, channels: 4, pageHeight: 4 } })
        .gif({ delay: [80, 230], loop: 0 })
        .toBuffer();
    }
    const original = await bytes(1),
      candidate = await bytes(2);
    const locator = { worktreeId: 'original', path: 'mislabeled.png' };
    await writeFile(join(root, locator.path), original);
    const reader = await registry.create(
      'operator',
      'codex-sol',
      'thread-cover',
      undefined,
      undefined,
      undefined,
      undefined,
      kind === 'gif' ? 'unknown' : 'compatibility_fallback',
    );
    const inspected = await service.inspectSource(locator, {
      ...principal,
      actor: { kind: 'cat', actorId: 'codex-sol' },
      invocationId: reader.invocationId,
    });
    assert.equal(inspected.mediaType, kind === 'gif' ? 'image/gif' : 'image/svg+xml');
    const first = await service.commit(
      {
        action: 'create',
        operationId: 'native-v1',
        title: '原生作品',
        changeSummary: '第一版',
        source: inspected.source,
      },
      principal,
    );
    const card = await service.reference(first.reference, principal);
    assert.deepEqual(card.block.meta?.reference, first.reference);
    const asset = await f.media.read(first.reference.contentRef, 1, reviewHuman);
    const now = '2026-11-07T12:00:00.000Z';
    const anchor = {
      kind: 'image-point' as const,
      x: 1,
      y: 1,
      ...(kind === 'gif' ? { frameIndex: 1, timestampMs: 80 } : {}),
    };
    const reviewId = `native-${kind}-opinion`;
    store.create(
      {
        version: 2,
        reviewId,
        revision: 1,
        title: '原版的意见',
        contentRef: first.reference.contentRef,
        task: {
          taskId: 'original-opinion-task',
          threadId: principal.threadId,
          ownerUserId: 'operator',
          observedRevision: 1,
        },
        createdAt: now,
        updatedAt: now,
        rounds: [
          {
            number: 1,
            asset,
            state: 'changes_requested',
            openedAt: now,
            responses: [],
            annotations: [
              {
                id: 'opinion',
                author: reviewHuman.actor,
                body: '调整这一处',
                state: 'open',
                replies: [],
                anchor,
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
        ],
      },
      { operationId: 'prepare-native', actor: reviewHuman.actor, now },
    );
    await writeFile(join(root, locator.path), candidate);
    const nextSource = await source.inspect({ locator, principal });
    const next = await service.commit(
      {
        action: 'submit',
        operationId: 'native-v2',
        title: '原生作品',
        changeSummary: '修改对应局部',
        contentRef: first.reference.contentRef,
        expectedOwnerRevision: 1,
        source: nextSource.source,
        reviewResponse: {
          reviewId,
          expectedReviewRevision: 1,
          expectedTaskRevision: 1,
          sourceRound: 1,
          responses: [
            {
              annotationId: 'opinion',
              disposition: 'addressed',
              explanation: '原件对应位置已调整',
              resultAnchor: anchor,
            },
          ],
        },
      },
      principal,
    );
    assert.deepEqual(next.reference, { ...first.reference, ownerRevision: 2 });
    assert.deepEqual((await f.owner.load(first.reference.contentRef, 1)).bytes, original);
    assert.deepEqual((await f.owner.load(first.reference.contentRef, 2)).bytes, candidate);
    assert.equal((await service.read(first.reference, principal)).version.changeSummary, '第一版');
    assert.equal((await service.reference(first.reference, principal)).block.meta?.reference.ownerRevision, 1);
    const catalogue = await new WorkCatalogue(service).readThread({
      ownerUserId: 'operator',
      threadId: 'thread-cover',
    });
    assert.equal(catalogue.artifacts.length, 1);
    assert.equal(catalogue.artifacts[0]?.type, 'image');
    assert.equal(catalogue.artifacts[0]?.mime, inspected.mediaType);
    assert.equal(catalogue.artifacts[0]?.work?.ownerRevision, 2);
    assert.equal(store.get(reviewId)?.rounds.at(-1)?.asset.mediaType, inspected.mediaType);
    assert.deepEqual(store.get(reviewId)?.rounds[0]?.annotations[0]?.anchor, anchor);
    app.decorateRequest('sessionUserId', null);
    app.addHook('onRequest', async (req) => {
      req.sessionUserId = req.headers['x-fixture-user'] === 'operator' ? 'operator' : null;
    });
    registerPublishedContentRoutes(app, { media: f.media });
    const mediaPath = `/api/content-publications/${encodeURIComponent(first.reference.contentRef)}/media/1`;
    assert.equal((await app.inject({ method: 'GET', url: mediaPath })).statusCode, 401);
    const admitted = await f.media.read(first.reference.contentRef, 1, reviewHuman);
    assert.equal(admitted.mediaType, inspected.mediaType);
    const response = await app.inject({ method: 'GET', url: mediaPath, headers: { 'x-fixture-user': 'operator' } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['content-type'], inspected.mediaType);
    assert.deepEqual(response.rawPayload, original);
    if (kind === 'gif') {
      const preview = await app.inject({
        method: 'GET',
        url: mediaPath + '?display=gif-frames',
        headers: { 'x-fixture-user': 'operator' },
      });
      assert.equal(preview.statusCode, 200, preview.body);
      assert.equal(preview.headers['content-type'], 'image/png');
      assert.equal(preview.headers['cache-control'], 'private, no-store');
      assert.equal((await sharp(preview.rawPayload).metadata()).width, 8);
    } else assert.match(String(response.headers['content-security-policy']), /sandbox/);
  });
