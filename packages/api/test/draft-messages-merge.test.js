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
