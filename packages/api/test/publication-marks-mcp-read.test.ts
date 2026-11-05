import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import {
  handleReadArtifactReview,
  readArtifactReviewInputSchema,
} from '../../mcp-server/src/tools/artifact-review-tools.js';
import { publicationMarksFixture } from './helpers/publication-marks-read-fixture.js';

test('the published MCP reader reaches the authenticated callback and returns saved marks without takeover', async (t) => {
  const f = await publicationMarksFixture();
  t.after(f.close);
  const previous = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  const url = await f.app.listen({ port: 0, host: '127.0.0.1' });
  const auth = f.auth;
  process.env.CAT_CAFE_API_URL = url;
  process.env.CAT_CAFE_INVOCATION_ID = auth.invocationId;
  process.env.CAT_CAFE_CALLBACK_TOKEN = auth.callbackToken;
  const schema = z.object(readArtifactReviewInputSchema).strict();
  const input = schema.parse(f.payload);
  const before = f.store.ledgers.get(f.payload.reviewId);
  const result = await handleReadArtifactReview(input);
  assert.equal(result.isError, undefined);
  const text = result.content.find((item) => item.type === 'text');
  assert.ok(text?.type === 'text');
  let page = JSON.parse(text.text);
  assert.equal(page.reviewId, f.payload.reviewId);
  assert.equal(page.revision, 2);
  assert.equal(page.records.find((item: { path: string }) => item.path === '/0/drawing/kind')?.value, 'stroke');
  assert.ok(page.nextCursor > 0);
  const records = new Map<string, unknown>(
    page.records.map((record: { path: string; value: unknown }) => [record.path, record.value]),
  );
  for (let pages = 0; page.nextCursor !== null; pages++) {
    assert.ok(pages < 100);
    const continuation = await handleReadArtifactReview(
      schema.parse({
        ...input,
        cursor: page.nextCursor,
        expectedRevision: page.revision,
        expectedSourceSnapshot: page.sourceSnapshot,
      }),
    );
    assert.equal(continuation.isError, undefined);
    const part = continuation.content.find((item) => item.type === 'text');
    assert.ok(part?.type === 'text');
    page = JSON.parse(part.text);
    for (const record of page.records) records.set(record.path, record.value);
  }
  assert.equal(records.get('/0/author/actorId'), 'operator');
  assert.equal(records.get('/2/drawing/points/152/x'), f.drawings[2]?.points[152]?.x);
  assert.deepEqual(f.store.ledgers.get(f.payload.reviewId), before);
  assert.equal(f.task.current, null);
});
