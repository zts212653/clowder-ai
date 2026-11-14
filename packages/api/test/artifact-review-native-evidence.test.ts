import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { registerCallbackArtifactReviewRoutes } from '../src/routes/callback-artifact-review-routes.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

for (const format of ['gif', 'svg'] as const)
  test(`${format}: cat reads retained original and the exact annotated frame through authenticated review`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f309-native-evidence-'));
    const pixels = Buffer.alloc(4 * 8 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i + (i < pixels.length / 2 ? 0 : 2)] = 255;
      pixels[i + 3] = 255;
    }
    const original =
      format === 'gif'
        ? await sharp(pixels, { raw: { width: 4, height: 8, channels: 4, pageHeight: 4 } })
            .gif({ delay: [80, 230], loop: 0 })
            .toBuffer()
        : Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 20 4 4"><path fill="blue" d="M-10 20h4v4h-4z"/></svg>',
          );
    const path = join(root, 'review-input.png');
    await writeFile(path, original);
    const f = await createLiveReviewFixture(root);
    const app = Fastify();
    t.after(async () => {
      await app.close();
      f.store.close();
      await rm(root, { recursive: true, force: true });
    });
    const opened = await f.reviews.prepare(f.prepare, f.human);
    const reviewId = opened.review.reviewId;
    const anchor = {
      kind: 'image-region' as const,
      x: 1,
      y: 1,
      width: 2,
      height: 2,
      ...(format === 'gif' ? { frameIndex: 1, timestampMs: 80 } : {}),
    };
    await f.reviews.act(
      {
        reviewId,
        expectedRevision: 1,
        expectedTaskRevision: 1,
        operationId: 'annotate-frame',
        round: 1,
        action: { kind: 'annotate', annotationId: 'target', anchor, body: '修改这处蓝色' },
      },
      f.human,
    );
    // The editable source changes; an exact old-version read must use retained owner bytes.
    await writeFile(
      path,
      await sharp({ create: { width: 4, height: 4, channels: 4, background: 'green' } })
        .png()
        .toBuffer(),
    );
    const registry = new InvocationRegistry();
    const credentials = await registry.create('operator', 'codex-astra', f.thread.id);
    const alien = await registry.create('operator', 'codex-astra', 'other-thread');
    await registerCallbackArtifactReviewRoutes(app, { ...f, threads: f.threads, registry });
    const headers = { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken };
    const payload = { reviewId, view: 'media', round: 1, expectedRevision: 2, annotationId: 'target' };
    const response = await app.inject({ method: 'POST', url: '/api/callbacks/artifact-review/read', headers, payload });
    assert.equal(response.statusCode, 200, response.body);
    const evidence = response.json();
    assert.equal(evidence.asset.mediaType, format === 'gif' ? 'image/gif' : 'image/svg+xml');
    assert.equal(evidence.asset.ownerRevision, 1);
    assert.match(evidence.originalPath, new RegExp(`\\.${format}$`));
    assert.deepEqual(await readFile(evidence.originalPath), original);
    assert.deepEqual(evidence.anchor, anchor);
    assert.deepEqual(
      evidence.images.map((item: { purpose: string }) => item.purpose),
      ['frame', 'crop'],
    );
    for (const image of evidence.images) {
      const { data } = await sharp(Buffer.from(image.data, 'base64'))
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      assert.deepEqual(
        [...data.subarray(0, 4)],
        [0, 0, 255, 255],
        'evidence must show blue frame 2, never red frame 1',
      );
    }
    const { handleReadArtifactReview, readArtifactReviewInputSchema } = await import(
      '../../mcp-server/src/tools/artifact-review-tools.js'
    );
    const { withInvocationCredentials } = await import('../../mcp-server/src/tools/invocation-auth.js');
    const previousFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url, init = {}) => {
        assert.equal(new URL(String(url)).pathname, '/api/callbacks/artifact-review/read');
        const result = await app.inject({
          method: 'POST',
          url: '/api/callbacks/artifact-review/read',
          headers: Object.fromEntries(new Headers(init.headers)),
          payload: String(init.body),
        });
        return new Response(result.body, {
          status: result.statusCode,
          headers: { 'content-type': 'application/json' },
        });
      };
      const native = await withInvocationCredentials({ apiUrl: 'http://native-review.invalid', ...credentials }, () =>
        handleReadArtifactReview(z.object(readArtifactReviewInputSchema).parse(payload)),
      );
      assert.equal(native.isError, undefined, JSON.stringify(native.content.filter((item) => item.type === 'text')));
      const pictures = native.content.filter((item) => item.type === 'image');
      assert.equal(pictures.length, 2, 'the actual MCP/authorized callback chain must deliver visual evidence');
      assert.equal(pictures[0]?.data, evidence.images[0].data);
    } finally {
      globalThis.fetch = previousFetch;
    }
    for (const [auth, body, status] of [
      [{}, payload, 401],
      [{ 'x-invocation-id': alien.invocationId, 'x-callback-token': alien.callbackToken }, payload, 403],
      [headers, { ...payload, expectedRevision: 1 }, 409],
      [headers, { ...payload, annotationId: 'missing' }, 404],
    ] as const) {
      const denied = await app.inject({
        method: 'POST',
        url: '/api/callbacks/artifact-review/read',
        headers: auth,
        payload: body,
      });
      assert.equal(denied.statusCode, status, denied.body);
    }
  });
