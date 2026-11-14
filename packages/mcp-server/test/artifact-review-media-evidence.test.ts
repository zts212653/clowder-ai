import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { handleReadArtifactReview, readArtifactReviewInputSchema } from '../src/tools/artifact-review-tools.js';
import { withInvocationCredentials } from '../src/tools/invocation-auth.js';

const previousFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = previousFetch;
});

test('review media is delivered as native MCP images with exact original identity, not base64 text', async () => {
  const evidence = {
    asset: {
      contentRef: 'content:immutable-gif',
      ownerRevision: 2,
      blobDigest: `sha256:${'a'.repeat(64)}`,
      mediaType: 'image/gif',
      media: {
        kind: 'image',
        width: 4,
        height: 4,
        animation: { frameCount: 2, frameDelaysMs: [80, 230], durationMs: 310, loopCount: 0 },
      },
      sourcePublication: { artifactRef: '/uploads/original.gif', sourceRef: 'message:original', revision: '1' },
      ownerReceiptRef: 'receipt:2',
    },
    originalPath: '/private/immutable/original.gif',
    anchor: { kind: 'image-point', x: 1, y: 1, frameIndex: 1, timestampMs: 80 },
    images: [{ purpose: 'frame', mimeType: 'image/png', data: 'Zm9yLXRyYW5zcG9ydC10ZXN0' }],
    trust: 'untrusted_review_data',
  };
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(new URL(String(url)).pathname, '/api/callbacks/artifact-review/read');
    assert.equal(JSON.parse(String(init.body)).annotationId, 'selected-frame');
    assert.equal(new Headers(init.headers).get('x-invocation-id'), 'evidence-fixture-invocation');
    return new Response(JSON.stringify(evidence), { headers: { 'content-type': 'application/json' } });
  };
  const input = z
    .object(readArtifactReviewInputSchema)
    .parse({ reviewId: 'review:original', view: 'media', annotationId: 'selected-frame', round: 1 });
  const result = await withInvocationCredentials(
    {
      apiUrl: 'http://localhost:3102',
      invocationId: 'evidence-fixture-invocation',
      callbackToken: 'evidence-fixture-token',
    },
    () => handleReadArtifactReview(input),
  );
  assert.equal(CallToolResultSchema.safeParse(result).success, true);
  assert.equal(result.isError, undefined, JSON.stringify(result.content));
  assert.deepEqual(result.content[1], { type: 'image', mimeType: 'image/png', data: evidence.images[0].data });
  const text = result.content[0];
  assert.equal(text.type, 'text');
  if (text.type !== 'text') throw new Error('missing evidence metadata');
  assert.equal(text.text.includes(evidence.images[0].data), false);
  assert.deepEqual(JSON.parse(text.text).anchor, evidence.anchor);
  assert.equal(JSON.parse(text.text).originalPath, evidence.originalPath);
});
