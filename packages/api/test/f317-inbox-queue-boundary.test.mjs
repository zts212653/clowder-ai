import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cursorFor } from '../src/domains/cats/services/stores/cursor.ts';
import { LiveInbox } from '../src/domains/concierge/live/inbox/LiveInbox.ts';
import {
  assertDeliveredLiveSource as delivered,
  createCanonicalLiveSourceFixture as fixture,
  assertPendingLiveSource as pending,
} from './helpers/1398-live-source-fixture.mjs';

test('idle next-work yields to ordinary Queue without exposing or acquiring a body', async (t) => {
  const f = await fixture({ requested: 'next_work' });
  t.after(f.close);
  assert.deepEqual(f.queue.getQueuedBodyMessagesForCat('home', 'owner', 'codex-astra', 'live-parent'), []);
  const hidden = await f.read('&readIntent=unread');
  assert.equal(hidden.statusCode, 200, hidden.body);
  assert.equal(
    hidden.json().messages.some((message) => message.id === f.message.id),
    false,
  );
  assert.equal((await f.read('&messageId=' + f.message.id)).statusCode, 404);
  const idle = await f.inbox.atBoundary({ kind: 'idle', generation: 1, userSpeaking: false });
  assert.equal(idle.kind, 'successor_required');
  assert.deepEqual(
    idle.successorSources.map((item) => [item.messageId, item.queueEntryId]),
    [[f.message.id, f.entry.id]],
  );
  assert.equal(
    (await f.inbox.atBoundary({ kind: 'idle', generation: 1, userSpeaking: false })).kind,
    'successor_required',
  );
  assert.equal(f.deliveries.length, 0);
  await pending(f);
  assert.equal(f.queue.peekNextQueued('home', 'owner').id, f.entry.id);
});

for (const row of [
  { name: 'user without exact append permission', readable: false },
  {
    name: 'wrong parent',
    intent: { requested: 'continue_current', boundParentInvocationId: 'other' },
    readable: false,
  },
  {
    name: 'fallback to next work',
    intent: {
      requested: 'continue_current',
      boundParentInvocationId: 'live-parent',
      fallbackAt: 10,
      fallbackReason: 'parent_terminal_before_exposure',
    },
    readable: false,
  },
  {
    name: 'exact parent',
    intent: { requested: 'continue_current', boundParentInvocationId: 'live-parent' },
    readable: true,
  },
  {
    name: 'connector ignores user-shaped intent',
    source: 'connector',
    intent: { requested: 'next_work' },
    readable: true,
  },
])
  test('C0 and the real full-read route share source permission: ' + row.name, async (t) => {
    const f = await fixture(row.intent, row.source);
    t.after(f.close);
    const boundary = { kind: 'tool_complete', generation: 1, userSpeaking: false };
    await f.inbox.atBoundary(boundary);
    assert.equal(f.deliveries.length, row.readable ? 1 : 0);
    assert.equal(JSON.stringify(f.deliveries).includes('actual queued body'), false);
    await pending(f); // a reference notification grants neither delivery nor completion
    const response = await f.read('&readIntent=unread');
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(
      response.json().messages.some((message) => message.id === f.message.id && message.content === f.message.content),
      row.readable,
    );
    if (row.readable) await delivered(f);
    else {
      await pending(f);
      assert.equal((await f.inbox.atBoundary({ ...boundary, kind: 'idle' })).kind, 'successor_required');
    }
  });

test('an accepted reference cannot conceal a durable fallback to ordinary successor work', async (t) => {
  const f = await fixture({ requested: 'continue_current', boundParentInvocationId: 'live-parent' });
  t.after(f.close);
  assert.equal(
    (await f.inbox.atBoundary({ kind: 'tool_complete', generation: 1, userSpeaking: false })).kind,
    'accepted',
  );
  assert.equal(
    await f.queue.fallbackQueuedAuthorIntentDurable(
      'home',
      'owner',
      f.entry.id,
      'codex-astra',
      'parent_terminal_before_exposure',
    ),
    true,
  );
  const blocked = await f.read('&readIntent=unread');
  assert.equal(blocked.statusCode, 200, blocked.body);
  assert.equal(
    blocked.json().messages.some((message) => message.id === f.message.id),
    false,
  );
  const idle = await f.inbox.atBoundary({ kind: 'idle', generation: 1, userSpeaking: false });
  assert.equal(idle.kind, 'successor_required');
  assert.equal(idle.successorSources[0].messageId, f.message.id);
  assert.equal(f.deliveries.length, 1, 'fallback must not manufacture another accepted notification');
  await pending(f);
});

for (const source of ['user', 'agent'])
  test('delivered History behind the seen cursor never resurrects Queue work: ' + source, async (t) => {
    const f = await fixture({ requested: 'continue_current', boundParentInvocationId: 'live-parent' }, source);
    t.after(f.close);
    const body = await f.read('&readIntent=unread');
    assert.equal(body.statusCode, 200, body.body);
    assert.ok(
      body.json().messages.some((message) => message.id === f.message.id && message.content === f.message.content),
    );
    await delivered(f);
    const later = f.store.append({
      userId: 'owner',
      threadId: 'home',
      from: { kind: 'agent', catId: 'opus' },
      content: 'later published speech',
      mentions: [],
      timestamp: Date.now(),
    });
    const cursor = cursorFor({ id: later.id, visibilitySeq: f.store.getVisibilitySeq(later.id) });
    await f.cursorStore.ackSeenCursor('owner', 'codex-astra', 'home', cursor);
    const before = structuredClone(await f.queue.getDurableEntry('home', f.entry.id));
    const sparse = await f.read('&messageId=' + f.message.id);
    assert.equal(sparse.statusCode, 200, sparse.body);
    assert.equal(sparse.json().messages.find((message) => message.id === f.message.id)?.content, f.message.content);
    assert.equal(await f.cursorStore.getSeenCursor('owner', 'codex-astra', 'home'), cursor);
    assert.deepEqual(await f.queue.getDurableEntry('home', f.entry.id), before);
    for (const child of [f.scope.invocationId, 'new-child']) {
      const replay = new LiveInbox({
        scope: { ...f.scope, invocationId: child, generation: 2 },
        source: f.inboxSource,
        wake() {},
        deliver: async () => {
          assert.fail('delivered History cannot re-notify or replay');
        },
      });
      t.after(() => replay.close());
      const result = await replay.atBoundary({ kind: 'tool_complete', generation: 2, userSpeaking: false });
      assert.notEqual(result.kind, 'accepted');
    }
    await delivered(f);
  });
