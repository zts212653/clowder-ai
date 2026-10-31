import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { cancellationFixture } from './helpers/content-modification-cancellation-fixture.js';

test('a new explicit file request after cancellation gets its own human source and Task without reviving the closed one', async (t) => {
  const f = await cancellationFixture(t);
  const first = await f.integration.requests.submit(f.payload, f.human);
  const cancellation = await f.integration.requests.cancel(first.record.requestId, f.human);
  assert.equal(cancellation.record.control?.taskResolution, 'closed');
  const oldTask = await f.tasks.get(first.record.progress.task!.taskId);
  const request = { ...f.payload, operationId: randomUUID(), intent: { body: '现在明确另发一次修改，只改用词。' } };
  const fresh = await f.integration.requests.submit(request, f.human);
  assert.equal(fresh.stage, 'queued', JSON.stringify(fresh.record.issue));
  assert.notEqual(fresh.record.requestId, first.record.requestId);
  assert.notEqual(fresh.record.progress.task!.taskId, first.record.progress.task!.taskId);
  assert.notEqual(fresh.record.progress.sourceMessageId, first.record.progress.sourceMessageId);
  assert.deepEqual(await f.tasks.get(first.record.progress.task!.taskId), oldTask);
  assert.equal((await f.integration.requests.submit(f.payload, f.human)).stage, 'cancelled');
  assert.equal((await f.integration.requests.submit(request, f.human)).record.requestId, fresh.record.requestId);
  const catalogue = await f.integration.context.read(f.payload.source, f.human);
  assert.equal(catalogue.requests.length, 2);
  assert.deepEqual(new Set(catalogue.contexts.map((item) => item.state)), new Set(['active', 'closed']));
});
