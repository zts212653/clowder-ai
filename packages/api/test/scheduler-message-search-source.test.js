import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAT, OWNER, schedulerReadFixture } from './helpers/scheduler-read-fixture.js';

for (const producer of ['repair', 'legacy-failure']) {
  test(`current authenticated ${producer} can search ordinary message evidence`, async (t) => {
    const f = await schedulerReadFixture(t),
      notice = await f.publish(producer);
    const res = await f.search(await f.auth(notice));
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(
      res.json().results.map((r) => r.messageId),
      [f.answer.id],
    );
    assert.equal(f.stats.reads, 1);
    assert.equal(f.stats.adoptions, 0);
  });
}

test('source withdrawal during retrieval is rejected again before any result publication', async (t) => {
  const f = await schedulerReadFixture(t),
    notice = await f.publish();
  f.setDuringSearch(() => f.messages.softDelete(notice.id, OWNER));
  const res = await f.search(await f.auth(notice));
  assert.equal(f.stats.reads, 1);
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().results, undefined);
});

test('model arguments cannot replace the authenticated revoked source with a valid scheduler input', async (t) => {
  const f = await schedulerReadFixture(t),
    notice = await f.publish(),
    revoked = await f.publish('legacy-failure');
  f.messages.softDelete(revoked.id, OWNER);
  const res = await f.search(await f.auth(revoked), `&sourceMessageId=${notice.id}&userId=fake&catId=${CAT}`);
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(f.stats.reads, 0);
});

test('native dispatch to another cat cannot become this invocation source', async (t) => {
  const f = await schedulerReadFixture(t),
    notice = await f.publish();
  const res = await f.search(await f.auth(notice, undefined, 'codex61-sol'));
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(f.stats.reads, 0);
});

test('bad callback credentials cannot borrow a readable scheduler notice', async (t) => {
  const f = await schedulerReadFixture(t),
    notice = await f.publish();
  const headers = { ...(await f.auth(notice)), 'x-callback-token': 'wrong' };
  assert.equal((await f.search(headers)).statusCode, 401);
  assert.equal(f.stats.reads, 0);
});
