import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEligibleReplyParent } from '../dist/domains/cats/services/stores/visibility.js';
import { createReceiptReadFixture, OWNER } from './helpers/approval-exact-read-fixture.js';

for (const producer of ['F128', 'F139', 'F266']) {
  for (const resolution of ['accepted', 'rejected']) {
    test(`${producer} ${resolution}: genuine publisher receipt is readable in preview/full over authenticated HTTP`, async (t) => {
      const f = await createReceiptReadFixture(t);
      const receipt = await f.publish(producer, resolution);
      const reads = f.decisionReads();
      const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
      for (const mode of ['preview', 'full']) {
        const response = await fetch(`${address}/api/callbacks/get-message?messageId=${receipt.id}&mode=${mode}`, {
          headers: f.headers,
        });
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.message.id, receipt.id);
        assert.equal(body.message.content, receipt.content);
        assert.deepEqual(body.message.from, { kind: 'system', service: 'approval-hub' });
      }
      assert.equal(f.decisionReads(), reads, 'read does not consult/regrant a producer decision');
      assert.equal(f.adoptions(), 0, 'a receipt is not executable queued work');
      assert.deepEqual(f.outbox.list(), []);
      assert.equal(isEligibleReplyParent(receipt, { threadId: f.thread.id, viewer: { type: 'user' } }), false);
    });
  }
}

test('exact receipt read preserves callback authentication, owner isolation and reply-parent denial', async (t) => {
  const f = await createReceiptReadFixture(t);
  const receipt = await f.publish();
  assert.equal((await f.read(receipt, 'full', { headers: {} })).statusCode, 401);
  const foreign = await f.invocations.create('foreign-owner', 'opus', f.thread.id);
  assert.equal(
    (
      await f.read(receipt, 'full', {
        headers: {
          'x-invocation-id': foreign.invocationId,
          'x-callback-token': foreign.callbackToken,
        },
      })
    ).statusCode,
    404,
  );
  const sender = await f.invocations.create(OWNER, 'opus', f.thread.id);
  const before = (await f.messages.getByThread(f.thread.id, 100, OWNER)).length;
  const reply = await f.app.inject({
    method: 'POST',
    url: '/api/callbacks/post-message',
    headers: {
      'x-invocation-id': sender.invocationId,
      'x-callback-token': sender.callbackToken,
    },
    payload: { content: 'Neutral reply attempt', mentions: [], replyTo: receipt.id },
  });
  assert.equal(reply.statusCode, 200, reply.body);
  assert.equal(reply.json().replyTo, undefined, 'the existing callback contract drops an ineligible reference');
  const posted = f.messages.getById(reply.json().messageId);
  assert.equal(posted.replyTo, undefined, 'the readable system receipt still cannot be quoted as a reply parent');
  assert.equal((await f.messages.getByThread(f.thread.id, 100, OWNER)).length, before + 1);
});

