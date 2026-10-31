/**
 * F98 Route Inject Tests — Review P1
 * Fastify inject tests for session-transcript route changes:
 * - GET /api/sessions/:sessionId/events?view=  (view modes)
 * - GET /api/sessions/:sessionId/invocations/:invocationId
 *
 * Also covers P2-1 (extractTextContent type guard) and P2-2 (keyMessages limit).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

function mockThreadStore(threads = {}) {
  return {
    get: async (id) => threads[id] ?? null,
    list: async () => Object.values(threads),
    create: async () => {},
    update: async () => null,
    delete: async () => false,
  };
}

describe('F98 Route Inject: session-transcript', () => {
  let app;
  let tmpDir;

  const THREAD = { id: 'thread-1', createdBy: 'user-1' };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'f98-route-'));
  });

  afterEach(async () => {
    if (app) await app.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setup() {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');
    const { TranscriptReader } = await import('../dist/domains/cats/services/session/TranscriptReader.js');
    const { sessionTranscriptRoutes } = await import('../dist/routes/session-transcript.js');

    const sessionChainStore = new SessionChainStore();
    const threadStore = mockThreadStore({ 'thread-1': THREAD });
    const transcriptReader = new TranscriptReader({ dataDir: tmpDir });
    const writer = new TranscriptWriter({ dataDir: tmpDir });

    app = Fastify();
    await app.register(sessionTranscriptRoutes, {
      sessionChainStore,
      threadStore,
      transcriptReader,
    });
    await app.ready();

    return { sessionChainStore, writer, transcriptReader };
  }

  async function createSessionWithEvents(sessionChainStore, writer) {
    const record = sessionChainStore.create({
      cliSessionId: 'cli-1',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });
    const sessInfo = {
      sessionId: record.id,
      threadId: 'thread-1',
      catId: 'opus',
      cliSessionId: 'cli-1',
      seq: 0,
    };
    const invId = 'inv-test-001';

    writer.appendEvent(
      sessInfo,
      {
        type: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
      invId,
    );
    writer.appendEvent(
      sessInfo,
      {
        type: 'assistant',
        content: [{ type: 'text', text: 'Hi there!' }],
      },
      invId,
    );
    writer.appendEvent(
      sessInfo,
      {
        type: 'tool_use',
        name: 'Read',
        input: { file_path: '/a.ts' },
      },
      invId,
    );

    // Seal so transcript is readable
    sessionChainStore.update(record.id, { status: 'sealed' });
    await writer.flush(sessInfo, { createdAt: 1000, sealedAt: 2000 });

    return { record, invId };
  }

  it('F324: raw event pages are bounded and a large event has exact character continuation', async () => {
    const { sessionChainStore, writer, transcriptReader } = await setup();
    const record = sessionChainStore.create({
      cliSessionId: 'cli-large',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });
    const info = { sessionId: record.id, threadId: 'thread-1', catId: 'opus', cliSessionId: 'cli-large', seq: 0 };
    writer.appendEvent(info, { type: 'assistant', content: 'x'.repeat(250_000) }, 'inv-large');
    for (let index = 0; index < 200; index += 1) {
      writer.appendEvent(info, { type: 'assistant', content: `small-${index}-${'y'.repeat(300)}` }, 'inv-large');
    }
    sessionChainStore.update(record.id, { status: 'sealed' });
    await writer.flush(info, { createdAt: 1000, sealedAt: 2000 });
    const headers = { 'x-cat-cafe-user': 'user-1' };
    const first = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events?cursor=0&limit=200`,
      headers,
    });
    assert.equal(first.statusCode, 200, first.body.slice(0, 500));
    assert.ok(first.body.length <= 24_000, `raw page used ${first.body.length} chars`);
    assert.equal(first.json().events[0].oversized, true);
    assert.ok(first.json().nextCursor.eventNo > 0 && first.json().nextCursor.eventNo < 201);

    const expected = JSON.stringify(
      (await transcriptReader.readEvents(record.id, 'thread-1', 'opus', { eventNo: 0 }, 1)).events[0].event,
    );
    let offset = 0;
    let recovered = '';
    for (let page = 0; page < 40; page += 1) {
      const slice = await app.inject({
        method: 'GET',
        url: `/api/sessions/${record.id}/events?cursor=0&limit=1&charOffset=${offset}`,
        headers,
      });
      assert.equal(slice.statusCode, 200);
      const body = slice.json();
      assert.ok(slice.body.length <= 24_000);
      recovered += body.eventSlice;
      if (body.nextCharOffset === undefined) break;
      assert.ok(body.nextCharOffset > offset);
      offset = body.nextCharOffset;
    }
    assert.equal(recovered.length, expected.length);
    assert.equal(
      createHash('sha256').update(recovered).digest('hex'),
      createHash('sha256').update(expected).digest('hex'),
    );
  });

  it('F324: invocation detail cursor pages the exact invocation event stream', async () => {
    const { sessionChainStore, writer } = await setup();
    const record = sessionChainStore.create({
      cliSessionId: 'cli-page',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });
    const info = { sessionId: record.id, threadId: 'thread-1', catId: 'opus', cliSessionId: 'cli-page', seq: 0 };
    for (let index = 0; index < 100; index += 1) {
      writer.appendEvent(info, { type: 'text', content: `inv-${index}-${'x'.repeat(400)}` }, 'inv-page');
    }
    sessionChainStore.update(record.id, { status: 'sealed' });
    await writer.flush(info, { createdAt: 1000, sealedAt: 2000 });
    const headers = { 'x-cat-cafe-user': 'user-1' };
    const first = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/invocations/inv-page?cursor=0&limit=100`,
      headers,
    });
    assert.equal(first.statusCode, 200);
    assert.ok(first.body.length <= 24_000);
    assert.ok(first.json().nextCursor.eventNo > 0 && first.json().nextCursor.eventNo < 100);
    const second = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/invocations/inv-page?cursor=${first.json().nextCursor.eventNo}&limit=100`,
      headers,
    });
    assert.equal(second.json().events[0].eventNo, first.json().nextCursor.eventNo);
  });

  it('F324: oversized digest has exact character continuation', async () => {
    const { sessionChainStore, writer } = await setup();
    const { record } = await createSessionWithEvents(sessionChainStore, writer);
    const digest = { v: 1, body: 'z'.repeat(250_000) };
    await writeFile(
      join(tmpDir, 'threads', 'thread-1', 'opus', 'sessions', record.id, 'digest.extractive.json'),
      JSON.stringify(digest),
    );
    const headers = { 'x-cat-cafe-user': 'user-1' };
    const first = await app.inject({ method: 'GET', url: `/api/sessions/${record.id}/digest`, headers });
    assert.equal(first.statusCode, 200);
    assert.ok(first.body.length <= 24_000);
    assert.equal(first.json().oversized, true);
    let offset = 0;
    let recovered = '';
    for (let page = 0; page < 40; page += 1) {
      const slice = await app.inject({
        method: 'GET',
        url: `/api/sessions/${record.id}/digest?charOffset=${offset}`,
        headers,
      });
      assert.equal(slice.statusCode, 200);
      const body = slice.json();
      assert.ok(slice.body.length <= 24_000);
      recovered += body.digestSlice;
      if (body.nextCharOffset === undefined) break;
      offset = body.nextCharOffset;
    }
    const expected = JSON.stringify(digest);
    assert.equal(recovered.length, expected.length);
    assert.equal(
      createHash('sha256').update(recovered).digest('hex'),
      createHash('sha256').update(expected).digest('hex'),
    );
  });

  it('F324: chat and handoff projections stay bounded with source drills', async () => {
    const { sessionChainStore, writer } = await setup();
    const record = sessionChainStore.create({
      cliSessionId: 'cli-views',
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
    });
    const info = { sessionId: record.id, threadId: 'thread-1', catId: 'opus', cliSessionId: 'cli-views', seq: 0 };
    for (let index = 0; index < 200; index += 1) {
      writer.appendEvent(info, { type: 'assistant', content: `chat-${index}-${'x'.repeat(400)}` }, 'inv-views');
      writer.appendEvent(info, { type: 'tool_use', toolName: `tool-${index}` }, 'inv-views');
    }
    sessionChainStore.update(record.id, { status: 'sealed' });
    await writer.flush(info, { createdAt: 1000, sealedAt: 2000 });
    const headers = { 'x-cat-cafe-user': 'user-1' };
    const chat = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events?view=chat&limit=200`,
      headers,
    });
    assert.ok(chat.body.length <= 24_000, `chat page used ${chat.body.length} chars`);
    assert.equal(chat.json().messages[0].eventNo, 0);
    assert.ok(chat.json().nextCursor.eventNo > 0);
    const handoff = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events?view=handoff&limit=200`,
      headers,
    });
    assert.ok(handoff.body.length <= 24_000, `handoff page used ${handoff.body.length} chars`);
    assert.equal(handoff.json().invocations[0].invocationId, 'inv-views');
    assert.ok(handoff.json().invocations[0].oversized);
    assert.equal(handoff.json().invocations[0].drillDown.tool, 'cat_cafe_read_invocation_detail');
  });

  // --- Auth tests ---

  it('GET /events returns 401 without identity', async () => {
    const { sessionChainStore, writer } = await setup();
    const { record } = await createSessionWithEvents(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events`,
    });
    assert.equal(res.statusCode, 401);
  });

  it('GET /events returns 403 for wrong user', async () => {
    const { sessionChainStore, writer } = await setup();
    const { record } = await createSessionWithEvents(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events`,
      headers: { 'x-cat-cafe-user': 'other-user' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('GET /events returns 404 for unknown session', async () => {
    await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/nonexistent/events',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 404);
  });

  // --- view parameter tests ---

  it('GET /events?view=invalid returns 400', async () => {
    const { sessionChainStore, writer } = await setup();
    const { record } = await createSessionWithEvents(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events?view=banana`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Invalid view'));
  });

  it('GET /events?view=raw returns events array (backward compat)', async () => {
    const { sessionChainStore, writer } = await setup();
    const { record } = await createSessionWithEvents(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events?view=raw`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.events));
    assert.equal(body.events.length, 3);
  });

  it('GET /events (no view) returns raw events (default)', async () => {
    const { sessionChainStore, writer } = await setup();
    const { record } = await createSessionWithEvents(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.events));
  });

  it('GET /events?view=chat returns messages array', async () => {
    const { sessionChainStore, writer } = await setup();
    const { record } = await createSessionWithEvents(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events?view=chat`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.messages));
    // 2 messages: user + assistant (tool_use filtered out)
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.messages[1].role, 'assistant');
  });

  it('GET /events?view=handoff returns invocations array', async () => {
    const { sessionChainStore, writer } = await setup();
    const { record } = await createSessionWithEvents(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/events?view=handoff`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.invocations));
    assert.equal(body.invocations.length, 1);
    assert.equal(body.invocations[0].invocationId, 'inv-test-001');
    assert.deepEqual(body.invocations[0].toolCalls, ['Read']);
  });

  // --- Invocation detail endpoint tests ---

  it('GET /invocations/:invocationId returns 401 without identity', async () => {
    const { sessionChainStore, writer } = await setup();
    const { record, invId } = await createSessionWithEvents(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/invocations/${invId}`,
    });
    assert.equal(res.statusCode, 401);
  });

  it('GET /invocations/:invocationId returns 404 for unknown session', async () => {
    await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/nonexistent/invocations/inv-xyz',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('GET /invocations/:invocationId returns 404 for unknown invocation', async () => {
    const { sessionChainStore, writer } = await setup();
    const { record } = await createSessionWithEvents(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/invocations/inv-nonexistent`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('GET /invocations/:invocationId returns events for valid invocation', async () => {
    const { sessionChainStore, writer } = await setup();
    const { record, invId } = await createSessionWithEvents(sessionChainStore, writer);

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${record.id}/invocations/${invId}`,
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.invocationId, invId);
    assert.equal(body.total, 3);
    assert.equal(body.events.length, 3);
  });
});

// --- Cloud R1 P1-1: production event types (type:'text') ---

describe('Cloud P1-1: chat view handles production event type (text)', () => {
  it('includes type:text events as role:assistant', async () => {
    const { formatEventsChat } = await import('../dist/domains/cats/services/session/TranscriptFormatter.js');
    const events = [
      {
        v: 1,
        t: 1000,
        threadId: 't',
        catId: 'opus',
        sessionId: 's',
        cliSessionId: 'c',
        invocationId: 'inv-1',
        eventNo: 0,
        event: { type: 'text', content: 'I will fix the bug.' },
      },
      {
        v: 1,
        t: 1001,
        threadId: 't',
        catId: 'opus',
        sessionId: 's',
        cliSessionId: 'c',
        invocationId: 'inv-1',
        eventNo: 1,
        event: { type: 'tool_use', toolName: 'Edit', toolInput: { file_path: '/app.ts' } },
      },
    ];
    const messages = formatEventsChat(events);
    assert.equal(messages.length, 1, 'Should extract 1 text message, skip tool_use');
    assert.equal(messages[0].role, 'assistant');
    assert.equal(messages[0].content, 'I will fix the bug.');
  });
});

// --- Cloud R1 P1-2: production toolName field ---

describe('Cloud P1-2: handoff view reads toolName field', () => {
  it('extracts tool names from toolName (production format)', async () => {
    const { formatEventsHandoff } = await import('../dist/domains/cats/services/session/TranscriptFormatter.js');
    const events = [
      {
        v: 1,
        t: 1000,
        threadId: 't',
        catId: 'opus',
        sessionId: 's',
        cliSessionId: 'c',
        invocationId: 'inv-1',
        eventNo: 0,
        event: { type: 'tool_use', toolName: 'Read' },
      },
      {
        v: 1,
        t: 1001,
        threadId: 't',
        catId: 'opus',
        sessionId: 's',
        cliSessionId: 'c',
        invocationId: 'inv-1',
        eventNo: 1,
        event: { type: 'tool_use', toolName: 'Edit' },
      },
    ];
    const summaries = formatEventsHandoff(events);
    assert.equal(summaries.length, 1);
    assert.deepEqual(summaries[0].toolCalls, ['Read', 'Edit']);
  });

  it('extracts key messages from type:text events', async () => {
    const { formatEventsHandoff } = await import('../dist/domains/cats/services/session/TranscriptFormatter.js');
    const events = [
      {
        v: 1,
        t: 1000,
        threadId: 't',
        catId: 'opus',
        sessionId: 's',
        cliSessionId: 'c',
        invocationId: 'inv-1',
        eventNo: 0,
        event: { type: 'text', content: 'Found the bug in app.ts.' },
      },
    ];
    const summaries = formatEventsHandoff(events);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].keyMessages.length, 1);
    assert.equal(summaries[0].keyMessages[0], 'Found the bug in app.ts.');
  });
});

// --- P2-1: extractTextContent type guard ---

describe('P2-1: extractTextContent rejects non-string text', () => {
  it('skips content items where text is not a string', async () => {
    const { formatEventsChat } = await import('../dist/domains/cats/services/session/TranscriptFormatter.js');
    const events = [
      {
        v: 1,
        t: 1000,
        threadId: 't',
        catId: 'opus',
        sessionId: 's',
        cliSessionId: 'c',
        eventNo: 0,
        event: {
          type: 'assistant',
          content: [
            { type: 'text', text: 42 }, // number, not string
            { type: 'text' }, // missing text field
            { type: 'text', text: 'valid' }, // valid
          ],
        },
      },
    ];
    const messages = formatEventsChat(events);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'valid');
  });
});

// --- P2-2: keyMessages upper bound ---

describe('P2-2: handoff keyMessages capped at 5', () => {
  it('limits keyMessages to 5 per invocation', async () => {
    const { formatEventsHandoff } = await import('../dist/domains/cats/services/session/TranscriptFormatter.js');
    // Create 10 assistant events in same invocation
    const events = Array.from({ length: 10 }, (_, i) => ({
      v: 1,
      t: 1000 + i,
      threadId: 't',
      catId: 'opus',
      sessionId: 's',
      cliSessionId: 'c',
      invocationId: 'inv-many',
      eventNo: i,
      event: {
        type: 'assistant',
        content: `Message number ${i}`,
      },
    }));
    const summaries = formatEventsHandoff(events);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].keyMessages.length, 5);
  });
});
