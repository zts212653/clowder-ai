/**
 * F257 Console 判据④ — Segment lifeline true-scene replay route tests.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

// ── Minimal FakeRedis with SET/ZSET/HASH/Lua support ─────────

class FakeRedis {
  constructor() {
    this.kv = new Map();
    this.sorted = new Map();
    this.sets = new Map();
    this.hashes = new Map();
    this.ttls = new Map();
  }

  async set(key, value, ...args) {
    this.kv.set(key, value);
    if (args[0] === 'EX' && typeof args[1] === 'number') {
      this.ttls.set(key, args[1]);
    }
    return 'OK';
  }

  async get(key) {
    return this.kv.get(key) ?? null;
  }

  async exists(key) {
    if (this.kv.has(key)) return 1;
    if (this.sorted.has(key)) return 1;
    if (this.sets.has(key)) return 1;
    if (this.hashes.has(key)) return 1;
    return 0;
  }

  async del(key) {
    this.kv.delete(key);
    this.sets.delete(key);
    this.sorted.delete(key);
    this.hashes.delete(key);
    this.ttls.delete(key);
    return 1;
  }

  async zadd(key, score, member) {
    const set = this.sorted.get(key) ?? new Map();
    set.set(member, score);
    this.sorted.set(key, set);
    return 1;
  }

  async zcard(key) {
    return this.sorted.get(key)?.size ?? 0;
  }

  async zrevrange(key, start, stop) {
    const set = this.sorted.get(key);
    if (!set) return [];
    const entries = [...set.entries()].sort((a, b) => b[1] - a[1]);
    return entries.slice(start, stop + 1).map(([m]) => m);
  }

  async zrangebyscore(key, min, max) {
    const set = this.sorted.get(key);
    if (!set) return [];
    return [...set.entries()]
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  }

  async zrem(key, member) {
    const set = this.sorted.get(key);
    if (!set) return 0;
    return set.delete(member) ? 1 : 0;
  }

  async sadd(key, ...members) {
    const s = this.sets.get(key) ?? new Set();
    let added = 0;
    for (const m of members) {
      if (!s.has(m)) {
        s.add(m);
        added++;
      }
    }
    this.sets.set(key, s);
    return added;
  }

  async smembers(key) {
    const s = this.sets.get(key);
    return s ? [...s] : [];
  }

  async hset(key, fields) {
    const h = this.hashes.get(key) ?? new Map();
    for (const [field, value] of Object.entries(fields)) {
      h.set(field, value);
    }
    this.hashes.set(key, h);
    return 1;
  }

  async hget(key, field) {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key) {
    const h = this.hashes.get(key);
    if (!h) return [];
    const out = [];
    for (const [k, v] of h) {
      out.push(k, v);
    }
    return out;
  }

  async hdel(key, field) {
    const h = this.hashes.get(key);
    if (!h) return 0;
    return h.delete(field) ? 1 : 0;
  }

  #runPersistScript(keys, argv) {
    const summaryKey = keys[0];
    const hashKey = keys[1];
    const count = Number(argv[0]);
    if (this.kv.has(summaryKey) === false) return 0;
    const h = this.hashes.get(hashKey) ?? new Map();
    for (let i = 0; i < count; i++) {
      const segmentId = argv[1 + i];
      const json = argv[1 + count + i];
      h.set(segmentId, json);
    }
    this.hashes.set(hashKey, h);
    return 1;
  }

  #runDeleteScript(keys, argv) {
    const indexKey = keys[2];
    const turnId = argv[0];
    let removed = 0;
    if (this.sorted.get(indexKey)?.delete(turnId)) removed = 1;
    for (const k of keys) {
      if (
        k !== indexKey &&
        (this.kv.delete(k) || this.sets.delete(k) || this.sorted.delete(k) || this.hashes.delete(k))
      ) {
        removed++;
      }
    }
    return removed;
  }

  // Minimal eval interpreter for the two Lua scripts used by InjectionTraceStore.
  async eval(script, numKeys, ...args) {
    const keys = args.slice(0, numKeys);
    const argv = args.slice(numKeys);

    if (script.includes("redis.call('EXISTS'") && script.includes("redis.call('HSET'")) {
      return this.#runPersistScript(keys, argv);
    }
    if (script.includes("redis.call('ZREM'") && script.includes("redis.call('DEL'")) {
      return this.#runDeleteScript(keys, argv);
    }

    throw new Error(`FakeRedis.eval: unsupported script`);
  }
}

// ── Helpers ──────────────────────────────────────────────────

async function seedTurn(traceStore, { threadId, turnId, catId = 'opus', timestamp = 5000 }) {
  const summary = {
    turnId,
    threadId,
    catId,
    timestamp,
    segments: [],
    delivery: [],
    totalCharCount: 0,
    totalTokenEstimate: 0,
    totalSegmentsObserved: 0,
    totalSegmentsAbsent: 0,
    durationMs: 0,
  };
  const detail = {
    turnId,
    threadId,
    catId,
    timestamp,
    sessionContentHash: null,
    turnContentHash: null,
    sessionCharCount: 0,
    sessionTokenEstimate: 0,
    turnCharCount: 0,
    turnTokenEstimate: 0,
    segments: [],
  };
  await traceStore.persist(summary, detail);
}

function makeSnapshot({ threadId, turnId, segmentId, catId = 'opus', timestamp = 5000, overrides = {} }) {
  return {
    segmentId,
    threadId,
    turnId,
    timestamp,
    catId,
    stage: 'session-init',
    pipelineStatus: 'fired',
    version: 1,
    content: 'rendered content',
    contentSourceKind: 'template',
    contentSourceRef: 'templates/S-test.md',
    templateVars: { VAR: 'value' },
    messageAnchorId: 'anchor-1',
    surroundingMessageIds: ['m1', 'm2'],
    surroundingMessagesGap: null,
    ownerUserId: 'test-user',
    ...overrides,
  };
}

async function buildReplayApp(opts = {}) {
  const { segmentLifelineReplayRoutes } = await import('../dist/routes/segment-lifeline-replay.js');
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      request.sessionUserId = sessionUser.trim();
    }
  });
  await app.register(segmentLifelineReplayRoutes, opts);
  await app.ready();
  return app;
}

function makeThreadStore(ownerUserId = 'test-user') {
  return {
    get: async (threadId) => ({
      id: threadId,
      projectPath: '/tmp',
      title: null,
      createdBy: ownerUserId,
      participants: [],
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
    }),
  };
}

const SESSION_HEADERS = { 'x-test-session-user': 'test-user' };

// ── Route tests ──────────────────────────────────────────────

describe('segment-lifeline-replay route', () => {
  test('returns 401 without session', async () => {
    const app = await buildReplayApp({});
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test('returns 503 when trace store unavailable', async () => {
    const app = await buildReplayApp({ threadStore: makeThreadStore() });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });
    assert.equal(res.statusCode, 503);
    await app.close();
  });

  test('returns 503 when thread store unavailable', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const store = new InjectionTraceStore(new FakeRedis());
    const app = await buildReplayApp({ traceStore: store });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });
    assert.equal(res.statusCode, 503);
    await app.close();
  });

  test('returns 400 when threadId or turnId missing', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const store = new InjectionTraceStore(new FakeRedis());
    const app = await buildReplayApp({ traceStore: store, threadStore: makeThreadStore() });

    const missingThread = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?turnId=1',
      headers: SESSION_HEADERS,
    });
    assert.equal(missingThread.statusCode, 400);

    const missingTurn = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t',
      headers: SESSION_HEADERS,
    });
    assert.equal(missingTurn.statusCode, 400);

    await app.close();
  });

  test('returns 404 when replay snapshot not found', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const store = new InjectionTraceStore(new FakeRedis());
    const app = await buildReplayApp({ traceStore: store, threadStore: makeThreadStore() });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  });

  test('returns 403 for cross-user thread access', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const redis = new FakeRedis();
    const traceStore = new InjectionTraceStore(redis);
    const messageStore = new MessageStore();

    const snapshot = makeSnapshot({ threadId: 't', turnId: '1', segmentId: 'S-test' });
    await seedTurn(traceStore, {
      threadId: snapshot.threadId,
      turnId: snapshot.turnId,
      catId: snapshot.catId,
      timestamp: snapshot.timestamp,
    });
    await traceStore.persistReplaySnapshots(snapshot.threadId, snapshot.turnId, [snapshot]);

    const app = await buildReplayApp({ traceStore, messageStore, threadStore: makeThreadStore('other-user') });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });
    assert.equal(res.statusCode, 403);
    await app.close();
  });

  test('returns full replay payload with content, source kind, template, vars, guard events, captured messages', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const { GuardRejectionEventLog } = await import('../dist/infrastructure/harness-eval/GuardRejectionEventLog.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const redis = new FakeRedis();
    const traceStore = new InjectionTraceStore(redis);
    const guardLog = new GuardRejectionEventLog(redis);
    const messageStore = new MessageStore();

    const timestamp = 5000;

    await guardLog.append({
      eventId: 'g1',
      ledgerId: 'layer/g1',
      kind: 'http_rate_limit',
      threadId: 't',
      catId: 'opus',
      guardId: 'hold_ball_rate_limit',
      invocationId: 'inv-1',
      sourceTool: 'hold_ball',
      normalizedReason: 'rate_limited',
      layer: 'api-route',
      ownerUserId: 'test-user',
      timestamp: timestamp + 1000,
      correlationConfidence: 'window',
      currentCount: 4,
      maxAllowed: 3,
      windowMs: 3600000,
    });

    const msg1 = messageStore.append(
      canonicalTestMessageInput({
        userId: 'test-user',
        threadId: 't',
        catId: null,
        content: 'hello',
        mentions: [],
        timestamp: timestamp - 1000,
        provenance: { author: 'user', routed: false, observation: 'original' },
      }),
    );
    const msg2 = messageStore.append(
      canonicalTestMessageInput({
        userId: 'test-user',
        threadId: 't',
        catId: 'opus',
        content: 'response text',
        mentions: [],
        timestamp: timestamp + 500,
        provenance: { author: 'cat', routed: false, observation: 'original' },
      }),
    );

    const snapshot = makeSnapshot({
      threadId: 't',
      turnId: '1',
      segmentId: 'S-test',
      catId: 'opus',
      timestamp,
      overrides: { surroundingMessageIds: [msg1.id, msg2.id] },
    });
    await seedTurn(traceStore, {
      threadId: snapshot.threadId,
      turnId: snapshot.turnId,
      catId: snapshot.catId,
      timestamp: snapshot.timestamp,
    });
    await traceStore.persistReplaySnapshots(snapshot.threadId, snapshot.turnId, [snapshot]);

    const app = await buildReplayApp({
      traceStore,
      guardRejectionLog: guardLog,
      messageStore,
      threadStore: makeThreadStore(),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);

    assert.equal(body.segmentId, 'S-test');
    assert.equal(body.threadId, 't');
    assert.equal(body.turnId, '1');
    assert.equal(body.catId, 'opus');
    assert.equal(body.timestamp, timestamp);
    assert.equal(body.stage, 'session-init');
    assert.equal(body.pipelineStatus, 'fired');
    assert.equal(body.version, 1);
    assert.equal(body.versionGap, null);
    assert.equal(body.content, 'rendered content');
    assert.equal(body.contentGap, null);
    assert.equal(body.contentSourceKind, 'template');
    assert.equal(body.contentSourceKindGap, null);
    assert.equal(body.templateRef, 'templates/S-test.md');
    assert.equal(body.templateRefGap, null);
    assert.deepEqual(body.templateVars, { VAR: 'value' });
    assert.equal(body.templateVarsGap, null);
    assert.equal(body.messageAnchorId, 'anchor-1');
    assert.equal(body.messageAnchorIdGap, null);

    assert.equal(body.guardEvents.length, 1);
    assert.equal(body.guardEvents[0].kind, 'http_rate_limit');
    assert.equal(body.guardEvents[0].guardId, 'hold_ball_rate_limit');

    assert.equal(body.surroundingMessages?.length, 2);
    assert.equal(body.surroundingMessagesGap, null);
    assert.equal(body.surroundingMessages[0].role, 'user');
    assert.equal(body.surroundingMessages[1].role, 'assistant');

    await app.close();
  });

  test('passes through snapshot surroundingMessagesGap unavailable', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const traceStore = new InjectionTraceStore(new FakeRedis());
    const messageStore = new MessageStore();

    const snapshot = makeSnapshot({
      threadId: 't',
      turnId: '1',
      segmentId: 'S-test',
      overrides: {
        surroundingMessageIds: [],
        surroundingMessagesGap: 'unavailable',
      },
    });
    await seedTurn(traceStore, {
      threadId: snapshot.threadId,
      turnId: snapshot.turnId,
      catId: snapshot.catId,
      timestamp: snapshot.timestamp,
    });
    await traceStore.persistReplaySnapshots(snapshot.threadId, snapshot.turnId, [snapshot]);

    const app = await buildReplayApp({ traceStore, messageStore, threadStore: makeThreadStore() });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.surroundingMessages, null);
    assert.equal(body.surroundingMessagesGap, 'unavailable');
    await app.close();
  });

  test('version null is reported as legacy-missing gap', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const traceStore = new InjectionTraceStore(redis);

    const snapshot = makeSnapshot({
      threadId: 't',
      turnId: '1',
      segmentId: 'S-test',
      overrides: { version: null },
    });
    await seedTurn(traceStore, {
      threadId: snapshot.threadId,
      turnId: snapshot.turnId,
      catId: snapshot.catId,
      timestamp: snapshot.timestamp,
    });
    await traceStore.persistReplaySnapshots(snapshot.threadId, snapshot.turnId, [snapshot]);

    const app = await buildReplayApp({ traceStore, threadStore: makeThreadStore() });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.version, null);
    assert.equal(body.versionGap, 'legacy-missing');
    await app.close();
  });

  test('native-L0 templateVars null is valid not corrupt', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const traceStore = new InjectionTraceStore(redis);

    const snapshot = makeSnapshot({
      threadId: 't',
      turnId: '1',
      segmentId: 'S-test',
      overrides: {
        contentSourceKind: 'native-l0',
        templateVars: null,
      },
    });
    await seedTurn(traceStore, {
      threadId: snapshot.threadId,
      turnId: snapshot.turnId,
      catId: snapshot.catId,
      timestamp: snapshot.timestamp,
    });
    await traceStore.persistReplaySnapshots(snapshot.threadId, snapshot.turnId, [snapshot]);

    const app = await buildReplayApp({ traceStore, threadStore: makeThreadStore() });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.contentSourceKind, 'native-l0');
    assert.equal(body.templateVars, null);
    assert.equal(body.templateVarsGap, null);
    await app.close();
  });

  test('marks undefined fields as legacy-missing gaps', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const traceStore = new InjectionTraceStore(redis);

    const snapshot = makeSnapshot({
      threadId: 't',
      turnId: '1',
      segmentId: 'S-test',
      overrides: {
        content: undefined,
        contentSourceKind: undefined,
        contentSourceRef: undefined,
        templateVars: undefined,
        version: undefined,
        messageAnchorId: undefined,
        surroundingMessageIds: undefined,
      },
    });
    await seedTurn(traceStore, {
      threadId: snapshot.threadId,
      turnId: snapshot.turnId,
      catId: snapshot.catId,
      timestamp: snapshot.timestamp,
    });
    await traceStore.persistReplaySnapshots(snapshot.threadId, snapshot.turnId, [snapshot]);

    const app = await buildReplayApp({ traceStore, threadStore: makeThreadStore() });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    assert.equal(body.contentGap, 'legacy-missing');
    assert.equal(body.contentSourceKindGap, 'legacy-missing');
    assert.equal(body.templateRefGap, 'legacy-missing');
    assert.equal(body.templateVarsGap, 'legacy-missing');
    assert.equal(body.versionGap, 'legacy-missing');
    assert.equal(body.messageAnchorIdGap, 'legacy-missing');
    assert.equal(body.surroundingMessagesGap, 'legacy-missing');
    assert.equal(body.guardEventsGap, 'unavailable');

    await app.close();
  });

  test('marks malformed fields as invalid-present gaps', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const traceStore = new InjectionTraceStore(redis);

    const snapshot = makeSnapshot({
      threadId: 't',
      turnId: '1',
      segmentId: 'S-test',
      overrides: {
        version: 'not-a-number',
        templateVars: ['not-an-object'],
        contentSourceKind: 'bogus',
        messageAnchorId: 123,
        surroundingMessageIds: 'not-an-array',
      },
    });
    await seedTurn(traceStore, {
      threadId: snapshot.threadId,
      turnId: snapshot.turnId,
      catId: snapshot.catId,
      timestamp: snapshot.timestamp,
    });
    await traceStore.persistReplaySnapshots(snapshot.threadId, snapshot.turnId, [snapshot]);

    const app = await buildReplayApp({ traceStore, threadStore: makeThreadStore() });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    assert.equal(body.versionGap, 'invalid-present');
    assert.equal(body.templateVarsGap, 'invalid-present');
    assert.equal(body.contentSourceKindGap, 'invalid-present');
    assert.equal(body.messageAnchorIdGap, 'invalid-present');
    assert.equal(body.surroundingMessagesGap, 'invalid-present');

    await app.close();
  });

  test('missing surroundingMessagesGap field is reported as legacy-missing', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const traceStore = new InjectionTraceStore(redis);

    const snapshot = makeSnapshot({
      threadId: 't',
      turnId: '1',
      segmentId: 'S-test',
      overrides: {
        surroundingMessageIds: ['m1'],
        surroundingMessagesGap: undefined,
      },
    });
    await seedTurn(traceStore, {
      threadId: snapshot.threadId,
      turnId: snapshot.turnId,
      catId: snapshot.catId,
      timestamp: snapshot.timestamp,
    });
    await traceStore.persistReplaySnapshots(snapshot.threadId, snapshot.turnId, [snapshot]);

    const app = await buildReplayApp({ traceStore, threadStore: makeThreadStore() });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.surroundingMessages, null);
    assert.equal(body.surroundingMessagesGap, 'legacy-missing');

    await app.close();
  });

  test('invalid surroundingMessagesGap value is reported as invalid-present', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const traceStore = new InjectionTraceStore(redis);

    const snapshot = makeSnapshot({
      threadId: 't',
      turnId: '1',
      segmentId: 'S-test',
      overrides: {
        surroundingMessageIds: ['m1'],
        surroundingMessagesGap: 'bogus-value',
      },
    });
    await seedTurn(traceStore, {
      threadId: snapshot.threadId,
      turnId: snapshot.turnId,
      catId: snapshot.catId,
      timestamp: snapshot.timestamp,
    });
    await traceStore.persistReplaySnapshots(snapshot.threadId, snapshot.turnId, [snapshot]);

    const app = await buildReplayApp({ traceStore, threadStore: makeThreadStore() });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.surroundingMessages, null);
    assert.equal(body.surroundingMessagesGap, 'invalid-present');

    await app.close();
  });

  test('drops deleted messages from captured context without failing', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const traceStore = new InjectionTraceStore(new FakeRedis());
    const messageStore = new MessageStore();

    const first = messageStore.append(
      canonicalTestMessageInput({
        userId: 'test-user',
        threadId: 't',
        catId: null,
        content: 'first',
        mentions: [],
        timestamp: 1000,
        provenance: { author: 'user', routed: false, observation: 'original' },
      }),
    );
    const second = messageStore.append(
      canonicalTestMessageInput({
        userId: 'test-user',
        threadId: 't',
        catId: 'opus',
        content: 'second',
        mentions: [],
        timestamp: 2000,
        provenance: { author: 'cat', routed: false, observation: 'original' },
      }),
    );

    const snapshot = makeSnapshot({
      threadId: 't',
      turnId: '1',
      segmentId: 'S-test',
      overrides: { surroundingMessageIds: [first.id, 'deleted', second.id] },
    });
    await seedTurn(traceStore, {
      threadId: snapshot.threadId,
      turnId: snapshot.turnId,
      catId: snapshot.catId,
      timestamp: snapshot.timestamp,
    });
    await traceStore.persistReplaySnapshots(snapshot.threadId, snapshot.turnId, [snapshot]);

    const app = await buildReplayApp({ traceStore, messageStore, threadStore: makeThreadStore() });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.surroundingMessages?.length, 2);
    assert.equal(body.surroundingMessagesGap, 'unavailable');

    await app.close();
  });

  test('derives role from message provenance.author', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const traceStore = new InjectionTraceStore(new FakeRedis());
    const messageStore = new MessageStore();

    const systemMsg = messageStore.append(
      canonicalTestMessageInput({
        userId: 'system',
        threadId: 't',
        catId: null,
        content: 'system notice',
        mentions: [],
        timestamp: 1000,
        provenance: { author: 'system', routed: false, observation: 'original' },
      }),
    );

    const snapshot = makeSnapshot({
      threadId: 't',
      turnId: '1',
      segmentId: 'S-test',
      overrides: { surroundingMessageIds: [systemMsg.id] },
    });
    await seedTurn(traceStore, {
      threadId: snapshot.threadId,
      turnId: snapshot.turnId,
      catId: snapshot.catId,
      timestamp: snapshot.timestamp,
    });
    await traceStore.persistReplaySnapshots(snapshot.threadId, snapshot.turnId, [snapshot]);

    const app = await buildReplayApp({ traceStore, messageStore, threadStore: makeThreadStore() });
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test/replay?threadId=t&turnId=1',
      headers: SESSION_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.surroundingMessages?.length, 1);
    assert.equal(body.surroundingMessages[0].role, 'system');

    await app.close();
  });

  test('persists snapshot hash atomically', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);
    const snapshot = makeSnapshot({ threadId: 't', turnId: '1', segmentId: 'S-test' });
    await seedTurn(store, { threadId: 't', turnId: '1', catId: snapshot.catId, timestamp: snapshot.timestamp });
    await store.persistReplaySnapshots(snapshot.threadId, snapshot.turnId, [snapshot]);

    const hash = redis.hashes.get('replay-snapshot:t:1');
    assert.ok(hash?.has('S-test'));
  });

  test('snapshot write is suppressed when turn has been deleted', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);
    const snapshot = makeSnapshot({ threadId: 't', turnId: '1', segmentId: 'S-test' });

    await store.deleteTurn('t', '1');
    await store.persistReplaySnapshots(snapshot.threadId, snapshot.turnId, [snapshot]);

    assert.equal(redis.hashes.has('replay-snapshot:t:1'), false);
  });

  test('deleteTurn removes all durable replay snapshots atomically', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);
    const s1 = makeSnapshot({ threadId: 't', turnId: '1', segmentId: 'S-a' });
    const s2 = makeSnapshot({ threadId: 't', turnId: '1', segmentId: 'S-b' });
    await seedTurn(store, { threadId: 't', turnId: '1', catId: s1.catId, timestamp: s1.timestamp });
    await store.persistReplaySnapshots('t', '1', [s1, s2]);

    await store.deleteTurn('t', '1');

    assert.equal(redis.hashes.has('replay-snapshot:t:1'), false);
  });
});
