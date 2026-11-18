import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCallbackContextFixture } from './helpers/callback-context-fixture.js';

async function addAuthCard(f, invocationId, { panel = true, status = 'canceled', reason = 'canceled' } = {}) {
  await f.executions.createRunning({
    invocationId,
    parentInvocationId: 'watcher-parent',
    userId: f.userId,
    threadId: f.threadId,
    catId: 'codex',
    executionKind: panel ? 'watcher' : 'ordinary',
    ...(panel ? { causal: { watcherPanelRoundId: 'round-private' } } : {}),
    startedAt: Date.now(),
  });
  await f.executions.transitionTerminal(invocationId, {
    status,
    endedAt: Date.now(),
    terminalReason: status === 'canceled' ? 'user_cancel' : 'provider_failed',
  });
  return f.messages.append({
    userId: f.userId,
    threadId: f.threadId,
    from: { kind: 'system', service: 'callback-auth' },
    content: `[callback-auth] thread-context → ${reason}`,
    mentions: [],
    timestamp: Date.now(),
    source: { connector: 'callback-auth', label: 'Callback Auth', icon: 'legacy' },
    extra: {
      rich: {
        v: 1,
        blocks: [
          {
            v: 1,
            id: invocationId,
            kind: 'card',
            title: 'Callback Auth Failure',
            fields: [{ label: 'Cat', value: 'codex' }],
            meta: {
              kind: 'callback_auth_failure',
              invocationId,
              catId: 'codex',
              userId: f.userId,
              threadId: f.threadId,
              reason,
            },
          },
        ],
      },
    },
  });
}

test('cat history and exact drills hide old watcher cards without losing ordinary warnings or stored originals', async (t) => {
  const f = await createCallbackContextFixture(t);
  const ordinary = await addAuthCard(f, 'ordinary-auth', { panel: false });
  const first = await f.publish('first visible');
  const canceled = await addAuthCard(f, 'private-canceled');
  const last = await f.publish('last visible');
  const failed = await addAuthCard(f, 'private-failed', { status: 'failed', reason: 'invalid_token' });
  for (const responseMode of ['anchor', 'full']) {
    const response = await f.read({ responseMode, limit: '3' });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      response.json().messages.map((row) => row.id),
      [ordinary.id, first.id, last.id],
    );
    for (const hidden of [canceled, failed]) {
      const targeted = await f.read({ responseMode, messageId: hidden.id, before: '0', after: '0' });
      assert.equal(targeted.statusCode, 404);
    }
  }
  const headers = { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken };
  for (const mode of ['preview', 'full']) {
    for (const hidden of [canceled, failed]) {
      const response = await f.app.inject({
        url: `/api/callbacks/get-message?messageId=${hidden.id}&mode=${mode}`,
        headers,
      });
      assert.equal(response.statusCode, 404, response.body);
    }
  }
  const context = await f.app.inject({
    url: `/api/callbacks/get-message?messageId=${first.id}&mode=full&contextCount=2`,
    headers,
  });
  assert.equal(context.statusCode, 200, context.body);
  assert.ok(context.json().context.some((row) => row.id === last.id));
  assert.ok(context.json().context.every((row) => row.id !== canceled.id && row.id !== failed.id));
  const keyword = await f.read({ responseMode: 'full', keyword: 'callback-auth', limit: '3' });
  assert.deepEqual(
    keyword.json().messages.map((row) => row.id),
    [ordinary.id],
  );
  const window = await f.read({ responseMode: 'full', messageId: first.id, before: '1', after: '1' });
  assert.deepEqual(
    window.json().messages.map((row) => row.id),
    [ordinary.id, first.id, last.id],
  );
  assert.equal((await f.messages.getById(canceled.id)).extra.rich.blocks[0].meta.catId, 'codex');
  const getExecution = f.executions.get.bind(f.executions);
  f.executions.get = async (id) => {
    if (id === 'private-canceled' || id === 'private-failed')
      throw new Error('diagnostic lookup temporarily unavailable');
    return getExecution(id);
  };
  const unknown = await f.read({ limit: '3' });
  assert.equal(unknown.statusCode, 200, unknown.body);
  assert.ok(unknown.json().messages.every((row) => row.id !== canceled.id && row.id !== failed.id));
  assert.ok(unknown.json().messages.some((row) => row.id === first.id));
});

test('cat recent and unread pagination cross batches of hidden watcher diagnostics', async (t) => {
  const f = await createCallbackContextFixture(t);
  const first = await f.publish('before old watcher diagnostics');
  for (let i = 0; i < 55; i++) await addAuthCard(f, `old-private-${i}`);
  const last = await f.publish('after old watcher diagnostics');
  const unread = await f.read({ readIntent: 'unread', limit: '1' });
  assert.equal(unread.statusCode, 200, unread.body);
  assert.equal(unread.json().messages[0].id, first.id);
  assert.equal(unread.json().hasMore, true);
  const next = await f.read({ readIntent: 'unread', limit: '1', cursor: unread.json().nextCursor });
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().messages[0].id, last.id);
  assert.equal(next.json().hasMore, false);
  const recent = await f.read({ limit: '2' });
  assert.equal(recent.statusCode, 200, recent.body);
  assert.deepEqual(
    recent.json().messages.map((row) => row.id),
    [first.id, last.id],
  );
});
