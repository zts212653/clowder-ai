/**
 * #80 / F117: GET /api/messages folds a streaming draft into its durable response.
 *
 * Every dispatched cat turn owns a response message R, stored empty at admission as a
 * `processing` lifecycle response whose `lifecycle.invocationId` is the child turn id.
 * DraftStore keeps that turn's recoverable streamed body under the same id, and the client
 * renders history by message id only — so a draft is nothing but R's in-flight body.
 *
 * Verifies:
 * 1. Any page: a draft folds into its response on whichever page holds R (before cursor too)
 * 2. A draft folds into the processing response with the exact lifecycle.invocationId
 * 3. A draft without a processing response on the page is ignored (never a record, never deleted)
 * 4. Terminal responses are never overwritten by a stale draft
 * 5. userId isolation: drafts are scoped to the requesting user
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { DraftStore } from '../dist/domains/cats/services/stores/ports/DraftStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

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

// Production semantics: an unknown id resolves to null, never throws.
function makeStubRegistry() {
  return { getLatestId: () => null, getRecord: async () => null, register: () => {} };
}

function makeStubSocketManager() {
  return {
    broadcastToRoom: () => {},
    broadcastAgentMessage: () => {},
    getIO: () => ({}),
  };
}

function assertNoStandaloneDraftRecords(messages) {
  assert.deepEqual(
    messages.filter((message) => message.id.startsWith('draft-')).map((message) => message.id),
    [],
    'a draft must never become its own history record',
  );
}

describe('GET /api/messages — draft folds into its processing response (#80 / F117)', () => {
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

  async function getMessages(app, { userId = 'user-1', query = '' } = {}) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/messages?threadId=thread-1${query}`,
      headers: { 'x-cat-cafe-user': userId },
    });
    assert.equal(res.statusCode, 200);
    return res.json().messages;
  }

  /** Durable response R exactly as dispatch admission stores it (same shape as the exact-hydration test). */
  function appendResponse({
    turnId,
    timestamp,
    catId = 'opus',
    parentId = `parent-${turnId}`,
    stream = { invocationId: parentId, turnInvocationId: turnId },
    status = 'processing',
    content = '',
    userId = 'user-1',
  }) {
    return messageStore.append(
      canonicalTestMessageInput({
        userId,
        catId,
        content,
        mentions: [],
        timestamp,
        threadId: 'thread-1',
        origin: 'stream',
        extra: { stream },
        lifecycle: {
          kind: 'response',
          orderKey: `${timestamp}:${turnId}`,
          invocationId: turnId,
          targetId: catId,
          inputEntryIds: [`entry-${turnId}`],
          inputMessageIds: [`source-${turnId}`],
          status,
          startedAt: timestamp,
          ...(status === 'processing' ? {} : { completedAt: timestamp + 50 }),
        },
      }),
    );
  }

  function upsertDraft({ turnId, content, updatedAt, catId = 'opus', userId = 'user-1', ...body }) {
    draftStore.upsert({ userId, threadId: 'thread-1', invocationId: turnId, catId, content, updatedAt, ...body });
  }

  it('folds a draft into its response on whichever page holds it (before cursor included)', async () => {
    const ts = Date.now();
    const response = appendResponse({ turnId: 'turn-page', timestamp: ts });
    upsertDraft({ turnId: 'turn-page', content: 'Draft...', updatedAt: ts + 100 });
    // A long turn: newer messages arrive while R is still processing and push it off page one.
    for (let i = 1; i <= 3; i += 1) {
      messageStore.append(
        canonicalTestMessageInput({
          userId: 'user-1',
          catId: null,
          content: `newer ${i}`,
          mentions: [],
          timestamp: ts + i * 1000,
          threadId: 'thread-1',
        }),
      );
    }

    const app = await buildApp();
    const firstPage = await getMessages(app, { query: '&limit=3' });
    assert.equal(
      firstPage.some((message) => message.id === response.id),
      false,
      'R is no longer on the first page',
    );

    const secondPage = await getMessages(app, { query: `&limit=3&before=${ts + 1000}` });
    const paged = secondPage.find((message) => message.id === response.id);
    assert.ok(paged, 'the older page holds the processing response');
    assert.equal(paged.content, 'Draft...', 'R on an older page still reads its streamed body');
    assert.equal(paged.isDraft, true);
    assertNoStandaloneDraftRecords(secondPage);
  });

  it('never hydrates new pending-message recall tombstones or their body', async () => {
    const hidden = messageStore.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: null,
        content: 'zero exposure secret',
        mentions: ['opus'],
        timestamp: 1_000,
        threadId: 'thread-1',
        deliveryStatus: 'queued',
      }),
    );
    const second = messageStore.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: null,
        content: 'second pending secret',
        mentions: ['opus'],
        timestamp: 1_100,
        threadId: 'thread-1',
        deliveryStatus: 'queued',
      }),
    );
    assert.equal(
      messageStore.recallMessageToComposerDraft(hidden.id, {
        ownerUserId: 'user-1',
        threadId: 'thread-1',
        expectedDraftRevision: 0,
        merge: 'replace',
        recalledAt: 2_000,
      }).kind,
      'recalled',
    );
    assert.equal(
      messageStore.recallMessageToComposerDraft(second.id, {
        ownerUserId: 'user-1',
        threadId: 'thread-1',
        expectedDraftRevision: 1,
        merge: 'replace',
        recalledAt: 2_100,
      }).kind,
      'recalled',
    );

    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(response.statusCode, 200);
    const messages = response.json().messages;
    assert.equal(
      messages.some((message) => message.id === hidden.id),
      false,
    );
    assert.equal(
      messages.some((message) => message.id === second.id),
      false,
    );
    assert.doesNotMatch(JSON.stringify(messages), /zero exposure secret|second pending secret/);
  });

  it('hydrates a live draft into its exact processing lifecycle response', async () => {
    const ts = Date.now();
    const response = messageStore.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: 'opus',
        content: '',
        mentions: [],
        timestamp: ts,
        threadId: 'thread-1',
        origin: 'stream',
        extra: {
          stream: { invocationId: 'parent-live', turnInvocationId: 'turn-live' },
        },
        lifecycle: {
          kind: 'response',
          orderKey: `${ts}:turn-live`,
          invocationId: 'turn-live',
          targetId: 'opus',
          inputEntryIds: ['entry-live'],
          inputMessageIds: ['source-live'],
          status: 'processing',
          startedAt: ts,
        },
      }),
    );
    draftStore.upsert({
      userId: 'user-1',
      threadId: 'thread-1',
      invocationId: 'turn-live',
      catId: 'opus',
      content: 'Visible partial output',
      thinking: 'Visible thought',
      updatedAt: ts + 100,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/messages?threadId=thread-1',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(res.statusCode, 200);
    const matches = res
      .json()
      .messages.filter((message) => message.id === response.id || message.id === 'draft-turn-live');
    assert.equal(matches.length, 1, 'live content must reuse the canonical lifecycle response bubble');
    assert.equal(matches[0].id, response.id);
    assert.equal(matches[0].content, 'Visible partial output');
    assert.equal(matches[0].thinking, 'Visible thought');
    assert.equal(matches[0].isDraft, true);
    assert.equal(matches[0].lifecycle.status, 'processing');
  });

  it('folds a tool-only draft (empty content) into its processing response', async () => {
    const ts = Date.now();
    const response = appendResponse({ turnId: 'turn-tool-first', timestamp: ts });
    upsertDraft({
      turnId: 'turn-tool-first',
      content: '',
      toolEvents: [{ id: 'te-1', type: 'tool_use', label: 'Read file', timestamp: ts + 500 }],
      updatedAt: ts + 500,
    });

    const messages = await getMessages(await buildApp());
    const folded = messages.find((message) => message.id === response.id);
    assert.equal(folded.isDraft, true, 'an empty-text draft is still the live body of its response');
    assert.equal(folded.content, '');
    assert.deepEqual(
      folded.toolEvents.map((event) => event.label),
      ['Read file'],
    );
    assertNoStandaloneDraftRecords(messages);
  });

  it('folds thinking and tool events into the response without replacing its identity', async () => {
    const ts = Date.now();
    const response = appendResponse({ turnId: 'turn-contract', parentId: 'parent-contract', timestamp: ts });
    upsertDraft({
      turnId: 'turn-contract',
      content: 'Partial text...',
      thinking: 'Let me think about this...',
      toolEvents: [{ id: 'te-1', type: 'tool_use', label: 'Read', timestamp: ts }],
      updatedAt: ts + 100,
    });

    const folded = (await getMessages(await buildApp())).find((message) => message.id === response.id);
    assert.equal(folded.content, 'Partial text...');
    assert.equal(folded.thinking, 'Let me think about this...');
    assert.equal(folded.toolEvents.length, 1);
    // The draft contributes body only; identity stays the response's own.
    assert.equal(folded.catId, 'opus');
    assert.equal(folded.origin, 'stream');
    assert.deepEqual(folded.extra?.stream, { invocationId: 'parent-contract', turnInvocationId: 'turn-contract' });
    assert.equal(folded.lifecycle.invocationId, 'turn-contract');
    assert.equal(folded.lifecycle.status, 'processing');
  });

  it('folds concurrent drafts of one parent into their own responses, in response order', async () => {
    const ts = Date.now();
    const opus = appendResponse({ turnId: 'turn-opus', catId: 'opus', parentId: 'parent-fanout', timestamp: ts });
    const codex = appendResponse({
      turnId: 'turn-codex',
      catId: 'codex',
      parentId: 'parent-fanout',
      timestamp: ts + 1,
    });
    // Draft recency is the reverse of response order: position must come from the response.
    upsertDraft({ turnId: 'turn-codex', catId: 'codex', content: 'Codex draft', updatedAt: ts + 100 });
    upsertDraft({ turnId: 'turn-opus', catId: 'opus', content: 'Opus draft', updatedAt: ts + 200 });

    const messages = await getMessages(await buildApp());
    assert.deepEqual(
      messages
        .filter((message) => message.isDraft === true)
        .map((message) => [message.id, message.catId, message.content]),
      [
        [opus.id, 'opus', 'Opus draft'],
        [codex.id, 'codex', 'Codex draft'],
      ],
    );
    assertNoStandaloneDraftRecords(messages);
  });

  it('ignores drafts whose turn has no processing response on the page, without deleting them', async () => {
    const ts = Date.now();
    appendResponse({ turnId: 'turn-offpage', timestamp: ts });
    messageStore.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: null,
        content: 'Filler',
        mentions: [],
        timestamp: ts + 1,
        threadId: 'thread-1',
      }),
    );
    const live = appendResponse({ turnId: 'turn-live', timestamp: ts + 2 });
    upsertDraft({ turnId: 'turn-offpage', content: 'Off-page partial', updatedAt: ts + 100 });
    upsertDraft({ turnId: 'turn-orphan', content: 'Orphan partial', updatedAt: ts + 100 });
    upsertDraft({ turnId: 'turn-live', content: 'Live partial', updatedAt: ts + 100 });

    const messages = await getMessages(await buildApp(), { query: '&limit=2' });
    assert.equal(messages.length, 2, 'drafts never add rows to the page');
    assert.deepEqual(
      messages.filter((message) => message.isDraft === true).map((message) => message.id),
      [live.id],
    );
    assert.doesNotMatch(JSON.stringify(messages), /Off-page partial|Orphan partial/);
    assertNoStandaloneDraftRecords(messages);
    assert.equal(draftStore.getByThread('user-1', 'thread-1').length, 3, 'a history read never deletes drafts');
  });

  it('does not read DraftStore when the page has no processing response', async () => {
    const ts = Date.now();
    messageStore.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: null,
        content: 'Hello',
        mentions: [],
        timestamp: ts,
        threadId: 'thread-1',
      }),
    );
    appendResponse({ turnId: 'turn-done', timestamp: ts + 1, status: 'completed', content: 'Done' });
    upsertDraft({ turnId: 'turn-orphan', content: 'Orphan partial', updatedAt: ts + 100 });
    let draftReads = 0;
    const getByThread = draftStore.getByThread.bind(draftStore);
    draftStore.getByThread = (...args) => {
      draftReads += 1;
      return getByThread(...args);
    };

    const messages = await getMessages(await buildApp());
    assert.equal(draftReads, 0);
    assert.equal(messages.length, 2);
    assert.equal(
      messages.some((message) => message.isDraft === true),
      false,
    );
  });

  it('never binds a draft to a response whose lifecycle.invocationId differs', async () => {
    const ts = Date.now();
    const opus = appendResponse({ turnId: 'turn-opus', catId: 'opus', parentId: 'parent-fanout', timestamp: ts });
    const codex = appendResponse({
      turnId: 'turn-codex',
      catId: 'codex',
      timestamp: ts + 1,
      // Only lifecycle.invocationId names the turn; stream ids are never a binding key.
      stream: { invocationId: 'parent-fanout', turnInvocationId: 'turn-codex-stream-alias' },
    });
    upsertDraft({ turnId: 'parent-fanout', content: 'Parent-keyed partial', updatedAt: ts + 100 });
    upsertDraft({ turnId: 'turn-opus-sibling', content: 'Sibling child partial', updatedAt: ts + 100 });
    upsertDraft({ turnId: 'turn-codex-stream-alias', catId: 'codex', content: 'Alias partial', updatedAt: ts + 100 });

    const messages = await getMessages(await buildApp());
    for (const response of [opus, codex]) {
      const item = messages.find((message) => message.id === response.id);
      assert.equal(item.content, '', `${response.catId} must keep its own (empty) body`);
      assert.equal(item.isDraft, undefined);
      assert.equal(item.lifecycle.status, 'processing');
    }
    assert.doesNotMatch(JSON.stringify(messages), /Parent-keyed partial|Sibling child partial|Alias partial/);
    assertNoStandaloneDraftRecords(messages);
  });

  for (const status of ['completed', 'failed', 'canceled', 'interrupted']) {
    it(`never overwrites a terminal (${status}) response with a stale draft of the same turn`, async () => {
      const ts = Date.now();
      const response = appendResponse({ turnId: 'turn-settled', timestamp: ts, status, content: 'Settled body' });
      upsertDraft({ turnId: 'turn-settled', content: 'Stale partial', thinking: 'Stale thought', updatedAt: ts + 100 });

      const messages = await getMessages(await buildApp());
      const settled = messages.find((message) => message.id === response.id);
      assert.equal(settled.content, 'Settled body');
      assert.equal(settled.isDraft, undefined);
      assert.equal(settled.thinking, undefined);
      assert.equal(settled.lifecycle.status, status);
      assert.doesNotMatch(JSON.stringify(messages), /Stale partial|Stale thought/);
      assertNoStandaloneDraftRecords(messages);
    });
  }

  it('userId isolation: never folds another user draft', async () => {
    const ts = Date.now();
    const response = appendResponse({ turnId: 'turn-shared', timestamp: ts, userId: 'user-A' });
    upsertDraft({ turnId: 'turn-shared', content: 'Secret draft', updatedAt: ts + 100, userId: 'user-B' });

    const messages = await getMessages(await buildApp(), { userId: 'user-A' });
    const own = messages.find((message) => message.id === response.id);
    assert.equal(own.content, '');
    assert.equal(own.isDraft, undefined, 'User A must not see User B drafts');
    assert.doesNotMatch(JSON.stringify(messages), /Secret draft/);
  });
});
