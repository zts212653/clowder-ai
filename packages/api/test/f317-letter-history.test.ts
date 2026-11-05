import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { companionTextDigest } from '../src/domains/cats/services/stores/companion-submission-state.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { CompanionConversationHistory } from '../src/domains/concierge/live/host/companion-conversation-history.js';

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function rows(page: unknown) {
  const messages = object(page).messages;
  assert.ok(Array.isArray(messages));
  return messages.map(object);
}
function fixture() {
  const messages = new MessageStore();
  let current = true;
  let threadId = 'home';
  let resolutions = 0;
  const client = {
    async request(path: string): Promise<Record<string, unknown>> {
      if (path.startsWith('/api/threads/')) return { title: 'Companion history' };
      return {
        messages: messages.getByThread('home', 32, 'owner').map((message) => ({
          ...message,
          type: message.catId ? 'assistant' : 'user',
        })),
        hasMore: messages.getByThread('home', 33, 'owner').length > 32,
      };
    },
  };
  const history = new CompanionConversationHistory({
    ownerUserId: 'owner',
    client,
    messages,
    conversationThread: async () => {
      resolutions++;
      return threadId;
    },
    verifyThread: async (candidate) => candidate === threadId,
    assertCurrent: async () => {
      if (!current) throw new Error('permission_required');
    },
  });
  const append = (content: string, cat = false, timestamp = 100) =>
    messages.append({
      userId: 'owner',
      threadId,
      from: cat ? { kind: 'agent', catId: createCatId('codex61-sol') } : { kind: 'user', userId: 'owner' },
      content,
      mentions: [],
      timestamp,
    });
  return {
    history,
    messages,
    append,
    changeThread() {
      threadId = 'new-home';
    },
    resolutionCount: () => resolutions,
    revoke() {
      current = false;
    },
  };
}

test('a full long reply is reachable through bounded body reads, separately from older history', async () => {
  const f = fixture();
  const text = 'a'.repeat(15_999) + '🐾' + 'b'.repeat(5000);
  const message = f.append(text, true);
  const page = object(await f.history.readPage());
  assert.equal(page.v, 2, 'v2 must provide truthful per-body progress rather than the legacy mixed hasMore');
  assert.equal(page.hasMoreOlder, false);
  assert.equal(page.olderCursor, null);
  const row = rows(page)[0]!;
  assert.equal(row.id, message.id);
  let body = object(row.body);
  let result = String(row.text);
  assert.equal(body.complete, false);
  const revision = body.revision;
  const seen = new Set<string>();
  while (!body.complete) {
    assert.equal(typeof body.continuation, 'string');
    const token = String(body.continuation);
    assert.equal(seen.has(token), false);
    seen.add(token);
    const chunk = object(await f.history.readBody(token));
    assert.equal(chunk.status, 'available');
    assert.equal(chunk.messageId, message.id);
    body = object(chunk.body);
    assert.equal(body.revision, revision);
    result += String(chunk.text);
  }
  assert.equal(body.continuation, null);
  assert.equal(result, text, 'all source text, including a surrogate pair at the boundary, remains readable');
});

test('history uses stable opaque older pages and proves response phase independently of readable body', async () => {
  const f = fixture();
  const input = f.append('Please answer', false, 10);
  for (let index = 0; index < 35; index++) f.append('History ' + index, true, 100 + index);
  const completed = f.append('Answer', true, 200);
  completed.lifecycle = {
    kind: 'response',
    orderKey: 'response',
    invocationId: 'inv',
    targetId: 'codex61-sol',
    inputEntryIds: ['entry'],
    inputMessageIds: [input.id],
    status: 'completed',
    startedAt: 190,
    completedAt: 200,
  };
  const first = object(await f.history.readPage({ limit: 2 }));
  assert.equal(first.v, 2);
  assert.equal(rows(first).length, 2);
  assert.equal(first.hasMoreOlder, true);
  assert.equal(typeof first.olderCursor, 'string');
  const answer = rows(first).find((row) => row.id === completed.id)!;
  assert.deepEqual(answer.inputMessageIds, [input.id]);
  assert.equal(answer.responsePhase, 'completed');
  const second = object(await f.history.readPage({ limit: 2, before: String(first.olderCursor) }));
  assert.equal(rows(second).length, 2);
  assert.equal(
    rows(second).some((row) => row.id === completed.id),
    false,
  );
});

