import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { dotProactiveFixture as fixture } from './helpers/f247-dot-proactive-fixture.js';

test('same shared connection asks as dot; canonical Queue returns actual local replies to the original subscription', async () => {
  const f = await fixture();
  try {
    const a = f.thread('A');
    const b = f.thread('B');
    const viaRemote = (t: string, key: string) =>
      f.remote.rpc('tools/call', {
        name: 'cat_cafe_dot_ask',
        arguments: {
          attempt_id: f.setup.attemptId,
          thread_id: t,
          target_cat_ids: ['codex'],
          content: '请回答这一问',
          client_message_id: key,
        },
      });
    const [ra, rb] = await Promise.all([viaRemote(a.id, 'A'), viaRemote(b.id, 'B')]);
    assert.equal(ra.error, undefined, JSON.stringify(ra));
    assert.equal(rb.error, undefined, JSON.stringify(rb));
    const roots = [ra, rb].map((r) => f.messages.getById(r.result.structuredContent.messageId)!);
    assert.ok(roots.every((root) => root.catId === 'gpt-dot' && root.extra?.dotAsk));
    for (const root of roots)
      assert.ok(
        f.queue
          .list(root.threadId, 'owner')
          .some((e) => e.from.kind === 'agent' && e.from.catId === 'gpt-dot' && e.payload.messageId === root.id),
      );
    const replies = await Promise.all(roots.map((root) => f.reply(root.id, root.threadId, 'codex', undefined, true)));
    for (const r of replies) {
      assert.deepEqual(r.mentions, ['gpt-dot'], 'explicit reply target uses the canonical Queue');
      assert.ok(
        f.queue.list(r.threadId, 'owner').some((e) => e.targets.includes('gpt-dot') && e.payload.messageId === r.id),
      );
      assert.equal((await f.deliver(r.id)).kind, 'sent');
      assert.equal((await f.deliver(r.id)).kind, 'sent');
    }
    assert.equal(f.events.length, 2);
    assert.deepEqual(new Set(f.events.map((e) => e.data.thread_id)), new Set([a.id, b.id]));
    for (const event of f.events)
      assert.equal(
        (await f.returns.read(f.setup.credentialSecret, event.eventId)).source.id,
        event.data.source_message_id,
      );
  } finally {
    await f.close();
  }
});

test('owner replies to a dot question through ordinary summon authority and dot can read the delivered source', async () => {
  const f = await fixture();
  try {
    const thread = f.thread('owner reply');
    const request = await f.ask(thread.id);
    const rootId = request.result.structuredContent.messageId as string;
    const source = f.messages.append({
      userId: 'owner',
      threadId: thread.id,
      from: { kind: 'user', userId: 'owner' },
      replyTo: rootId,
      content: '@dot 补充一点背景',
      mentions: [createCatId('gpt-dot')],
      timestamp: Date.now(),
    });
    assert.equal((await f.deliver(source.id)).kind, 'sent');
    assert.equal(f.events.length, 1);
    assert.equal((await f.returns.read(f.setup.credentialSecret, f.events[0].eventId)).source.id, source.id);
  } finally {
    await f.close();
  }
});

test('durable dot request key survives retries, conflicts across threads, and rejects caller identity overrides', async () => {
  const f = await fixture();
  try {
    const a = f.thread('A');
    const b = f.thread('B');
    const results = await Promise.all([f.ask(a.id), f.ask(a.id)]);
    assert.ok(
      results.every((r) => r.result),
      JSON.stringify(results),
    );
    assert.equal(results[0].result.structuredContent.messageId, results[1].result.structuredContent.messageId);
    assert.equal((await f.ask(a.id)).result.structuredContent.messageId, results[0].result.structuredContent.messageId);
    for (const conflict of [await f.ask(a.id, 'request', '变了'), await f.ask(b.id)])
      assert.equal(conflict.error.data.reason, 'dot_ask_idempotency_conflict');
    assert.equal((await f.ask(f.thread('other', 'other').id, 'other')).error.data.reason, 'dot_ask_thread_rejected');
    const args = {
      attempt_id: f.setup.attemptId,
      thread_id: a.id,
      target_cat_ids: ['codex'],
      content: 'x',
      client_message_id: 'x',
    };
    for (const field of ['author', 'catId', 'owner', 'subscription_id', 'replyTo', 'proactive'])
      assert.ok((await f.rpc({ ...args, [field]: 'forged' })).error);
    const generic = await f.app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': f.setup.credentialSecret },
      payload: { threadId: a.id, content: '伪造主动准入', targetCats: ['codex'] },
    });
    assert.equal(generic.statusCode, 403);
    f.disable();
    assert.equal((await f.ask(a.id, 'disabled')).error.data.reason, 'dot_disabled');
  } finally {
    await f.close();
  }
});

