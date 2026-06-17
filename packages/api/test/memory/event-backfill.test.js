import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { EventMemoryStore } from '../../dist/domains/memory/EventMemoryStore.js';
import {
  backfillMagicWordEvents,
  buildBackfillEvent,
  extractBackfillMessage,
  runCorpusBackfill,
} from '../../dist/domains/memory/event-backfill.js';

/**
 * F227 PR-2 Task 6 — historical magic-word backfill.
 * Scans persisted messages → graded detector → EventMemoryStore.markEvent.
 * Idempotent (store atomic UNIQUE coord+type, safe to re-run + safe vs PR-1 live writes),
 * dead-letters failures (最终不丢), uses each message's real timestamp/coords.
 */

function storedMsg(over = {}) {
  return {
    id: 'm1',
    threadId: 't1',
    content: '',
    timestamp: 1000,
    catId: null, // null = user (co-creator) message
    userId: 'default-user', // owner; runCorpusBackfill only marks rows whose userId === owner (P1)
    mentions: [],
    extra: undefined,
    ...over,
  };
}

/** backfill now writes owner-scoped (cloud-review P1); a fixed owner for these unit tests. */
const OWNER = 'owner-1';

describe('F227 PR-2: extractBackfillMessage', () => {
  it('marks a user (catId=null) message as cocreator-authored', () => {
    const b = extractBackfillMessage(storedMsg({ catId: null }));
    assert.equal(b.authoredByCocreator, true);
  });

  it('marks a cat message as NOT cocreator-authored', () => {
    const b = extractBackfillMessage(storedMsg({ catId: 'opus' }));
    assert.equal(b.authoredByCocreator, false);
  });

  it('derives targetCat from extra.targetCats first, then mentions', () => {
    assert.equal(
      extractBackfillMessage(storedMsg({ extra: { targetCats: ['codex'] }, mentions: ['opus'] })).targetCat,
      'codex',
    );
    assert.equal(extractBackfillMessage(storedMsg({ mentions: ['opus'] })).targetCat, 'opus');
    assert.equal(extractBackfillMessage(storedMsg({})).targetCat, null);
  });

  it('carries id/threadId/content/timestamp through', () => {
    const b = extractBackfillMessage(storedMsg({ id: 'mX', threadId: 'tZ', content: '脚手架', timestamp: 42 }));
    assert.deepEqual(
      { messageId: b.messageId, threadId: b.threadId, content: b.content, timestamp: b.timestamp },
      { messageId: 'mX', threadId: 'tZ', content: '脚手架', timestamp: 42 },
    );
  });
});

describe('F227 PR-2: buildBackfillEvent', () => {
  const base = {
    messageId: 'm1',
    threadId: 't1',
    content: '这是脚手架',
    timestamp: 99,
    authoredByCocreator: true,
    targetCat: 'opus',
  };

  it('builds the terminal 10-field record (high → user_brake transition)', () => {
    const e = buildBackfillEvent(base, { word: '脚手架', confidence: 'high' });
    assert.equal(e.type, '脚手架');
    assert.equal(e.trigger, 'human_brake');
    assert.equal(e.cat, 'opus');
    assert.equal(e.threadId, 't1');
    assert.equal(e.messageId, 'm1');
    assert.equal(e.timestamp, 99);
    assert.equal(e.cognitiveTransition, 'user_brake');
    assert.equal(e.relatedHarness, null);
    assert.equal(e.confidence, 'high');
  });

  it('low confidence → cognitiveTransition null (mention, not a real transition)', () => {
    assert.equal(buildBackfillEvent(base, { word: '脚手架', confidence: 'low' }).cognitiveTransition, null);
  });

  it('null targetCat → cat "unknown" (mirrors live path)', () => {
    assert.equal(
      buildBackfillEvent({ ...base, targetCat: null }, { word: '脚手架', confidence: 'mid' }).cat,
      'unknown',
    );
  });

  it('truncates a long summary to <=201 chars with ellipsis', () => {
    const long = '脚手架'.repeat(200);
    const e = buildBackfillEvent({ ...base, content: long }, { word: '脚手架', confidence: 'high' });
    assert.ok(e.summary.length <= 201, `summary too long: ${e.summary.length}`);
    assert.ok(e.summary.endsWith('…'));
  });
});