test('a body continuation cannot join changed text or survive revoked Host authority', async () => {
  const f = fixture();
  const message = f.append('x'.repeat(18_000), true);
  const first = rows(await f.history.readPage())[0]!;
  const token = object(first.body).continuation;
  assert.equal(typeof token, 'string');
  message.content = 'changed';
  assert.deepEqual(await f.history.readBody(String(token)), { kind: 'conversation-body', v: 2, status: 'stale' });
  f.revoke();
  await assert.rejects(f.history.readBody(String(token)), /permission_required/);
});

test('a response transition during source verification cannot publish an obsolete completed relation', async () => {
  const f = fixture();
  const input = f.append('Input', false, 10);
  const answer = f.append('Answer', true, 20);
  answer.lifecycle = {
    kind: 'response',
    orderKey: 'response',
    invocationId: 'inv',
    targetId: 'codex61-sol',
    inputEntryIds: ['entry'],
    inputMessageIds: [input.id],
    status: 'completed',
    startedAt: 15,
    completedAt: 20,
  };
  const read = f.messages.getById.bind(f.messages);
  f.messages.getById = (id) => {
    if (id === input.id && answer.lifecycle?.kind === 'response') answer.lifecycle.status = 'interrupted';
    return read(id);
  };
  assert.deepEqual(await f.history.readPage(), { kind: 'conversation', v: 2, status: 'stale' });
});

test('processing, unrelated and out-of-order replies preserve their distinct proven sources', async () => {
  const f = fixture();
  const inputA = f.append('Input A', false, 1);
  const inputB = f.append('Input B', false, 2);
  const unrelated = f.append('Unrelated answer', true, 3);
  const answerB = f.append('Answer B', true, 4);
  const answerA = f.append('Partial A', true, 5);
  const response = (id: string, status: 'processing' | 'completed') => ({
    kind: 'response' as const,
    orderKey: 'response',
    invocationId: 'inv',
    targetId: 'codex61-sol',
    inputEntryIds: ['entry'],
    inputMessageIds: [id],
    status,
    startedAt: 3,
    ...(status === 'completed' ? { completedAt: 4 } : {}),
  });
  answerB.lifecycle = response(inputB.id, 'completed');
  answerA.lifecycle = response(inputA.id, 'processing');
  const page = rows(await f.history.readPage());
  const row = (id: string) => page.find((item) => item.id === id)!;
  assert.deepEqual(row(unrelated.id).inputMessageIds, []);
  assert.equal(row(unrelated.id).responsePhase, null);
  assert.deepEqual(row(answerB.id).inputMessageIds, [inputB.id]);
  assert.equal(row(answerB.id).responsePhase, 'completed');
  assert.deepEqual(row(answerA.id).inputMessageIds, [inputA.id]);
  assert.equal(row(answerA.id).responsePhase, 'processing');
  assert.equal(object(row(answerA.id).body).complete, true, 'readable body completeness cannot complete a response');
});

test('Live committed result uses original requestRefs while a reminder and foreign refs prove no reply relation', async () => {
  const f = fixture();
  const input = f.append('Live input', false, 1);
  input.extra = {
    liveCompanion: { callId: 'original-call', modality: 'typed', role: 'user', clientMessageId: 'client' },
  };
  const result = f.append('Late result', true, 2);
  result.extra = {
    liveCompanion: {
      callId: 'original-call',
      modality: 'result',
      role: 'assistant',
      nativeTurnId: 'turn',
      returnProjection: { presentationEligibility: 'deferred', requestRefs: [`thread:home#${input.id}`] },
    },
  };
  const reminder = f.append('Reminder', true, 3);
  reminder.extra = {
    liveCompanion: {
      callId: 'new-call',
      modality: 'result',
      role: 'assistant',
      nativeTurnId: 'new-turn',
      returnProjection: {
        presentationEligibility: 'current',
        requestRefs: [`thread:home#${input.id}`],
        reminderForMessageIds: [result.id],
      },
    },
  };
  const foreign = f.append('Unverified provenance', true, 4);
  foreign.extra = {
    liveCompanion: {
      callId: 'original-call',
      modality: 'result',
      role: 'assistant',
      nativeTurnId: 'foreign-turn',
      returnProjection: { presentationEligibility: 'current', requestRefs: [`thread:foreign#${input.id}`] },
    },
  };
  const page = rows(await f.history.readPage());
  assert.deepEqual(page.find((row) => row.id === result.id)?.inputMessageIds, [input.id]);
  assert.equal(page.find((row) => row.id === result.id)?.responsePhase, 'completed');
  for (const id of [reminder.id, foreign.id]) {
    assert.deepEqual(page.find((row) => row.id === id)?.inputMessageIds, []);
    assert.equal(page.find((row) => row.id === id)?.responsePhase, null);
  }
  const long = f.append('Long body'.repeat(3000), true, 5);
  const token = object(rows(await f.history.readPage()).find((row) => row.id === long.id)!.body).continuation;
  long.deletedAt = 100;
  assert.deepEqual(await f.history.readBody(String(token)), { kind: 'conversation-body', v: 2, status: 'withdrawn' });
});

