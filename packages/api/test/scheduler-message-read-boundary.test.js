import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEligibleReplyParent } from '../dist/domains/cats/services/stores/visibility.js';
import { CAT, OWNER, schedulerReadFixture } from './helpers/scheduler-read-fixture.js';

for (const producer of ['repair', 'legacy-failure']) {
  test(`published ${producer} from the real Alpha publisher can be read in preview and full`, async (t) => {
    const f = await schedulerReadFixture(t),
      notice = await f.publish(producer);
    const tasksBeforeRead = structuredClone(f.tasks.listByThread(f.thread.id));
    assert.deepEqual(notice.from, { kind: 'system', service: 'scheduler' });
    assert.equal(notice.userId, OWNER);
    assert.equal(notice.lifecycle.kind, 'input');
    for (const mode of ['preview', 'full']) {
      const res = await f.read(notice, mode);
      assert.equal(res.statusCode, 200, res.body);
      if (mode === 'full') assert.equal(res.json().message.content, notice.content);
      else assert.ok(notice.content.startsWith(res.json().message.content));
    }
    const current = await f.app.inject({
      url: `/api/callbacks/get-message?messageId=${notice.id}&mode=full`,
      headers: await f.auth(notice),
    });
    assert.equal(current.statusCode, 200, current.body);
    assert.equal(
      isEligibleReplyParent(notice, { threadId: notice.threadId, viewer: { type: 'cat', catId: CAT } }),
      false,
    );
    assert.equal(f.stats.adoptions, 0);
    assert.equal(f.stats.reads, 0);
    assert.deepEqual(f.tasks.listByThread(f.thread.id), tasksBeforeRead);
  });
}

const denied = {
  'foreign message owner': (m) => {
    m.userId = 'foreign-owner';
  },
  'ownerless scheduler': (m) => {
    m.userId = 'scheduler';
  },
  'source parse failure': (m) => {
    m.sourceParseFailure = true;
  },
  'unknown system producer': (m) => {
    m.from = { kind: 'system', service: 'unknown' };
  },
  'connector mismatch': (m) => {
    m.source = { ...m.source, connector: 'unknown' };
  },
  'internal briefing': (m) => {
    m.origin = 'briefing';
  },
  'hidden trigger': (m) => {
    m.extra = { scheduler: { hiddenTrigger: true } };
  },
  'queued source': (m) => {
    m.deliveryStatus = 'queued';
  },
  'withdrawn source': (m) => {
    m.deliveryStatus = 'canceled';
  },
  'deleted source': (m) => {
    m.deletedAt = 123;
  },
  'recalled source': (m) => {
    m.recall = { recalledAt: 123 };
  },
  tombstone: (m) => {
    m._tombstone = true;
  },
  'no native dispatch': (m) => {
    m.lifecycle = { kind: 'input', orderKey: m.lifecycle.orderKey, dispatchRefs: [] };
  },
  'unmentioned native target': (m) => {
    m.mentions = [];
  },
};
for (const [label, corrupt] of Object.entries(denied)) {
  test(`${label} stays unreadable and cannot authorize search`, async (t) => {
    const f = await schedulerReadFixture(t),
      notice = await f.publish();
    const altered = structuredClone(notice);
    corrupt(altered);
    const get = f.messages.getById.bind(f.messages);
    f.messages.getById = (id) => (id === notice.id ? altered : get(id));
    for (const mode of ['preview', 'full']) assert.equal((await f.read(notice, mode)).statusCode, 404, label);
    const res = await f.search(await f.auth(notice));
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(f.stats.reads, 0);
    assert.equal(f.stats.adoptions, 0);
    f.messages.getByThreadBefore = () => [altered];
    f.messages.getByThreadAfter = () => [];
    const neighbors = await f.read(f.answer, 'full', '&contextCount=1');
    assert.equal(neighbors.statusCode, 200, neighbors.body);
    assert.deepEqual(neighbors.json().context, []);
  });
}