describe('F227 PR-2: backfillMagicWordEvents', () => {
  let store;
  beforeEach(async () => {
    store = new EventMemoryStore(':memory:');
    await store.initialize();
  });

  it('marks a cocreator brake directed at a cat as a high event', () => {
    const msgs = [
      extractBackfillMessage(storedMsg({ content: '这是脚手架吧 @opus 重写', catId: null, mentions: ['opus'] })),
    ];
    const res = backfillMagicWordEvents(msgs, store, OWNER);
    assert.equal(res.marked, 1);
    const [e] = store.listEvents();
    assert.equal(e.type, '脚手架');
    assert.equal(e.confidence, 'high');
    assert.equal(e.cat, 'opus');
  });

  it('marks a cat-authored magic word as low (discussion)', () => {
    const msgs = [extractBackfillMessage(storedMsg({ content: '我刚写得有点脚手架', catId: 'opus' }))];
    backfillMagicWordEvents(msgs, store, OWNER);
    const [e] = store.listEvents();
    assert.equal(e.confidence, 'low');
    assert.equal(e.cognitiveTransition, null);
  });

  it('does not mark messages with no magic word', () => {
    const msgs = [extractBackfillMessage(storedMsg({ content: '今天写完了功能' }))];
    const res = backfillMagicWordEvents(msgs, store, OWNER);
    assert.equal(res.marked, 0);
    assert.equal(store.listEvents().length, 0);
  });

  it('is idempotent: re-running the same corpus does NOT duplicate events (store atomic dedup)', () => {
    const msgs = [extractBackfillMessage(storedMsg({ content: '脚手架 @opus', mentions: ['opus'] }))];
    const r1 = backfillMagicWordEvents(msgs, store, OWNER);
    const r2 = backfillMagicWordEvents(msgs, store, OWNER);
    assert.equal(r1.marked, 1);
    assert.equal(r2.marked, 0, 'second run must mark nothing');
    assert.equal(r2.skipped, 1);
    assert.equal(store.listEvents().length, 1, 'no duplicate event at the same coord');
  });

  it('dead-letters a write failure instead of losing the event (最终不丢)', () => {
    const dead = [];
    const failingStore = {
      markEvent() {
        throw new Error('disk full');
      },
      appendDeadLetter: (record, ownerUserId, err) => dead.push({ record, ownerUserId, err }),
    };
    const msgs = [extractBackfillMessage(storedMsg({ content: '脚手架 @opus', mentions: ['opus'] }))];
    const res = backfillMagicWordEvents(msgs, failingStore, OWNER);
    assert.equal(res.failed, 1);
    assert.equal(res.marked, 0);
    assert.equal(dead.length, 1);
    assert.equal(dead[0].record.type, '脚手架');
    assert.equal(dead[0].ownerUserId, OWNER, 'dead-letter captures owner for safe replay (P1)');
  });
});

