import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { buildSearchableMessageContent } from '../dist/domains/memory/message-search-content.js';

function expected(messages) {
  return messages
    .filter((m) => m.origin !== 'briefing')
    .map((m) => ({
      id: m.id,
      content: m.content,
      catId: m.catId ?? undefined,
      threadId: m.threadId,
      timestamp: m.timestamp,
      contentBlocks: m.contentBlocks,
      richBlocks: m.extra?.rich?.blocks,
    }));
}

function row(id, patch = {}) {
  return {
    id,
    threadId: 'thread-evidence',
    userId: 'owner',
    catId: 'codex61-sol',
    from: JSON.stringify({ kind: 'agent', catId: 'codex61-sol' }),
    content: `body ${id}`,
    timestamp: '1000',
    mentions: '[]',
    deliveryStatus: 'delivered',
    ...patch,
  };
}

function fixture(rows) {
  const fullReads = [];
  const selectedReads = [];
  let bytes = 0;
  const redis = {
    options: {},
    zrevrange: async (_key, start, end) => rows.slice(start, end + 1).map((r) => r.id),
    multi: () => {
      const calls = [];
      const pipeline = {
        hgetall(key) {
          fullReads.push(key);
          calls.push([key]);
          return pipeline;
        },
        hmget(key, ...fields) {
          selectedReads.push(fields);
          calls.push([key, fields]);
          return pipeline;
        },
        exec: async () =>
          calls.map(([key, fields]) => {
            const value = rows.find((r) => key.endsWith(`:${r.id}`));
            const data = fields ? fields.map((field) => value?.[field] ?? null) : value;
            bytes += Buffer.byteLength(JSON.stringify(data));
            return [null, data];
          }),
      };
      return pipeline;
    },
  };
  return { store: new RedisMessageStore(redis), fullReads, selectedReads, bytes: () => bytes };
}

test('evidence reader keeps the full reader limit/order/visibility while omitting tool payload transfer', async (t) => {
  const toolEvents = JSON.stringify([{ id: 'tool', type: 'tool_result', content: 'x'.repeat(128 * 1024) }]);
  const rows = Array.from({ length: 55 }, (_, i) =>
    row(`m${i}`, {
      toolEvents,
      deliveryStatus: i < 49 ? 'queued' : 'delivered',
    }),
  );
  rows[50] = row('m50', { toolEvents, userId: 'other' });
  rows[51] = row('m51', { toolEvents, deletedAt: '1001' });
  rows[52] = row('m52', { toolEvents, origin: 'briefing' });
  const baseline = fixture(rows);
  const wanted = expected(await baseline.store.getByThread('thread-evidence', 4, 'owner'));
  const candidate = fixture(rows);
  const actual = await candidate.store.getThreadEvidenceProjection('thread-evidence', 4, 'owner');
  assert.deepEqual(actual, wanted);
  assert.equal(actual.length, 3, 'briefing is excluded after the full reader applies its limit');
  assert.equal(candidate.fullReads.length, 0);
  assert.ok(candidate.selectedReads.length > 50, 'filtered rows must not consume the result limit');
  assert.ok(candidate.selectedReads.every((fields) => !fields.includes('toolEvents')));
  assert.ok(candidate.bytes() < baseline.bytes() / 20, 'wide tool events must not cross the Redis boundary');
  t.diagnostic(
    JSON.stringify({ fixtureSerializedResponseBytes: { full: baseline.bytes(), evidence: candidate.bytes() } }),
  );
});

test('evidence reader retains searchable quotes/rich blocks and source-bound managed-hold privacy', async () => {
  const blocks = [
    {
      type: 'context_attachment',
      attachment: {
        v: 1,
        id: 'quote-1',
        kind: 'quote',
        text: 'quoted source',
        comment: 'owner comment',
        source: { kind: 'message', threadId: 'thread-evidence', messageId: 'quoted-1', senderCatId: 'codex61-sol' },
      },
    },
  ];
  const extra = {
    rich: { v: 1, blocks: [{ id: 'card-1', v: 1, kind: 'card', title: 'Visible card', bodyMarkdown: 'rich body' }] },
  };
  const rows = [
    row('rich', { contentBlocks: JSON.stringify(blocks), extra: JSON.stringify(extra) }),
    row('malformed', { contentBlocks: '{', extra: '{', toolEvents: '{' }),
    row('foreign-system', {
      userId: 'other',
      from: JSON.stringify({ kind: 'system', service: 'managed-command-wake' }),
      source: JSON.stringify({
        connector: 'hold-ball',
        label: 'managed hold',
        icon: 'clock',
        meta: { managedHold: true, taskId: 'hold-private', catId: 'codex61-sol', threadId: 'thread-evidence' },
      }),
    }),
    row('hidden-system', {
      from: JSON.stringify({ kind: 'system', service: 'managed-command-wake' }),
      source: JSON.stringify({
        connector: 'hold-ball',
        label: 'managed hold',
        icon: 'clock',
        meta: { managedHold: true, taskId: 'hold-private', catId: 'codex61-sol', threadId: 'thread-evidence' },
      }),
      extra: JSON.stringify({ scheduler: { hiddenTrigger: true } }),
    }),
    row('visible-system', {
      from: JSON.stringify({ kind: 'system', service: 'managed-command-wake' }),
      source: JSON.stringify({
        connector: 'hold-ball',
        label: 'managed hold',
        icon: 'clock',
        meta: { managedHold: true, taskId: 'hold-private', catId: 'codex61-sol', threadId: 'thread-evidence' },
      }),
    }),
    row('legacy', { from: '', catId: '', userId: 'owner' }),
  ];
  const wanted = expected(await fixture(rows).store.getByThread('thread-evidence', 20, 'owner'));
  const actual = await fixture(rows).store.getThreadEvidenceProjection('thread-evidence', 20, 'owner');
  assert.deepEqual(actual, wanted);
  assert.deepEqual(
    actual.map((m) => m.id),
    ['legacy', 'visible-system', 'malformed', 'rich'],
  );
  assert.equal(
    buildSearchableMessageContent(actual.at(-1)),
    'body rich\nquoted source\nowner comment\nVisible card\nrich body',
  );
});

test('in-memory evidence projection matches the existing indexing callback without mutating stored messages', () => {
  const store = new MessageStore();
  const original = store.append({
    from: { kind: 'user', userId: 'owner' },
    userId: 'owner',
    threadId: 'thread-evidence',
    content: 'owner text',
    mentions: [],
    timestamp: 1000,
    extra: { rich: { v: 1, blocks: [{ id: 'mem-card', v: 1, kind: 'card', title: 'rich title' }] } },
  });
  const before = structuredClone(original);
  assert.deepEqual(
    store.getThreadEvidenceProjection('thread-evidence', 1, 'owner'),
    expected(store.getByThread('thread-evidence', 1, 'owner')),
  );
  assert.deepEqual(original, before);
});
