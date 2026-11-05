import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCallbackContextFixture } from './helpers/callback-context-fixture.js';

for (const [name, change] of Object.entries({
  'wrong invocation': { invocationId: 'foreign-child' },
  'wrong parent': { parentInvocationId: 'foreign-parent' },
  'wrong tenant': { userId: 'foreign-owner' },
  'wrong thread': { threadId: 'foreign-thread' },
  'wrong target': { catId: 'codex' },
  'terminal invocation': { status: 'succeeded' },
})) {
  test(`full context with ${name} preserves published history but withholds pending body`, async (t) => {
    const f = await createCallbackContextFixture(t);
    const visible = f.publish('published history stays readable');
    const admitted = await f.enqueue('private pending body');
    const original = await f.executions.get(f.auth.invocationId);
    f.executions.get = async () => ({ ...original, ...change });
    const result = await f.read({ readIntent: 'unread' });
    assert.equal(result.statusCode, 200, result.body);
    assert.ok(result.json().messages.some((m) => m.id === visible.id));
    assert.equal(result.body.includes(admitted.message.content), false);
    assert.deepEqual((await f.queue.getDurableEntry(f.threadId, admitted.entry.id)).targets, ['opus', 'codex']);
    assert.equal(f.messages.getById(admitted.message.id).lifecycle?.dispatchRefs?.length ?? 0, 0);
  });
}

test('History commit failure withholds pending body and retains admission for the same exact turn', async (t) => {
  const f = await createCallbackContextFixture(t);
  const admitted = await f.enqueue();
  const commit = f.messages.commitLifecycleAppendAdmission.bind(f.messages);
  f.messages.commitLifecycleAppendAdmission = async () => {
    throw new Error('owned History failure');
  };
  const failed = await f.read();
  assert.equal(failed.statusCode, 503, failed.body);
  assert.equal(failed.body.includes(admitted.message.content), false);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, admitted.entry.id)).targets, ['opus', 'codex']);
  f.messages.commitLifecycleAppendAdmission = commit;
  assert.equal((await f.read()).statusCode, 200);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, admitted.entry.id)).targets, ['codex']);
  assert.equal(f.messages.getById(admitted.message.id).lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
});

async function publishWake(f, caller, content) {
  const from = { kind: 'agent', catId: caller };
  return f.queue.send(
    f.messages,
    {
      userId: f.userId,
      threadId: f.threadId,
      from,
      content,
      mentions: ['opus'],
      timestamp: Date.now(),
    },
    {
      userId: f.userId,
      threadId: f.threadId,
      from,
      content,
      targetCats: ['opus', 'codex'],
      kind: 'message_wake',
      sourceCategory: 'a2a',
      ownerAuthProvenance: 'strict',
      intent: 'execute',
      messageDisposition: 'next_work',
      autoExecute: true,
    },
  );
}

test('full published History covers ordinary next-work wakes together without consuming unpublished conversation', async (t) => {
  const f = await createCallbackContextFixture(t);
  const first = await publishWake(f, 'codex', 'first public request');
  const pending = await f.enqueue('unpublished next conversation', {
    authorIntentByCatId: {},
    messageDisposition: 'next_work',
  });
  const second = await publishWake(f, 'gemini', 'second public request');
  const anchor = await f.read({ responseMode: 'anchor' });
  assert.equal(anchor.statusCode, 200);
  assert.deepEqual(f.messages.getById(f.response.id).lifecycle.inputMessageIds, []);
  const full = await f.read();
  assert.equal(full.statusCode, 200, full.body);
  for (const source of [first.message, second.message]) {
    assert.ok(full.json().messages.some((message) => message.id === source.id && message.content === source.content));
    assert.equal(
      f.messages.getById(source.id).lifecycle.dispatchRefs.find((ref) => ref.targetId === 'opus').statusMessageId,
      f.response.id,
    );
  }
  assert.deepEqual(f.messages.getById(f.response.id).lifecycle.inputMessageIds, [first.message.id, second.message.id]);
  assert.ok(!full.body.includes(pending.message.content));
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, pending.entry.id)).targets, ['opus', 'codex']);
});

test('public coverage storage failure returns no bodies and no partial refs, and the same turn can retry', async (t) => {
  const f = await createCallbackContextFixture(t);
  const first = await publishWake(f, 'codex', 'public first atomic request');
  const second = await publishWake(f, 'gemini', 'public second atomic request');
  const commit = f.messages.commitLifecycleWakeCoverage.bind(f.messages);
  f.messages.commitLifecycleWakeCoverage = async () => {
    throw new Error('owned storage failure');
  };
  const failed = await f.read();
  assert.equal(failed.statusCode, 503, failed.body);
  assert.ok(!failed.body.includes(first.message.content));
  assert.deepEqual(f.messages.getById(f.response.id).lifecycle.inputMessageIds, []);
  for (const source of [first, second])
    assert.deepEqual((await f.queue.getDurableEntry(f.threadId, source.entry.id)).targets, ['opus', 'codex']);
  f.messages.commitLifecycleWakeCoverage = commit;
  assert.equal((await f.read()).statusCode, 200);
  assert.deepEqual(f.messages.getById(f.response.id).lifecycle.inputMessageIds, [first.message.id, second.message.id]);
});

test('full single-message drill covers its actual public neighbors; preview does not', async (t) => {
  const f = await createCallbackContextFixture(t);
  const first = await publishWake(f, 'codex', 'first public drill body');
  const second = await publishWake(f, 'gemini', 'second public drill body');
  const drill = (mode) =>
    f.app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?${new URLSearchParams({ messageId: first.message.id, mode, contextCount: '1' })}`,
      headers: { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken },
    });
  assert.equal((await drill('preview')).statusCode, 200);
  assert.deepEqual(f.messages.getById(f.response.id).lifecycle.inputMessageIds, []);
  const full = await drill('full');
  assert.equal(full.statusCode, 200, full.body);
  assert.ok(full.json().context.some((message) => message.id === second.message.id));
  assert.deepEqual(f.messages.getById(f.response.id).lifecycle.inputMessageIds, [first.message.id, second.message.id]);
});