for (const missing of ['missing', 'deleted', 'foreign-owner']) {
  test(`${missing} current thread cannot admit a scheduler notice`, async (t) => {
    const f = await schedulerReadFixture(t),
      notice = await f.publish();
    const original = f.threads.get.bind(f.threads);
    f.threads.get = (id) =>
      id !== notice.threadId
        ? original(id)
        : missing === 'missing'
          ? null
          : { ...original(id), ...(missing === 'deleted' ? { deletedAt: 123 } : { createdBy: 'other' }) };
    assert.equal((await f.read(notice)).statusCode, 404);
    assert.equal((await f.search(await f.auth(notice))).statusCode, 403);
    assert.equal(f.stats.reads, 0);
  });
}

test('an admitted but undispatched scheduler input cannot be adopted by a full read', async (t) => {
  const f = await schedulerReadFixture(t),
    notice = await f.publish('repair', false);
  assert.equal(notice.deliveryStatus, 'queued');
  assert.equal((await f.read(notice)).statusCode, 404);
  assert.equal(f.stats.adoptions, 0);
});

test('a readable notice stays ineligible in the actual callback reply route', async (t) => {
  const f = await schedulerReadFixture(t),
    notice = await f.publish();
  const res = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: await f.auth(notice),
    payload: { content: 'Ordinary reply body', mentions: [], replyTo: notice.id },
  });
  assert.equal(res.statusCode, 200, res.body);
  const posted = f.messages.getById(res.json().messageId);
  assert.equal(posted.content, 'Ordinary reply body');
  assert.equal(posted.replyTo, undefined);
});

test('context neighbors consume the same admission and keep ordinary system/briefing out', async (t) => {
  const f = await schedulerReadFixture(t),
    notice = await f.publish();
  const badge = f.messages.append({
    from: { kind: 'system', service: 'scheduler' },
    userId: OWNER,
    threadId: f.thread.id,
    content: 'History-only status',
    mentions: [],
    timestamp: Date.now(),
  });
  const briefing = f.messages.append({
    from: { kind: 'agent', catId: CAT },
    userId: OWNER,
    threadId: f.thread.id,
    origin: 'briefing',
    content: 'Internal context',
    mentions: [],
    timestamp: Date.now(),
  });
  const res = await f.read(f.answer, 'full', '&contextCount=10');
  assert.equal(res.statusCode, 200, res.body);
  const ids = res.json().context.map((m) => m.id);
  assert.ok(ids.includes(notice.id));
  assert.ok(!ids.includes(badge.id) && !ids.includes(briefing.id));
  assert.equal((await f.read(badge)).statusCode, 404);
  assert.equal((await f.search(await f.auth(badge))).statusCode, 403);
});

test('a different authenticated owner cannot borrow a published scheduler source', async (t) => {
  const f = await schedulerReadFixture(t),
    notice = await f.publish();
  const headers = await f.auth(notice, 'foreign-owner');
  assert.equal(
    (await f.app.inject({ url: `/api/callbacks/get-message?messageId=${notice.id}`, headers })).statusCode,
    404,
  );
  assert.equal((await f.search(headers)).statusCode, 403);
  assert.equal(f.stats.reads, 0);
});

test('play/whisper admission still hides a scheduler input from another cat', async (t) => {
  const f = await schedulerReadFixture(t),
    notice = await f.publish();
  const source = { ...notice, visibility: 'whisper', whisperTo: ['codex61-sol'] };
  const get = f.messages.getById.bind(f.messages),
    threadGet = f.threads.get.bind(f.threads);
  f.messages.getById = (id) => (id === notice.id ? source : get(id));
  f.threads.get = (id) => {
    const v = threadGet(id);
    return v && { ...v, thinkingMode: 'play' };
  };
  assert.equal((await f.read(notice)).statusCode, 404);
  assert.equal((await f.search(await f.auth(notice))).statusCode, 403);
  assert.equal(f.stats.reads, 0);
});