test('replyTo alone, unrelated executions, non-recipients, and stale subscriptions cannot forward a reply', async () => {
  const f = await fixture();
  try {
    const a = f.thread('A');
    const r = await f.ask(a.id);
    assert.ok(r.result, JSON.stringify(r));
    const root = r.result.structuredContent.messageId as string;
    const unrelated = f.messages.append({
      userId: 'owner',
      threadId: a.id,
      from: { kind: 'user', userId: 'owner' },
      content: 'other',
      mentions: [],
      timestamp: Date.now(),
    });
    const wrongExecution = await f.reply(unrelated.id, a.id, 'codex', root);
    const nonrecipient = await f.reply(root, a.id, 'sonnet');
    for (const source of [wrongExecution, nonrecipient]) assert.notEqual((await f.deliver(source.id)).kind, 'sent');
    const actual = await f.reply(root, a.id);
    await f.connection.begin('owner', true);
    assert.notEqual((await f.deliver(actual.id)).kind, 'sent');
    assert.equal(f.events.length, 0);
  } finally {
    await f.close();
  }
});

test('a removed exact input binding or withdrawn source cannot authorize a consultation reply', async () => {
  const f = await fixture();
  try {
    const thread = f.thread('withdrawn');
    const rootId = (await f.ask(thread.id)).result.structuredContent.messageId;
    const answer = await f.reply(rootId, thread.id, 'codex', undefined, true);
    const root = f.messages.getById(rootId)!;
    const ref = root.lifecycle!.dispatchRefs![0];
    const response = f.messages.getById(ref.statusMessageId)!;
    assert.equal(response.lifecycle?.kind, 'response');
    if (response.lifecycle?.kind !== 'response') throw Error('response missing');
    response.lifecycle.inputMessageIds = [];
    assert.notEqual((await f.deliver(answer.id)).kind, 'sent', 'a rejected Append loses exact reply authority');
    response.lifecycle.inputMessageIds = [rootId];
    root.deletedAt = Date.now();
    assert.notEqual((await f.deliver(answer.id)).kind, 'sent', 'a withdrawn source cannot grant a reply');
    delete root.deletedAt;
    assert.equal((await f.deliver(answer.id)).kind, 'sent');
  } finally {
    await f.close();
  }
});

test('terminal exact response retains reply authority after its Queue row retires', async () => {
  const f = await fixture();
  try {
    const thread = f.thread('completed');
    const rootId = (await f.ask(thread.id)).result.structuredContent.messageId;
    const answer = await f.reply(rootId, thread.id, 'codex', undefined, true);
    const root = f.messages.getById(rootId)!;
    const response = f.messages.getById(root.lifecycle!.dispatchRefs![0].statusMessageId)!;
    if (response.lifecycle?.kind !== 'response') throw Error('response missing');
    assert.equal(
      f.messages.commitLifecycleResponseTerminal(response.id, {
        invocationId: response.lifecycle.invocationId,
        status: 'completed',
        completedAt: Date.now(),
        content: 'complete',
        mentions: [],
        origin: 'stream',
      }).kind,
      'applied',
    );
    const row = f.queue.list(thread.id, 'owner').find((e) => e.payload.messageId === rootId)!;
    await f.queue.terminalizeEntryDurable(thread.id, 'owner', row.id);
    assert.equal((await f.deliver(answer.id)).kind, 'sent');
    const replay = await f.ask(thread.id);
    assert.equal(replay.result.structuredContent.messageId, rootId);
    assert.ok(!f.queue.list(thread.id, 'owner').some((e) => e.payload.messageId === rootId));
  } finally {
    await f.close();
  }
});

test('ordinary callback speech stays visible; only an explicit callback target returns to dot', async () => {
  const f = await fixture();
  try {
    const thread = f.thread('progress');
    const request = await f.ask(thread.id);
    const rootId = request.result.structuredContent.messageId as string;
    const progress = await f.reply(rootId, thread.id, 'codex', undefined, false, false);
    assert.equal(progress.extra?.isExplicitPost, true);
    assert.deepEqual(progress.mentions, [], 'ordinary progress must not wake dot');
    assert.ok(!f.queue.list(thread.id, 'owner').some((e) => e.targets.includes('gpt-dot')));
    const final = await f.reply(rootId, thread.id, 'codex', undefined, true);
    assert.deepEqual(final.mentions, ['gpt-dot']);
    assert.equal((await f.deliver(final.id)).kind, 'sent');
    assert.equal(f.events.length, 1);
  } finally {
    await f.close();
  }
});

test('atomic admission failure leaves no partial question and same-key retry admits once', async () => {
  const f = await fixture();
  const send = f.queue.send.bind(f.queue);
  let blocked = true;
  f.queue.send = async (...args) => {
    if (blocked) throw Error('fixture admission unavailable');
    return send(...args);
  };
  try {
    const thread = f.thread('atomic failure');
    for (let i = 0; i < 2; i++) {
      assert.equal((await f.ask(thread.id)).error.data.reason, 'dot_ask_delivery_pending');
      assert.equal(f.queue.list(thread.id, 'owner').length, 0);
      assert.equal(f.messages.getByThread(thread.id, 100, 'owner').length, 0);
    }
    blocked = false;
    const root = (await f.ask(thread.id)).result.structuredContent.messageId;
    assert.equal((await f.ask(thread.id)).result.structuredContent.messageId, root);
    assert.equal(f.queue.list(thread.id, 'owner').length, 1);
  } finally {
    await f.close();
  }
});
