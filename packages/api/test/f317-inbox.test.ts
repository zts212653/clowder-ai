import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { LiveInbox } from '../src/domains/concierge/live/inbox/LiveInbox.js';
import type {
  LiveInboxBatch,
  LiveInboxReference,
  LiveInboxScope,
  LiveInboxSource,
} from '../src/domains/concierge/live/inbox/live-inbox-contract.js';

const scope: LiveInboxScope = {
  userId: 'owner',
  threadId: 'home',
  catId: createCatId('codex-astra'),
  invocationId: 'child-1',
  callId: 'call-1',
  generation: 1,
};
const boundary = { kind: 'idle' as const, generation: 1, userSpeaking: false };
function reference(
  index: number,
  lane = 'one',
  priority: LiveInboxReference['priority'] = 'normal',
): LiveInboxReference {
  return {
    messageId: `m-${index}`,
    queueEntryId: `entry-${index}`,
    threadId: 'home',
    sourceThreadId: lane,
    authorCatId: lane,
    targetCatId: scope.catId,
    order: String(index).padStart(6, '0'),
    priority,
    nextWork: false,
    facts: {
      persisted: true,
      notified: false,
      readByInvocationIds: [],
      readInCurrentContext: false,
      handled: false,
      playback: 'unknown',
    },
  };
}
class Source implements LiveInboxSource {
  rows: LiveInboxReference[] = [];
  pages = 0;
  async page(_scope: LiveInboxScope, cursor: string | undefined, limit: number) {
    this.pages++;
    const offset = Number(cursor ?? 0);
    const items = this.rows.slice(offset, offset + limit);
    const hasMore = offset + items.length < this.rows.length;
    return { items, hasMore, nextCursor: String(offset + items.length) };
  }
  async read(_scope: LiveInboxScope, id: string) {
    return this.rows.find((row) => row.messageId === id) ?? null;
  }
}
function fixture(rows: LiveInboxReference[], deliver?: (batch: LiveInboxBatch) => Promise<'accepted' | 'busy'>) {
  const source = new Source();
  source.rows = rows;
  const batches: LiveInboxBatch[] = [];
  let wakes = 0;
  const inbox = new LiveInbox({
    scope,
    source,
    capacity: 32,
    batchSize: 10,
    pageSize: 16,
    wake: () => {
      wakes++;
    },
    deliver: async (batch) => {
      batches.push(batch);
      return deliver ? deliver(batch) : 'accepted';
    },
  });
  return { inbox, source, batches, wakes: () => wakes };
}

test('ten concurrent arrivals wake once and reach a safe boundary, with no body or invented read/handled fact', async () => {
  const f = fixture(Array.from({ length: 10 }, (_, i) => reference(i, `lane-${i}`)));
  await Promise.all(Array.from({ length: 10 }, async () => f.inbox.signal()));
  assert.equal(f.wakes(), 1);
  assert.equal(f.batches.length, 0, 'long tool execution must not be interrupted by ordinary results');
  await f.inbox.atBoundary({ ...boundary, kind: 'tool_complete' });
  assert.equal(f.batches[0]?.references.length, 10);
  assert.equal(f.batches[0]?.notice.includes('responseMode'), true);
  assert.ok(f.batches[0].references.every((row) => !row.facts.handled && row.facts.readByInvocationIds.length === 0));
  await f.inbox.atBoundary(boundary);
  assert.equal(f.batches.length, 1, 'unread accepted notification is retained, not delivered every boundary');
});

test('duplicate and out-of-order events select each exact source once in canonical order', async () => {
  const row = reference(3);
  const f = fixture([row, reference(1), row, reference(2)]);
  f.inbox.signal();
  await f.inbox.atBoundary(boundary);
  assert.deepEqual(
    f.batches.flatMap((batch) => batch.references.map((item) => item.messageId)),
    ['m-1', 'm-2', 'm-3'],
  );
});

test('user speech, wrong generation and next-work intent cannot steal an active boundary', async () => {
  const f = fixture([{ ...reference(1), nextWork: true }]);
  f.inbox.signal();
  await f.inbox.atBoundary({ ...boundary, userSpeaking: true });
  await f.inbox.atBoundary({ ...boundary, generation: 2 });
  await f.inbox.atBoundary({ ...boundary, kind: 'tool_complete' });
  assert.equal(f.batches.length, 0);
  assert.equal((await f.inbox.atBoundary(boundary)).kind, 'successor_required');
  assert.equal(f.batches.length, 0);
});