test('owner history recovers accepted queued sends independently of the single accepted draft slot', async () => {
  const f = fixture();
  const originals = [];
  for (const text of ['First queued input', 'Second queued input']) {
    const clientMessageId = randomUUID();
    const original = f.messages.appendIdempotent({
      userId: 'owner',
      threadId: 'home',
      from: { kind: 'user', userId: 'owner' },
      content: text,
      mentions: [],
      timestamp: 100,
      idempotencyKey: clientMessageId,
      deliveryStatus: 'queued',
    }).message;
    f.messages.recordCompanionDeliveryAcceptance(original.id, {
      ownerUserId: 'owner',
      threadId: 'home',
      clientMessageId,
      callId: null,
      contentDigest: companionTextDigest(text),
      acceptedAt: 101,
    });
    originals.push(original);
  }
  const page = rows(await f.history.readPage());
  assert.deepEqual(
    page.map((row) => row.id),
    originals.map((row) => row.id),
  );
  for (const row of page) {
    assert.equal(row.role, 'user');
    assert.equal(object(row.deliveryReceipt).delivery, 'accepted');
    assert.equal(object(row.deliveryReceipt).messageId, row.id);
  }
});

test('a completed but unattributed canonical response stays readable without claiming an input relation', async () => {
  const f = fixture();
  const answer = f.messages.append({
    userId: 'owner',
    threadId: 'home',
    from: { kind: 'agent', catId: createCatId('codex61-sol') },
    content: 'Unattributed answer',
    mentions: [],
    timestamp: 100,
    lifecycle: {
      kind: 'response',
      orderKey: 'unattributed',
      invocationId: 'inv',
      targetId: 'codex61-sol',
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'completed',
      startedAt: 90,
      completedAt: 100,
    },
  });
  const row = rows(await f.history.readPage()).find((item) => item.id === answer.id)!;
  assert.equal(row.text, 'Unattributed answer');
  assert.deepEqual(row.inputMessageIds, []);
  assert.equal(row.responsePhase, null, 'the public completed relation requires a verified input');
});

test('the same history reader adopts a new canonical thread while old read references stay bound', async () => {
  const f = fixture();
  f.append('Older home input', false, 10);
  f.append('x'.repeat(18_000), true, 20);
  const oldPage = object(await f.history.readPage({ limit: 1 }));
  const continuation = String(object(rows(oldPage)[0]!.body).continuation);
  f.changeThread();
  const replacement = f.append('New canonical input', false, 30);
  assert.deepEqual(
    rows(await f.history.readPage()).map((row) => row.id),
    [replacement.id],
  );
  const resolved = f.resolutionCount();
  await assert.rejects(f.history.readBody(continuation), /permission_required/);
  await assert.rejects(f.history.readPage({ before: String(oldPage.olderCursor) }), /permission_required/);
  assert.equal(f.resolutionCount(), resolved, 'bound reads verify their original thread without creating a new one');
});

test('a page stops before a surrogate pair that cannot fit its remaining budget and resumes without gaps', async () => {
  const f = fixture();
  const oldest = f.append('z', true, 10);
  const boundary = f.append('🐾Hello', true, 20);
  const middle = f.append('b'.repeat(7999), true, 30);
  const newest = f.append('a'.repeat(16_000), true, 40);
  const first = object(await f.history.readPage());
  assert.deepEqual(
    rows(first).map((row) => row.id),
    [middle.id, newest.id],
  );
  assert.equal(first.hasMoreOlder, true);
  assert.ok(rows(first).every((row) => String(row.text).length > 0));
  assert.equal(
    rows(first).reduce((length, row) => length + String(row.text).length, 0),
    23_999,
  );
  const second = object(await f.history.readPage({ before: String(first.olderCursor) }));
  assert.deepEqual(
    rows(second).map((row) => row.id),
    [oldest.id, boundary.id],
  );
  assert.equal(rows(second)[1]!.text, '🐾Hello');
  assert.equal(object(rows(second)[1]!.body).complete, true);
  assert.equal(second.hasMoreOlder, false);
});
