import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancellationFixture } from './helpers/content-modification-cancellation-fixture.js';

test('explicit control reads have their own snapshot and never materialize or return request text', async (t) => {
  const f = await cancellationFixture(t);
  const request = await f.integration.requests.submit(f.payload, f.human);
  f.integration.text.read = async () => {
    throw new Error('a control read must not request source bytes');
  };
  const first = await f.catRead(f.requestId, { view: 'control' });
  assert.equal(first.statusCode, 200, first.body);
  const before = first.json(),
    value = JSON.parse(before.json);
  assert.equal(value.stage, 'active');
  assert.equal(value.taskId, request.record.progress.task!.taskId);
  for (const field of ['intent', 'source', 'sourceRef', 'execution']) assert.equal(field in value, false);
  const source = f.messages.getById(request.record.progress.sourceMessageId!)!;
  source.recall = { recalledAt: Date.now(), recalledBy: 'operator' };
  const revoked = await f.catRead(f.requestId, { view: 'control' });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal(JSON.parse(revoked.json().json).stage, 'source_unavailable');
  const stale = await f.catRead(f.requestId, { view: 'control', expectedSnapshot: before.snapshot });
  assert.equal(stale.statusCode, 409, stale.body);
  const mismatchedReview = await f.catRead(f.requestId, { view: 'control', reviewId: 'different-review' });
  assert.equal(mismatchedReview.statusCode, 404);
});
