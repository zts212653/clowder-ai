import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createCallbackContextFixture } from './helpers/callback-context-fixture.js';

for (const kind of ['conversation_input', 'message_wake']) {
  test(`issue1890 full context captures the live prefix for ${kind}, not the empty stored response`, async (t) => {
    const f = await createCallbackContextFixture(t);
    // The in-memory fixture starts with example prose; production precreates R empty.
    f.response.content = '';
    let content = '  Initial analysis\n\n';
    const prefix = content.trimStart();
    const release = f.tracker.bindLifecycleOutputCursor(
      f.threadId,
      'opus',
      {
        invocationId: f.auth.invocationId,
        responseMessageId: f.response.id,
      },
      () => content,
    );
    t.after(() => release?.());
    assert.equal(f.messages.getById(f.response.id).content, '');
    const source =
      kind === 'message_wake' ? await publishWake(f, 'codex', 'reviewer request') : await f.enqueue('reviewer request');
    const read = await f.read();
    assert.equal(read.statusCode, 200, read.body);
    const expected = [
      {
        inputMessageId: source.message.id,
        contentOffset: prefix.length,
        prefixSha256: createHash('sha256').update(prefix).digest('hex'),
      },
    ];
    assert.deepEqual(f.messages.getById(f.response.id).lifecycle.appendBoundaries, expected);
    content += 'review acknowledged';
    assert.equal((await f.read()).statusCode, 200);
    assert.deepEqual(f.messages.getById(f.response.id).lifecycle.appendBoundaries, expected);
    assert.equal(
      f.messages.getById(source.message.id).lifecycle.dispatchRefs.find((ref) => ref.targetId === 'opus')
        .statusMessageId,
      f.response.id,
    );

    const terminal = f.messages.commitLifecycleResponseTerminal(f.response.id, {
      invocationId: f.auth.invocationId,
      status: 'completed',
      completedAt: Date.now(),
      content,
      mentions: [],
      origin: 'stream',
    });
    assert.ok(terminal.kind === 'applied' || terminal.kind === 'replayed', JSON.stringify(terminal));
    const stored = f.messages.getById(f.response.id);
    assert.equal(stored.content, content);
    assert.deepEqual(stored.lifecycle.appendBoundaries, expected);

    const fullRead = await f.read();
    assert.equal(fullRead.statusCode, 200, fullRead.body);
    const projections = fullRead.json().messages;
    const responseProjection = projections.find((message) => message.id === f.response.id);
    const sourceProjection = projections.find((message) => message.id === source.message.id);
    assert.ok(responseProjection, 'the member must receive the canonical R exactly once');
    assert.equal(projections.filter((message) => message.id === f.response.id).length, 1);
    assert.equal(responseProjection.content, content);
    assert.deepEqual(responseProjection.inputMessageIds, [source.message.id]);
    assert.deepEqual(responseProjection.appendBoundaries, expected);
    assert.equal(responseProjection.appendBoundarySemantics, 'host_observed_display_range');
    assert.equal('contentSlices' in responseProjection, false);
    assert.equal('continuationSlices' in responseProjection, false);
    assert.ok(sourceProjection, 'the member must receive the adopted source');
    const sourceRefs = sourceProjection.dispatchRefs ?? [];
    assert.ok(sourceRefs.some((ref) => ref.targetId === 'opus' && ref.statusMessageId === f.response.id));
    assert.equal(
      sourceRefs.some((ref) => ref.targetId === 'codex'),
      false,
    );

    const drill = await f.app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${f.response.id}&mode=full`,
      headers: { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken },
    });
    assert.equal(drill.statusCode, 200, drill.body);
    const drillMessage = drill.json().message;
    assert.deepEqual(drillMessage.inputMessageIds, responseProjection.inputMessageIds);
    assert.deepEqual(drillMessage.appendBoundaries, responseProjection.appendBoundaries);
    assert.equal(drillMessage.appendBoundarySemantics, responseProjection.appendBoundarySemantics);
    const sourceDrill = await f.app.inject({
      method: 'GET',
      url: `/api/callbacks/get-message?messageId=${source.message.id}&mode=full`,
      headers: { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken },
    });
    assert.equal(sourceDrill.statusCode, 200, sourceDrill.body);
    assert.deepEqual(sourceDrill.json().message.dispatchRefs, sourceProjection.dispatchRefs);

    const replayed = await f.read();
    assert.equal(replayed.statusCode, 200, replayed.body);
    assert.deepEqual(f.messages.getById(f.response.id).lifecycle.appendBoundaries, expected);
  });
}

test('a watcher reads published originals without adopting work input or advancing its member seen cursor', async (t) => {
  const f = await createCallbackContextFixture(t, { executionKind: 'watcher' });
  const visible = f.publish('published original for the observer');
  const admitted = await f.enqueue('pending body belongs to the working member');
  const publicWake = await publishWake(f, 'codex', 'published request belongs to the working member');
  const before = await f.cursors.getSeenCursor(f.userId, 'opus', f.threadId);
  const response = await f.read();
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(response.json().messages.some((message) => message.id === visible.id));
  assert.equal(response.body.includes(admitted.message.content), false);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, admitted.entry.id)).targets, ['opus', 'codex']);
  assert.equal(await f.cursors.getSeenCursor(f.userId, 'opus', f.threadId), before);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, publicWake.entry.id)).targets, ['opus', 'codex']);
  const drill = await f.app.inject({
    method: 'GET',
    url: `/api/callbacks/get-message?messageId=${admitted.message.id}&mode=full`,
    headers: { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken },
  });
  assert.equal(drill.statusCode, 404, drill.body);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, admitted.entry.id)).targets, ['opus', 'codex']);
  const publishedDrill = await f.app.inject({
    method: 'GET',
    url: `/api/callbacks/get-message?messageId=${publicWake.message.id}&mode=full`,
    headers: { 'x-invocation-id': f.auth.invocationId, 'x-callback-token': f.auth.callbackToken },
  });
  assert.equal(publishedDrill.statusCode, 200, publishedDrill.body);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, publicWake.entry.id)).targets, ['opus', 'codex']);
});

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
  f.response.content = '';
  const content = '  history prefix\n\n';
  const prefix = content.trimStart();
  const release = f.tracker.bindLifecycleOutputCursor(
    f.threadId,
    'opus',
    { invocationId: f.auth.invocationId, responseMessageId: f.response.id },
    () => content,
  );
  t.after(() => release?.());
  const admitted = await f.enqueue();
  const commit = f.messages.commitLifecycleAppendAdmission.bind(f.messages);
  f.messages.commitLifecycleAppendAdmission = async () => {
    throw new Error('owned History failure');
  };
  const failed = await f.read();
  assert.equal(failed.statusCode, 503, failed.body);
  assert.equal(failed.body.includes(admitted.message.content), false);
  assert.equal((f.messages.getById(f.response.id).lifecycle.appendBoundaries ?? []).length, 0);
  assert.deepEqual(f.messages.getById(admitted.message.id).lifecycle?.dispatchRefs ?? [], []);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, admitted.entry.id)).targets, ['opus', 'codex']);
  f.messages.commitLifecycleAppendAdmission = commit;
  assert.equal((await f.read()).statusCode, 200);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, admitted.entry.id)).targets, ['codex']);
  assert.deepEqual(f.messages.getById(f.response.id).lifecycle.appendBoundaries, [
    {
      inputMessageId: admitted.message.id,
      contentOffset: prefix.length,
      prefixSha256: createHash('sha256').update(prefix).digest('hex'),
    },
  ]);
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
  f.response.content = '';
  const content = '  coverage prefix\n\n';
  const prefix = content.trimStart();
  const release = f.tracker.bindLifecycleOutputCursor(
    f.threadId,
    'opus',
    { invocationId: f.auth.invocationId, responseMessageId: f.response.id },
    () => content,
  );
  t.after(() => release?.());
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
  assert.equal((f.messages.getById(f.response.id).lifecycle.appendBoundaries ?? []).length, 0);
  for (const source of [first, second]) {
    assert.deepEqual(f.messages.getById(source.message.id).lifecycle?.dispatchRefs ?? [], []);
    assert.deepEqual((await f.queue.getDurableEntry(f.threadId, source.entry.id)).targets, ['opus', 'codex']);
  }
  f.messages.commitLifecycleWakeCoverage = commit;
  assert.equal((await f.read()).statusCode, 200);
  assert.deepEqual(f.messages.getById(f.response.id).lifecycle.inputMessageIds, [first.message.id, second.message.id]);
  const boundaries = f.messages.getById(f.response.id).lifecycle.appendBoundaries ?? [];
  assert.equal(boundaries.length, 2);
  assert.deepEqual(
    boundaries.map((boundary) => boundary.inputMessageId),
    [first.message.id, second.message.id],
  );
  for (const source of [first, second])
    assert.equal(
      f.messages.getById(source.message.id).lifecycle.dispatchRefs.find((ref) => ref.targetId === 'opus')
        .statusMessageId,
      f.response.id,
    );
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