test('interrupt aborts the in-flight publication; a late accept cannot consume its retry', async () => {
  let finish!: (value: 'accepted') => void;
  const f = fixture(
    [reference(1)],
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const running = f.inbox.atBoundary(boundary);
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  f.inbox.cancel('user_interruption');
  assert.equal(f.batches[0].signal.aborted, true);
  finish('accepted');
  assert.equal((await running).kind, 'cancelled');
  const retry = f.inbox.atBoundary(boundary);
  while (f.batches.length < 2) await new Promise((resolve) => setImmediate(resolve));
  finish('accepted');
  await retry;
  assert.equal(f.batches[1].references[0].messageId, 'm-1');
});

test('backpressure keeps >100 sources durable and resumes pages as exact reads free capacity', async () => {
  const rows = Array.from({ length: 237 }, (_, i) => reference(i, `lane-${i % 10}`));
  const f = fixture(rows);
  await f.inbox.atBoundary(boundary);
  const full = await f.inbox.atBoundary(boundary);
  assert.equal(full.pending, 32);
  assert.equal(full.hasMore, true);
  let consumed = 0;
  for (let step = 0; step < 80 && consumed < rows.length; step++) {
    for (const batch of f.batches)
      for (const row of batch.references) {
        const canonical = rows.find((item) => item.messageId === row.messageId);
        assert.ok(canonical);
        if (canonical.facts.readByInvocationIds.length === 0) {
          canonical.facts = {
            ...canonical.facts,
            readByInvocationIds: [scope.invocationId],
            readInCurrentContext: true,
          };
          consumed++;
        }
      }
    await f.inbox.atBoundary(boundary);
  }
  assert.equal(consumed, 237);
  assert.equal(new Set(f.batches.flatMap((batch) => batch.references.map((row) => row.messageId))).size, 237);
  assert.ok(f.source.pages > 7);
});

test('urgent traffic is preferred while normal/FYI and all ten producer lanes make progress', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => reference(i, `lane-${i % 10}`, 'urgent'));
  rows.push(reference(21, 'normal'), reference(22, 'fyi', 'fyi'));
  const f = fixture(rows);
  await f.inbox.atBoundary(boundary);
  await f.inbox.atBoundary(boundary);
  const delivered = f.batches.flatMap((batch) => batch.references);
  assert.equal(delivered[0].priority, 'urgent');
  assert.ok(delivered.some((row) => row.priority === 'normal'));
  assert.ok(delivered.some((row) => row.priority === 'fyi'));
  assert.equal(new Set(delivered.filter((row) => row.priority === 'urgent').map((row) => row.sourceThreadId)).size, 10);
});

test('a fresh consumer replays notified/read-but-unhandled work, never terminal work', async () => {
  const f = fixture([reference(1), { ...reference(2), facts: { ...reference(2).facts, handled: true } }]);
  await f.inbox.atBoundary(boundary);
  f.inbox.close();
  const recovered = fixture(f.source.rows);
  await recovered.inbox.atBoundary(boundary);
  assert.deepEqual(
    recovered.batches.flatMap((batch) => batch.references.map((row) => row.messageId)),
    ['m-1'],
  );
  const staleRead = reference(3);
  staleRead.facts.readByInvocationIds = ['dead-child'];
  recovered.source.rows.push(staleRead);
  recovered.inbox.signal();
  await recovered.inbox.atBoundary(boundary);
  assert.ok(recovered.batches.some((batch) => batch.references.some((row) => row.messageId === 'm-3')));
});

test('withdrawal or permission revocation between page and delivery removes the source', async () => {
  const f = fixture([reference(1)]);
  f.source.read = async () => null;
  await f.inbox.atBoundary(boundary);
  assert.equal(f.batches.length, 0);
});

test('a hung cancelled delivery releases the consumer and late results cannot overwrite its successor', async () => {
  let calls = 0;
  let oldFinish!: (result: 'accepted') => void;
  const f = fixture([reference(1)], async () => {
    calls++;
    return calls === 1
      ? new Promise((resolve) => {
          oldFinish = resolve;
        })
      : 'accepted';
  });
  const old = f.inbox.atBoundary(boundary);
  while (!oldFinish) await new Promise((resolve) => setImmediate(resolve));
  f.inbox.cancel('disconnected');
  assert.equal((await old).kind, 'cancelled');
  assert.equal((await f.inbox.atBoundary(boundary)).kind, 'accepted');
  oldFinish('accepted');
  await new Promise((resolve) => setImmediate(resolve));
  await f.inbox.atBoundary(boundary);
  assert.equal(f.batches.length, 2);
});

test('busy and failed publication stay retryable without spinning or consuming the source', async () => {
  let attempt = 0;
  const f = fixture([reference(1)], async () => {
    if (++attempt === 1) return 'busy';
    if (attempt === 2) throw new Error('transport unavailable');
    return 'accepted';
  });
  assert.equal((await f.inbox.atBoundary(boundary)).kind, 'busy');
  assert.equal(f.wakes(), 0);
  await assert.rejects(f.inbox.atBoundary(boundary), /transport unavailable/);
  assert.equal((await f.inbox.atBoundary(boundary)).kind, 'accepted');
  assert.equal(f.batches.length, 3);
});

test('bounded scan continuation wakes itself; idle history is not periodically polled', async () => {
  const source = new Source();
  source.rows = Array.from({ length: 123 }, (_, i) => ({
    ...reference(i),
    facts: { ...reference(i).facts, handled: true },
  }));
  source.rows.push(reference(124));
  const deliveries: LiveInboxBatch[] = [];
  let wake = 0;
  const inbox = new LiveInbox({
    scope,
    source,
    pageSize: 10,
    maxPagesPerBoundary: 1,
    wake: () => {
      wake++;
    },
    deliver: async (batch) => {
      deliveries.push(batch);
      return 'accepted';
    },
  });
  await inbox.atBoundary(boundary);
  assert.equal(wake, 1, 'remaining scan must schedule another boundary without new arrivals');
  for (let i = 0; i < 15; i++) await inbox.atBoundary(boundary);
  assert.equal(deliveries.length, 1);
  const finalWake = wake;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(wake, finalWake);
});
