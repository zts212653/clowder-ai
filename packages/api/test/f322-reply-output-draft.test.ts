import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { MessageOutputLayoutV1 } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { projectAuthoredTextParts } from '../src/domains/cats/services/agents/message-output-authored-text.js';
import { prepareResponseText } from '../src/domains/cats/services/agents/routing/response-text.js';
import { type DraftRecord, DraftStore } from '../src/domains/cats/services/stores/ports/DraftStore.js';
import { RedisDraftStore } from '../src/domains/cats/services/stores/redis/RedisDraftStore.js';
import { captureTextProvenance, restoreTextSourceParts } from '../src/domains/cats/services/text-provenance.js';

import { HashRedis } from './helpers/f322-draft-redis.mjs';

const content = '过程。\n\n回答。';
const outputLayout: MessageOutputLayoutV1 = {
  v: 1,
  owner: { threadId: 'thread-one', catId: 'codex61-sol', turnInvocationId: 'child-turn' },
  contentRevision: { length: content.length, sha256: createHash('sha256').update(content).digest('hex') },
  status: 'available',
  runs: [
    {
      id: 'process',
      identity: { provider: 'codex', runtimeSessionId: 'native', turnId: 'turn', nativeId: 'process' },
      channel: 'commentary',
      complete: true,
      start: 0,
      end: 3,
      gluePrefixLength: 0,
    },
    {
      id: 'answer',
      identity: { provider: 'codex', runtimeSessionId: 'native', turnId: 'turn', nativeId: 'answer' },
      channel: 'final',
      complete: true,
      start: 3,
      end: 8,
      gluePrefixLength: 2,
    },
  ],
  order: [
    { kind: 'run', runId: 'process' },
    { kind: 'tool', toolEventId: 'tool-event-one', executionRef: 'child-turn' },
    { kind: 'run', runId: 'answer' },
  ],
};
const draft: DraftRecord & { extra: { outputLayout: MessageOutputLayoutV1 } } = {
  userId: 'user-one',
  threadId: 'thread-one',
  invocationId: 'child-turn',
  catId: 'codex61-sol' as DraftRecord['catId'],
  content,
  toolEvents: [{ id: 'tool-event-one', type: 'tool_use', label: 'Read', timestamp: 1 }],
  extra: { outputLayout },
  textProvenance: captureTextProvenance(outputLayout.owner, [
    { content: '过程。', textSource: 'provider_summary' },
    { content: '\n\n回答。' },
  ]),
  updatedAt: Date.now(),
};

test('the Redis draft wire preserves ordered output ranges across a fresh reader, like memory drafts', async () => {
  const memory = new DraftStore();
  memory.upsert(draft);
  const inMemory = memory.getByThread('user-one', 'thread-one')[0] as typeof draft;
  assert.deepEqual(inMemory.extra?.outputLayout, outputLayout);

  const redis = new HashRedis();
  await new RedisDraftStore(redis as unknown as RedisClient).upsert(draft);
  const restored = (
    await new RedisDraftStore(redis as unknown as RedisClient).getByThread('user-one', 'thread-one')
  )[0] as typeof draft;
  assert.equal(restored.content, content, 'the complete body stays the only stored body');
  assert.deepEqual(restored.toolEvents, draft.toolEvents);
  assert.deepEqual(restored.extra?.outputLayout, outputLayout);
  assert.deepEqual(restored.textProvenance, draft.textProvenance);
  assert.deepEqual(redis.expirations, [], 'user-visible drafts have no automatic expiration');
  assert.equal(redis.persistentKeys.size, 2, 'both the owned draft and its thread index remain persistent');
});

test('unknown/legacy draft content remains whole and owner-scoped', async () => {
  const redis = new HashRedis();
  const store = new RedisDraftStore(redis as unknown as RedisClient);
  const { extra: _extra, textProvenance: _provenance, ...legacy } = draft;
  await store.upsert(legacy);
  const restored = (await store.getByThread('user-one', 'thread-one'))[0] as typeof draft;
  assert.equal(restored.content, content);
  assert.equal(restored.extra?.outputLayout, undefined);
  assert.equal(restored.textProvenance, undefined);
  assert.deepEqual(await store.getByThread('other-user', 'thread-one'), []);
});

test('a subsequent legacy snapshot clears stale layout on the existing draft hash', async () => {
  const redis = new HashRedis();
  const store = new RedisDraftStore(redis as unknown as RedisClient);
  await store.upsert(draft);
  const { extra: _extra, textProvenance: _provenance, ...legacy } = draft;
  await store.upsert({ ...legacy, content: 'new whole body' });
  const restored = (await store.getByThread('user-one', 'thread-one'))[0];
  assert.equal(restored.content, 'new whole body');
  assert.equal(restored.extra?.outputLayout, undefined);
  assert.equal(restored.textProvenance, undefined);
});

test('a malformed, foreign or stale Redis source map cannot turn summary syntax into rich blocks', async () => {
  const body =
    '摘要🐾。\n```cc_rich\n{"v":1,"blocks":[{"v":1,"kind":"card","id":"summary-card","title":"summary"}]}\n```';
  const provenance = captureTextProvenance(outputLayout.owner, [{ content: body, textSource: 'provider_summary' }]);
  assert.ok(provenance && !('status' in provenance));
  const cases = [
    ['broken JSON', '{'],
    ['unsupported version', JSON.stringify({ ...provenance, v: 2 })],
    ['foreign owner', JSON.stringify({ ...provenance, owner: { ...provenance.owner, catId: 'other' } })],
    ['foreign thread', JSON.stringify({ ...provenance, owner: { ...provenance.owner, threadId: 'other' } })],
    ['foreign turn', JSON.stringify({ ...provenance, owner: { ...provenance.owner, turnInvocationId: 'other' } })],
    [
      'stale length',
      JSON.stringify({ ...provenance, contentRevision: { ...provenance.contentRevision, length: body.length + 1 } }),
    ],
    ['stale hash', JSON.stringify({ ...provenance, contentRevision: { length: body.length, sha256: '0'.repeat(64) } })],
    ['empty sources', JSON.stringify({ ...provenance, providerSummaryRanges: [] })],
    ['out of bounds', JSON.stringify({ ...provenance, providerSummaryRanges: [{ start: 0, end: body.length + 1 }] })],
    [
      'overlap',
      JSON.stringify({
        ...provenance,
        providerSummaryRanges: [
          { start: 0, end: 5 },
          { start: 4, end: body.length },
        ],
      }),
    ],
  ];
  for (const [label, raw] of cases) {
    const redis = new HashRedis();
    await new RedisDraftStore(redis as unknown as RedisClient).upsert({
      ...draft,
      content: body,
      textProvenance: provenance,
    });
    const wire = [...redis.hashes.values()][0];
    wire.textProvenance = raw;
    const [restored] = await new RedisDraftStore(redis as unknown as RedisClient).getByThread(
      draft.userId,
      draft.threadId,
    );
    assert.ok(restored);
    const parts = restoreTextSourceParts(restored.content, restored.textProvenance, outputLayout.owner);
    const prepared = prepareResponseText(
      restored.content,
      { projectAuthoredText: (transform) => projectAuthoredTextParts(parts, transform) },
      false,
    );
    assert.equal(prepared.content, body, `${label}: keep the complete literal body`);
    assert.deepEqual(prepared.blocks, [], `${label}: a lost source proof does not create a card`);
  }
});