const forbidden = [
  [
    'non-Host cat identity',
    (m) => {
      m.catId = 'opus';
    },
  ],
  [
    'wrong system service',
    (m) => {
      m.from = { kind: 'system', service: 'unrelated' };
    },
  ],
  [
    'wrong connector',
    (m) => {
      m.source.connector = 'unrelated';
    },
  ],
  [
    'missing receipt',
    (m) => {
      m.source.meta = {};
    },
  ],
  [
    'unknown producer',
    (m) => {
      m.source.meta.approvalDecisionReceipt.producerId = 'untrusted';
    },
  ],
  [
    'unknown receipt version',
    (m) => {
      m.source.meta.approvalDecisionReceipt.v = 2;
    },
  ],
  [
    'wrong card thread',
    (m) => {
      m.source.meta.approvalDecisionReceipt.approvalCardRef.threadId = 'different-thread';
    },
  ],
  [
    'wrong message thread',
    (m) => {
      m.threadId = 'different-thread';
    },
  ],
  [
    'deleted body',
    (m) => {
      m.deletedAt = 1;
    },
  ],
  [
    'foreign message owner',
    (m) => {
      m.userId = 'foreign-owner';
    },
  ],
  [
    'source parse failure',
    (m) => {
      m.sourceParseFailure = true;
    },
  ],
  [
    'briefing origin',
    (m) => {
      m.origin = 'briefing';
    },
  ],
  [
    'queued body',
    (m) => {
      m.deliveryStatus = 'queued';
    },
  ],
  [
    'canceled body',
    (m) => {
      m.deliveryStatus = 'canceled';
    },
  ],
  [
    'canceled response body',
    (m) => {
      m.deliveryStatus = 'canceled';
      m.lifecycle = { kind: 'response' };
    },
  ],
  [
    'hidden trigger',
    (m) => {
      m.extra = { scheduler: { hiddenTrigger: true } };
    },
  ],
];
for (const [name, corrupt] of forbidden) {
  test(`typed-looking ${name} remains unavailable in both exact modes`, async (t) => {
    const f = await createReceiptReadFixture(t);
    const original = await f.publish();
    const stored = structuredClone(original);
    corrupt(stored);
    const get = f.messages.getById.bind(f.messages);
    f.messages.getById = (id) => (id === stored.id ? stored : get(id));
    for (const mode of ['preview', 'full']) assert.equal((await f.read(stored, mode)).statusCode, 404, name);
    const target = f.messages.append({
      userId: OWNER,
      from: { kind: 'user', userId: OWNER },
      threadId: f.thread.id,
      content: 'Neutral context target',
      mentions: [],
      timestamp: original.timestamp + 1,
    });
    // Legacy/corrupt read projections need not pass the current writer's input validation.
    f.messages.getByThreadBefore = () => [stored];
    f.messages.getByThreadAfter = () => [];
    for (const mode of ['preview', 'full']) {
      const response = await f.app.inject({
        method: 'GET',
        url: `/api/callbacks/get-message?messageId=${target.id}&mode=${mode}&contextCount=1`,
        headers: f.headers,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().context, [], `context also rejects ${name}`);
    }
    assert.equal(f.adoptions(), 0);
  });
}

test('receipt must bind a present, undeleted thread owned by the same user', async (t) => {
  const f = await createReceiptReadFixture(t);
  const receipt = await f.publish();
  for (const field of ['createdBy', 'deletedAt', 'id']) {
    const thread = f.threads.get(f.thread.id);
    const old = thread[field];
    thread[field] = field === 'deletedAt' ? 1 : 'foreign-or-missing';
    assert.equal((await f.read(receipt)).statusCode, 404, field);
    thread[field] = old;
  }
  const getThread = f.threads.get.bind(f.threads);
  f.threads.get = () => null;
  assert.equal((await f.read(receipt)).statusCode, 404, 'missing thread');
  f.threads.get = getThread;
  const deleted = await f.publish('F139');
  await f.messages.softDelete(deleted.id, OWNER);
  assert.equal((await f.read(deleted)).statusCode, 404);
});

test('receipt fails closed when thread ownership cannot be resolved', async (t) => {
  const f = await createReceiptReadFixture(t, { omitThreadStore: true });
  const receipt = await f.publish();
  for (const mode of ['preview', 'full']) assert.equal((await f.read(receipt, mode)).statusCode, 404);
});

test('published receipt full-read also succeeds in its own thread without adopting execution', async (t) => {
  const f = await createReceiptReadFixture(t);
  const receipt = await f.publish();
  const caller = await f.invocations.create(OWNER, 'opus', f.thread.id);
  const response = await f.read(receipt, 'full', {
    headers: {
      'x-invocation-id': caller.invocationId,
      'x-callback-token': caller.callbackToken,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(f.adoptions(), 0);
  assert.deepEqual(f.outbox.list(), []);
});

test('receipt stays subject to play-mode whisper visibility', async (t) => {
  const f = await createReceiptReadFixture(t);
  f.threads.updateThinkingMode(f.thread.id, 'play');
  const receipt = await f.publish();
  const get = f.messages.getById.bind(f.messages);
  f.messages.getById = (id) =>
    id === receipt.id ? { ...receipt, visibility: 'whisper', whisperTo: ['codex61-sol'] } : get(id);
  assert.equal((await f.read(receipt)).statusCode, 404);
  f.messages.getById = (id) =>
    id === receipt.id ? { ...receipt, visibility: 'whisper', whisperTo: ['opus'] } : get(id);
  assert.equal((await f.read(receipt)).statusCode, 200);
});

test('contextCount uses the same receipt admission and keeps generic system/briefing rows hidden', async (t) => {
  const f = await createReceiptReadFixture(t);
  const receipt = await f.publish();
  const target = f.messages.append({
    userId: OWNER,
    from: { kind: 'user', userId: OWNER },
    threadId: f.thread.id,
    content: 'Neutral ordinary target',
    mentions: [],
    timestamp: receipt.timestamp + 1,
  });
  const internal = f.messages.append({
    userId: OWNER,
    from: { kind: 'system', service: 'unrelated' },
    threadId: f.thread.id,
    content: 'Generic internal',
    mentions: [],
    timestamp: receipt.timestamp + 2,
  });
  const briefing = f.messages.append({
    userId: OWNER,
    from: { kind: 'user', userId: OWNER },
    threadId: f.thread.id,
    origin: 'briefing',
    content: 'Internal briefing',
    mentions: [],
    timestamp: receipt.timestamp + 3,
  });
  for (const mode of ['preview', 'full']) {
    const response = await f.app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${target.id}&mode=${mode}&contextCount=10`,
      headers: f.headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    const ids = response.json().context.map((m) => m.id);
    assert.ok(ids.includes(receipt.id), 'published same-owner Host receipt is present as a neighbor');
    assert.ok(!ids.includes(internal.id) && !ids.includes(briefing.id));
  }
});