describe('F227 PR-2: runCorpusBackfill (resumable thread+message iteration)', () => {
  let store;
  beforeEach(async () => {
    store = new EventMemoryStore(':memory:');
    await store.initialize();
  });
  afterEach(() => {});

  it('iterates all threads, loads each fully, and indexes graded events newest-first', async () => {
    // Two threads; t1 has 3 messages, t2 has 1 — each thread is loaded in one pass.
    const corpus = {
      t1: [
        storedMsg({ id: 'a', threadId: 't1', content: '这是脚手架 @opus', timestamp: 100, mentions: ['opus'] }),
        storedMsg({ id: 'b', threadId: 't1', content: '补锅匠 @codex', timestamp: 200, mentions: ['codex'] }),
        storedMsg({ id: 'c', threadId: 't1', content: '今天天气不错', timestamp: 300 }),
      ],
      t2: [storedMsg({ id: 'd', threadId: 't2', content: '我能猜出来 @opus', timestamp: 400, mentions: ['opus'] })],
    };
    const threadSource = { list: () => [{ id: 't1' }, { id: 't2' }] };
    const messageSource = {
      getByThreadAfter: (threadId, afterId, limit) => {
        const all = corpus[threadId] ?? [];
        const start = afterId ? all.findIndex((m) => m.id === afterId) + 1 : 0;
        return limit == null ? all.slice(start) : all.slice(start, start + limit);
      },
    };

    const res = await runCorpusBackfill(threadSource, messageSource, store, { userId: 'default-user' });
    assert.equal(res.scanned, 4);
    assert.equal(res.marked, 3); // 脚手架 + 补锅匠 + 我能猜出来 (天气 has none)

    const events = store.listEvents();
    assert.equal(events.length, 3);
    assert.equal(events[0].timestamp, 400); // newest-first
    assert.deepEqual(
      events.map((e) => e.type),
      ['我能猜出来', '补锅匠', '脚手架'],
    );
  });

  it('is resumable/idempotent across runs (second full run marks nothing)', async () => {
    const corpus = {
      t1: [storedMsg({ id: 'a', threadId: 't1', content: '脚手架 @opus', timestamp: 100, mentions: ['opus'] })],
    };
    const threadSource = { list: () => [{ id: 't1' }] };
    const messageSource = {
      getByThreadAfter: (threadId, afterId, limit) => {
        const all = corpus[threadId] ?? [];
        const start = afterId ? all.findIndex((m) => m.id === afterId) + 1 : 0;
        return limit == null ? all.slice(start) : all.slice(start, start + limit);
      },
    };
    await runCorpusBackfill(threadSource, messageSource, store, { userId: 'default-user' });
    const second = await runCorpusBackfill(threadSource, messageSource, store, { userId: 'default-user' });
    assert.equal(second.marked, 0);
    assert.equal(store.listEvents().length, 1);
  });

  it('loads each thread fully — a limit-before-filter Redis page never truncates the scan', async () => {
    // Regression: cloud-review P2 + LL feedback_inmemory_store_tests_miss_redis_behavior.
    // RedisMessageStore.getByThreadAfter applies `limit` to the RAW id range, THEN filters
    // (isDelivered + userId). A bounded page can come back short/empty while matching
    // messages remain further back — so backfill must NOT page by a bounded `limit`.
    const raw = {
      t1: [
        // first rows get dropped by the post-limit filter (other user / tombstone)
        storedMsg({ id: 'n1', threadId: 't1', content: 'noise', timestamp: 10 }),
        storedMsg({ id: 'n2', threadId: 't1', content: 'noise', timestamp: 20 }),
        // the real brake lives behind the noise — a bounded pager would miss it
        storedMsg({ id: 'm1', threadId: 't1', content: '脚手架 @opus', timestamp: 30, mentions: ['opus'] }),
      ],
    };
    const calls = [];
    const messageSource = {
      getByThreadAfter: (threadId, afterId, limit) => {
        calls.push({ afterId, limit });
        const all = raw[threadId] ?? [];
        const start = afterId ? all.findIndex((m) => m.id === afterId) + 1 : 0;
        const window = limit == null ? all.slice(start) : all.slice(start, start + limit);
        // post-limit filter (mimics isDelivered + userId dropping the noise rows)
        return window.filter((m) => m.content !== 'noise');
      },
    };
    const res = await runCorpusBackfill({ list: () => [{ id: 't1' }] }, messageSource, store, {
      userId: 'default-user',
    });
    // the 脚手架 behind the filtered noise must be found, not truncated away
    assert.equal(res.marked, 1);
    assert.equal(store.listEvents()[0].type, '脚手架');
    // contract: the scan requests the whole thread (no bounded page), so the store's
    // limit-before-filter behavior can't silently drop trailing events.
    assert.ok(calls.length > 0 && calls.every((c) => c.limit == null), 'must not paginate by a bounded limit');
  });

  it("passes userId so the shared (default) thread does not leak other users' events (P1)", async () => {
    // Regression: cloud-review P1. RedisThreadStore.list always includes the shared
    // DEFAULT thread, and RedisMessageStore.getByThreadAfter only owner-scopes when
    // userId is supplied. Backfill MUST pass userId or it scans other users' default-
    // thread messages into the global EventMemoryStore (visible in the timeline/list).
    const corpus = {
      default: [
        {
          id: 'mine',
          threadId: 'default',
          content: '脚手架 @opus',
          timestamp: 100,
          catId: null,
          userId: 'me',
          mentions: ['opus'],
        },
        {
          id: 'theirs',
          threadId: 'default',
          content: '补锅匠 @opus',
          timestamp: 200,
          catId: null,
          userId: 'other',
          mentions: ['opus'],
        },
      ],
    };
    let sawUserId = 'UNSET';
    const messageSource = {
      getByThreadAfter: (threadId, _afterId, limit, userId) => {
        sawUserId = userId;
        const all = corpus[threadId] ?? [];
        const window = limit == null ? all : all.slice(0, limit);
        // mimic RedisMessageStore: owner-filter only when userId is supplied
        return userId ? window.filter((m) => m.userId === userId) : window;
      },
    };
    const res = await runCorpusBackfill({ list: () => [{ id: 'default' }] }, messageSource, store, { userId: 'me' });
    assert.equal(sawUserId, 'me', 'must pass userId to scope the shared thread');
    assert.equal(res.marked, 1); // only my 脚手架, NOT the other user's 补锅匠
    assert.equal(store.listEvents()[0].type, '脚手架');
  });

  it("skips globally-visible system messages — only the owner's own rows are marked (P1)", async () => {
    // Regression: cloud-review P1. getByThreadAfter(userId) returns the owner's rows OR
    // SYSTEM messages (isSystemUserMessage) — both catId=null. A system message quoting a
    // magic word in the shared default thread must NOT be backfilled as the owner's brake.
    const corpus = {
      default: [
        {
          id: 'mine',
          threadId: 'default',
          content: '脚手架 @opus',
          timestamp: 100,
          catId: null,
          userId: 'me',
          mentions: ['opus'],
        },
        // a system row (catId=null, non-owner userId) that getByThreadAfter still returns
        {
          id: 'sys',
          threadId: 'default',
          content: '系统提示包含 补锅匠 字样',
          timestamp: 200,
          catId: null,
          userId: 'system',
          mentions: [],
        },
      ],
    };
    const messageSource = {
      // mimic RedisMessageStore: returns the owner's rows AND globally-visible system rows
      getByThreadAfter: (threadId, _afterId, _limit, userId) => {
        const all = corpus[threadId] ?? [];
        return all.filter((m) => m.userId === userId || m.userId === 'system');
      },
    };
    const res = await runCorpusBackfill({ list: () => [{ id: 'default' }] }, messageSource, store, { userId: 'me' });
    assert.equal(res.scanned, 1, 'only the owner row is scanned; the system row is skipped');
    assert.equal(res.marked, 1);
    const events = store.listEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, '脚手架', "only the owner's brake; NOT the system 补锅匠");
  });
});
