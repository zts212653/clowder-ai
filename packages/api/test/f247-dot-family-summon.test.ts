import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { dotProactiveFixture } from './helpers/f247-dot-proactive-fixture.js';

for (const invalidation of ['unsubscribe', 'expire'] as const) {
  test(`an outstanding return is revoked after ${invalidation} for owner and housecat sources`, async () => {
    const f = await dotProactiveFixture();
    let now = Date.now();
    const clock = mock.method(Date, 'now', () => now);
    try {
      const state = (await f.connection.current())!;
      if (invalidation === 'expire')
        await f.connection.subscribe(f.setup.credentialSecret, {
          attemptId: f.setup.attemptId!,
          pairingCode: f.setup.pairingCode!,
          url: state.subscription!.url,
          secret: state.subscription!.secret,
          ttlMs: 1000,
        });
      const thread = f.thread('outstanding returns');
      for (const catId of [null, createCatId('codex61-sol')]) {
        const source = f.messages.append({
          userId: 'owner',
          threadId: thread.id,
          from: catId ? { kind: 'agent', catId } : { kind: 'user', userId: 'owner' },
          content: 'read before invalidation',
          mentions: [],
          timestamp: now,
        });
        assert.equal((await f.deliver(source.id)).kind, 'sent');
        await f.returns.read(f.setup.credentialSecret, f.events.at(-1)!.eventId);
      }
      if (invalidation === 'unsubscribe') {
        await f.connection.unsubscribe(f.setup.credentialSecret, state.subscription!.url, state.attemptId);
      } else now += 1001;
      assert.equal(
        (await f.keys.verify(f.setup.credentialSecret)).ok,
        true,
        'the persistent credential remains valid; subscription authority must close the return',
      );
      for (const event of f.events) {
        await assert.rejects(() => f.returns.read(f.setup.credentialSecret, event.eventId), /source_authority_revoked/);
        await assert.rejects(
          () => f.returns.reply(f.setup.credentialSecret, event.eventId, 'late'),
          /source_authority_revoked/,
        );
        await assert.rejects(
          () =>
            f.returns.admitReturn({
              agentKeyId: state.agentKeyId,
              userId: 'owner',
              threadId: thread.id,
              sourceMessageId: event.data.source_message_id,
              eventId: event.eventId,
              content: 'late callback',
            }),
          /source_authority_revoked/,
        );
      }
      assert.equal(
        (await f.messages.getByThread(thread.id)).filter((message) => message.catId === 'gpt-dot').length,
        0,
      );
    } finally {
      clock.mock.restore();
      await f.close();
    }
  });
}

test('enabled dot accepts ordinary housecat sources and returns to each exact source without a per-cat grant', async () => {
  const f = await dotProactiveFixture();
  try {
    const thread = f.thread('family collaboration');
    for (const catId of ['codex61-sol', 'sonnet']) {
      const source = f.messages.append({
        userId: 'owner',
        threadId: thread.id,
        from: { kind: 'agent', catId: createCatId(catId) },
        content: '@dot 请看这条来源',
        mentions: [createCatId('gpt-dot')],
        timestamp: Date.now(),
      });
      assert.equal((await f.deliver(source.id)).kind, 'sent');
      const event = f.events.at(-1)!;
      assert.equal((await f.returns.read(f.setup.credentialSecret, event.eventId)).source.id, source.id);
      const result = await f.returns.reply(f.setup.credentialSecret, event.eventId, `回复 ${catId}`);
      const reply = f.messages.getById(result.messageId)!;
      assert.equal(reply.replyTo, source.id);
      assert.equal(reply.threadId, thread.id);
      assert.equal(reply.catId, 'gpt-dot');
    }
    assert.equal(f.events.length, 2);
    f.disable();
    await assert.rejects(() => f.returns.read(f.setup.credentialSecret, f.events[0]!.eventId), /dot_disabled/);
  } finally {
    await f.close();
  }
});

test('ordinary housecat access retains owner, thread, self-loop and plugin-disable boundaries', async () => {
  const f = await dotProactiveFixture();
  try {
    const thread = f.thread('owned');
    const foreignThread = f.thread('foreign', 'other');
    for (const { catId, ...input } of [
      { userId: 'other', threadId: thread.id, catId: 'codex61-sol' },
      { userId: 'owner', threadId: foreignThread.id, catId: 'sonnet' },
      { userId: 'owner', threadId: thread.id, catId: 'gpt-dot' },
    ]) {
      const source = f.messages.append({
        ...input,
        from: { kind: 'agent', catId: createCatId(catId) },
        content: 'invalid scope',
        mentions: [],
        timestamp: Date.now(),
      });
      assert.equal((await f.deliver(source.id)).kind, 'fallback');
    }
    f.disable();
    const source = f.messages.append({
      userId: 'owner',
      threadId: thread.id,
      from: { kind: 'agent', catId: createCatId('sonnet') },
      content: 'disabled',
      mentions: [],
      timestamp: Date.now(),
    });
    assert.equal((await f.deliver(source.id)).kind, 'fallback');
    assert.equal(f.events.length, 0);
  } finally {
    await f.close();
  }
});
