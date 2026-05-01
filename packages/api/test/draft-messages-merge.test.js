/**
 * #80: Tests for GET /api/messages draft merge behavior.
 *
 * Verifies:
 * 1. First page (no cursor) includes active drafts
 * 2. Pagination (with before cursor) excludes drafts
 * 3. invocationId-based dedup filters drafts that match formal messages
 * 4. userId isolation: drafts scoped to requesting user
 * 5. Draft messages have isDraft flag for frontend streaming indicator
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { DraftStore } from '../dist/domains/cats/services/stores/ports/DraftStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';

// Minimal mock router that satisfies the type contract
function makeStubRouter() {
  return {
    resolveTargetsAndIntent: async () => ({
      targetCats: ['opus'],
      intent: { intent: 'execute', promptTags: [], targets: ['opus'] },
    }),
    route: async function* () {},
    routeExecution: async function* () {},
    getStrategyDeps: () => ({}),
    ackCollectedCursors: async () => {},
  };
}

// Minimal mock dependencies
function makeStubRegistry() {
  return { getLatestId: () => null, register: () => {} };
}

function makeStubSocketManager() {
  return {
    broadcastToRoom: () => {},
    broadcastAgentMessage: () => {},
    getIO: () => ({}),
  };
}

function makeInvocationRecordStore(records = {}) {
  const byId = new Map(Object.entries(records));
  return {
    create: () => {
      throw new Error('not implemented');
    },
    get: async (id) => byId.get(id) ?? null,
    update: () => {
      throw new Error('not implemented');
    },
    getByIdempotencyKey: () => null,
  };
}

function makeInvocationTracker({ activeSlotsByThread = {}, userIds = {} } = {}) {
  return {
    has: (threadId, catId) =>
      catId
        ? Boolean(activeSlotsByThread[threadId]?.some((slot) => slot.catId === catId))
        : Boolean(activeSlotsByThread[threadId]?.length),
    getUserId: (threadId, catId) => userIds[`${threadId}:${catId}`] ?? null,
    cancel: () => ({ cancelled: false, catIds: [] }),
    getActiveSlots: (threadId) => activeSlotsByThread[threadId] ?? [],
  };
}

describe('GET /api/messages — draft merge (#80)', () => {
  /** @type {MessageStore} */
  let messageStore;
  /** @type {DraftStore} */
  let draftStore;

  beforeEach(() => {
    messageStore = new MessageStore();
    draftStore = new DraftStore();
  });

  async function buildApp() {
    const app = Fastify({ logger: false });
    await app.register(messagesRoutes, {
      registry: makeStubRegistry(),
      messageStore,
      socketManager: makeStubSocketManager(),
      router: makeStubRouter(),
      draftStore,
    });
    return app;
  }

  async function buildAppWithInvocationRecords(records) {
    const app = Fastify({ logger: false });
    await app.register(messagesRoutes, {
      registry: makeStubRegistry(),
      messageStore,
      socketManager: makeStubSocketManager(),
      router: makeStubRouter(),
      draftStore,
      invocationRecordStore: makeInvocationRecordStore(records),
    });
    return app;
  }

  async function buildAppWithInvocationRecordStore(invocationRecordStore, invocationTracker) {
    const app = Fastify({ logger: false });
    await app.register(messagesRoutes, {
      registry: makeStubRegistry(),
      messageStore,
      socketManager: makeStubSocketManager(),
      router: makeStubRouter(),
      draftStore,
      invocationRecordStore,
      ...(invocationTracker ? { invocationTracker } : {}),
    });
    return app;
  }

  function makeInvocationRecord(invocationId, status, ts = Date.now()) {
    return {
      id: invocationId,
      threadId: 'thread-1',
      userId: 'user-1',
      userMessageId: 'msg-user',
      targetCats: ['opus'],
      intent: 'execute',
      status,
      idempotencyKey: `key-${invocationId}`,
      createdAt: ts - 1000,
      updatedAt: ts,
    };
  }

  it('includes active drafts on first page (no cursor)', async () => {
    // Seed a formal message
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'Hello',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-1',
    });

    // Seed an active draft
    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-active',
      catId: 'opus',
      content: 'Draft content...',
      updatedAt: Date.now(),
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const messages = body.messages;

    // Should have the formal message + the draft
    assert(messages.length >= 2, `Expected at least 2 messages, got ${messages.length}`);
    const draft = messages.find((m) => m.id === 'draft-inv-active');
    assert(draft, 'Draft message should be included');
    assert.equal(draft.isDraft, true, 'Draft should have isDraft flag');
    assert.equal(draft.content, 'Draft content...');
    assert.equal(draft.catId, 'opus');
  });

  it('excludes drafts on paginated request (with before cursor)', async () => {
    // Seed messages
    const ts = Date.now();
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'First',
      mentions: [],
      timestamp: ts - 1000,
      threadId: 'thread-1',
    });

    // Seed a draft
    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-active',
      catId: 'opus',
      content: 'Draft...',
      updatedAt: ts,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/messages?threadId=thread-1&before=${ts + 1000}`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const hasDraft = body.messages.some((m) => m.isDraft === true);
    assert.equal(hasDraft, false, 'Paginated request should not include drafts');
  });

  it('deduplicates draft when formal message has matching invocationId', async () => {
    const ts = Date.now();

    // Formal message with invocationId in extra.stream
    messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'Completed message',
      mentions: [],
      timestamp: ts,
      threadId: 'thread-1',
      extra: { stream: { invocationId: 'inv-completed' } },
    });

    // Draft with same invocationId (the race window between append and delete)
    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-completed',
      catId: 'opus',
      content: 'Stale draft...',
      updatedAt: ts - 500,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const draftMsg = body.messages.find((m) => m.isDraft === true);
    assert.equal(draftMsg, undefined, 'Deduped draft should not appear in response');

    // Formal message should still be there
    const formal = body.messages.find((m) => m.content === 'Completed message');
    assert(formal, 'Formal message should be present');
  });

  it('keeps draft when invocation record is still running (F173 hotfix3)', async () => {
    const ts = Date.now();
    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-running',
      catId: 'opus',
      content: 'Still streaming...',
      updatedAt: ts,
    });

    const app = await buildAppWithInvocationRecords({
      'inv-running': makeInvocationRecord('inv-running', 'running', ts),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const draft = body.messages.find((m) => m.id === 'draft-inv-running');
    assert(draft, 'Running invocation draft should remain visible');
    assert.equal(draft.content, 'Still streaming...');
    assert.equal(draftStore.getByThread('user-1', 'thread-1').length, 1, 'Running draft should not be deleted');
  });

  it('keeps draft visible when invocation record is missing but tracker slot is active', async () => {
    const ts = Date.now();
    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-tracker-live',
      catId: 'opus',
      content: 'Streaming draft backed by tracker',
      updatedAt: ts,
    });

    const app = await buildAppWithInvocationRecordStore(
      makeInvocationRecordStore({}),
      makeInvocationTracker({
        activeSlotsByThread: { 'thread-1': [{ catId: 'opus', startedAt: ts - 1000 }] },
        userIds: { 'thread-1:opus': 'user-1' },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const draft = body.messages.find((m) => m.id === 'draft-inv-tracker-live');
    assert(draft, 'Tracker-active draft should remain visible even when record store is stale');
    assert.equal(draft.content, 'Streaming draft backed by tracker');
    assert.equal(draftStore.getByThread('user-1', 'thread-1').length, 1, 'Tracker-active draft should not be deleted');
  });

  it('keeps draft visible when invocation record is terminal but tracker slot is active', async () => {
    const ts = Date.now();
    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-terminal-record-tracker-live',
      catId: 'opus',
      content: 'Tracker wins over stale terminal record',
      updatedAt: ts,
    });

    const app = await buildAppWithInvocationRecordStore(
      makeInvocationRecordStore({
        'inv-terminal-record-tracker-live': makeInvocationRecord('inv-terminal-record-tracker-live', 'failed', ts),
      }),
      makeInvocationTracker({
        activeSlotsByThread: { 'thread-1': [{ catId: 'opus', startedAt: ts - 1000 }] },
        userIds: { 'thread-1:opus': 'user-1' },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const draft = body.messages.find((m) => m.id === 'draft-inv-terminal-record-tracker-live');
    assert(draft, 'Tracker-active draft should remain visible when record status is stale');
    assert.equal(draftStore.getByThread('user-1', 'thread-1').length, 1, 'Tracker-active draft should not be deleted');
  });

  it('keeps draft visible when tracker liveness lookup fails', async () => {
    const ts = Date.now();
    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-tracker-lookup-error',
      catId: 'opus',
      content: 'Draft should survive tracker lookup errors',
      updatedAt: ts,
    });

    const app = await buildAppWithInvocationRecordStore(makeInvocationRecordStore({}), {
      ...makeInvocationTracker(),
      getActiveSlots: () => {
        throw new Error('tracker unavailable');
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const draft = body.messages.find((m) => m.id === 'draft-inv-tracker-lookup-error');
    assert(draft, 'Tracker lookup failure should fail open and keep the draft visible');
    assert.equal(
      draftStore.getByThread('user-1', 'thread-1').length,
      1,
      'Tracker lookup failure should not delete draft',
    );
  });

  it('does not treat a newer tracker slot within the prior skew window as proof for an older draft', async () => {
    const ts = Date.now();
    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-old-draft',
      catId: 'opus',
      content: 'Old draft from previous invocation',
      updatedAt: ts,
    });

    const app = await buildAppWithInvocationRecordStore(
      makeInvocationRecordStore({}),
      makeInvocationTracker({
        activeSlotsByThread: { 'thread-1': [{ catId: 'opus', startedAt: ts + 500 }] },
        userIds: { 'thread-1:opus': 'user-1' },
      }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const oldDraft = body.messages.find((m) => m.id === 'draft-inv-old-draft');
    assert.equal(oldDraft, undefined, 'Newer tracker slot inside the old skew window must not revive an older draft');
    assert.equal(
      draftStore.getByThread('user-1', 'thread-1').length,
      1,
      'Filtered draft should remain for TTL cleanup',
    );
  });

  it('filters orphan draft without deleting it when invocation record is missing (F173 hotfix3)', async () => {
    const ts = Date.now();
    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-orphan',
      catId: 'opus',
      content: 'Zombie draft from missing invocation',
      updatedAt: ts,
    });

    const app = await buildAppWithInvocationRecords({});
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const orphan = body.messages.find((m) => m.id === 'draft-inv-orphan');
    assert.equal(orphan, undefined, 'Orphan draft should not appear in GET /api/messages response');
    assert.equal(draftStore.getByThread('user-1', 'thread-1').length, 1, 'GET should not delete orphan drafts');
  });

  it('filters draft without deleting it when invocation record is no longer running (F173 hotfix3)', async () => {
    const ts = Date.now();
    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-failed',
      catId: 'opus',
      content: 'Failed invocation draft',
      updatedAt: ts,
    });

    const app = await buildAppWithInvocationRecords({
      'inv-failed': makeInvocationRecord('inv-failed', 'failed', ts),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const failedDraft = body.messages.find((m) => m.id === 'draft-inv-failed');
    assert.equal(failedDraft, undefined, 'Non-running invocation draft should not appear');
    assert.equal(draftStore.getByThread('user-1', 'thread-1').length, 1, 'GET should not delete non-running drafts');
  });

  for (const status of ['succeeded', 'canceled']) {
    it(`filters draft without deleting it when invocation record is ${status} (F173 hotfix3)`, async () => {
      const ts = Date.now();
      const invocationId = `inv-${status}`;
      draftStore.upsert({
        userId: 'user-1',
        threadId: 'thread-1',
        invocationId,
        catId: 'opus',
        content: `${status} invocation draft`,
        updatedAt: ts,
      });

      const app = await buildAppWithInvocationRecords({
        [invocationId]: makeInvocationRecord(invocationId, status, ts),
      });
      const res = await app.inject({
        method: 'GET',
        url: '/api/messages?threadId=thread-1',
        headers: { 'x-cat-cafe-user': 'user-1' },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      const terminalDraft = body.messages.find((m) => m.id === `draft-${invocationId}`);
      assert.equal(terminalDraft, undefined, 'Terminal invocation draft should not appear');
      assert.equal(draftStore.getByThread('user-1', 'thread-1').length, 1, 'GET should not delete terminal drafts');
    });
  }

  it('keeps draft visible when invocation record lookup fails (F173 hotfix3)', async () => {
    const ts = Date.now();
    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-redis-blip',
      catId: 'opus',
      content: 'Draft during transient invocation store failure',
      updatedAt: ts,
    });

    const app = await buildAppWithInvocationRecordStore({
      create: () => {
        throw new Error('not implemented');
      },
      get: async () => {
        throw new Error('transient redis read failure');
      },
      update: () => {
        throw new Error('not implemented');
      },
      getByIdempotencyKey: () => null,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const draft = body.messages.find((m) => m.id === 'draft-inv-redis-blip');
    assert(draft, 'Draft should remain visible when liveness lookup is unavailable');
    assert.equal(
      draftStore.getByThread('user-1', 'thread-1').length,
      1,
      'Draft should not be deleted when liveness lookup fails',
    );
  });

  it('userId isolation: cannot see other user drafts', async () => {
    // Draft from user-B
    draftStore.upsert({
      userId: 'user-B',
      threadId: 'thread-1',
      invocationId: 'inv-secret',
      catId: 'opus',
      content: 'Secret draft',
      updatedAt: Date.now(),
    });

    // Seed a message so user-A gets non-empty response
    messageStore.append({
      userId: 'user-A',
      catId: null,
      content: 'Hi',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-1',
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'user-A' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const hasDraft = body.messages.some((m) => m.isDraft === true);
    assert.equal(hasDraft, false, 'User A should not see User B drafts');
  });

  it('deduplicates draft when formal message is pushed off first page (cloud R4 P2)', async () => {
    const ts = Date.now();

    // 1. Seed the formal message with invocationId (oldest — will be pushed off page)
    messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'Completed streaming response',
      mentions: [],
      timestamp: ts,
      threadId: 'thread-1',
      extra: { stream: { invocationId: 'inv-offpage' } },
    });

    // 2. Seed enough newer messages to push formal off the first page
    //    Using limit=5 via query param, so we need 5 newer messages
    for (let i = 1; i <= 5; i++) {
      messageStore.append({
        userId: 'user-1',
        catId: null,
        content: `Filler message ${i}`,
        mentions: [],
        timestamp: ts + i * 1000,
        threadId: 'thread-1',
      });
    }

    // 3. Draft with same invocationId (stale — should be deduped by wider query)
    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-offpage',
      catId: 'opus',
      content: 'Stale draft from completed invocation',
      updatedAt: ts + 6000,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1&limit=5',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    // The formal message should NOT be on the page (pushed off by filler)
    const formalOnPage = body.messages.find((m) => m.content === 'Completed streaming response');
    assert.equal(formalOnPage, undefined, 'Formal message should be off-page');

    // The stale draft should be deduped by the wider 200-message query
    const staleDraft = body.messages.find((m) => m.id === 'draft-inv-offpage');
    assert.equal(staleDraft, undefined, 'Off-page formal should still dedup the draft');

    // hasMore should be true (6 total messages, limit=5)
    assert.equal(body.hasMore, true, 'Should have more pages');
  });

  it('wider dedup window exceeds page limit when limit equals API max (cloud R5 P2)', async () => {
    const ts = Date.now();

    // 1. Seed the formal message (will be the 201st oldest → pushed off a 200-message page)
    messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'Completed at max-limit edge',
      mentions: [],
      timestamp: ts,
      threadId: 'thread-1',
      extra: { stream: { invocationId: 'inv-maxlimit' } },
    });

    // 2. Seed 200 newer messages to push formal off the first page at limit=200
    for (let i = 1; i <= 200; i++) {
      messageStore.append({
        userId: 'user-1',
        catId: null,
        content: `Filler ${i}`,
        mentions: [],
        timestamp: ts + i * 100,
        threadId: 'thread-1',
      });
    }

    // 3. Stale draft with same invocationId
    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-maxlimit',
      catId: 'opus',
      content: 'Stale draft at max limit',
      updatedAt: ts + 30000,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1&limit=200',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    // With old code (wider=200), this draft would leak because wider == limit
    const staleDraft = body.messages.find((m) => m.id === 'draft-inv-maxlimit');
    assert.equal(staleDraft, undefined, 'Wider window must exceed limit=200 to catch off-page formal');
  });

  it('includes tool-only draft with empty content (cloud R6 P1)', async () => {
    const ts = Date.now();

    // Seed a user message so the thread has content
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'Do something',
      mentions: [],
      timestamp: ts,
      threadId: 'thread-1',
    });

    // Tool-first draft: no text yet, only tool events
    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-tool-first',
      catId: 'opus',
      content: '',
      toolEvents: [{ id: 'te-1', type: 'tool_use', label: 'Read file', timestamp: ts + 500 }],
      updatedAt: ts + 500,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    const draft = body.messages.find((m) => m.id === 'draft-inv-tool-first');
    assert(draft, 'Tool-only draft should appear even with empty content');
    assert.equal(draft.isDraft, true);
    assert.equal(draft.content, '');
    assert.equal(draft.toolEvents.length, 1);
    assert.equal(draft.toolEvents[0].label, 'Read file');
  });

  it('draft response includes origin, extra.stream.invocationId, and thinking (Bug A+B contract)', async () => {
    const ts = Date.now();

    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'Hello',
      mentions: [],
      timestamp: ts,
      threadId: 'thread-1',
    });

    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-contract',
      catId: 'opus',
      content: 'Partial text...',
      thinking: 'Let me think about this...',
      toolEvents: [{ id: 'te-1', type: 'tool_use', label: 'Read', timestamp: ts }],
      updatedAt: ts + 100,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const draft = body.messages.find((m) => m.id === 'draft-inv-contract');
    assert(draft, 'Draft should be present');

    // Bug A: thinking must be included
    assert.equal(draft.thinking, 'Let me think about this...', 'Draft should include thinking');

    // Bug B: stream identity must be included for frontend reconciliation
    assert.equal(draft.origin, 'stream', 'Draft should have origin: stream');
    assert.deepEqual(
      draft.extra?.stream,
      { invocationId: 'inv-contract' },
      'Draft should have extra.stream.invocationId',
    );
  });

  it('multiple concurrent drafts sorted by updatedAt', async () => {
    const now = Date.now();
    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-codex',
      catId: 'codex',
      content: 'Codex draft',
      updatedAt: now - 500,
    });
    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'inv-opus',
      catId: 'opus',
      content: 'Opus draft',
      updatedAt: now,
    });

    // Seed a formal message to have a non-empty page
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'Question',
      mentions: [],
      timestamp: now - 1000,
      threadId: 'thread-1',
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const drafts = body.messages.filter((m) => m.isDraft === true);
    assert.equal(drafts.length, 2);
    // Codex (older) should come before Opus (newer)
    assert.equal(drafts[0].catId, 'codex');
    assert.equal(drafts[1].catId, 'opus');
  });
});
