import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCompanionWork } from '../src/domains/concierge/live/work/companion-work-read.ts';
import { workFixture } from './helpers/f317-companion-work-fixture.mjs';

test('two Tasks claiming one publication remain ambiguous instead of assigning a guessed Task', async (t) => {
  const f = await workFixture(t);
  f.publish('shared.md');
  for (const key of ['first', 'second']) {
    const taskId = await f.admit(key);
    await f.lifecycle.update({ taskId, expectedRevision: 1, artifactRefs: ['/uploads/shared.md'] });
  }
  const view = await readCompanionWork(f.options);
  assert.equal(view.deliveries.items.length, 1);
  assert.equal(view.deliveries.items[0].taskRef, undefined);
});

test('same display names do not associate another publication URL with the original Task', async (t) => {
  const f = await workFixture(t);
  const taskId = await f.admit();
  const first = f.publish('first.md');
  const second = f.publish('second.md');
  first.extra.rich.blocks[0].fileName = '同名作品';
  second.extra.rich.blocks[0].fileName = '同名作品';
  await f.lifecycle.update({ taskId, expectedRevision: 1, artifactRefs: ['/uploads/first.md'] });
  const rows = (await readCompanionWork(f.options)).deliveries.items;
  assert.equal(rows.find((row) => row.source.messageId === first.id).taskRef, `task:work:${taskId}`);
  assert.equal(rows.find((row) => row.source.messageId === second.id).taskRef, undefined);
});
