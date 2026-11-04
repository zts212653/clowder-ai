import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { getRoster } from '../dist/config/cat-config-loader.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { successorFixture } from './helpers/successor-routing-fixture.js';

async function appFor(t, h) {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(messagesRoutes, {
    registry: new InvocationRegistry(),
    router: h.router,
    messageStore: h.messages,
    threadStore: h.threads,
    invocationQueue: h.queue,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
  });
  return app;
}

function removeMember(id) {
  const configs = catRegistry.getAllConfigs();
  catRegistry.reset();
  Object.entries(configs)
    .filter(([key]) => key !== id)
    .forEach(([key, config]) => catRegistry.register(key, config));
}

for (const transport of ['json', 'multipart']) {
  for (const field of ['confirmedTargetCats', 'mentions', 'whisperTo']) {
    for (const retired of [false, true]) {
      it(`${transport} ${field} receipt survives registry removal, retired=${retired}`, async (t) => {
        const h = successorFixture(t);
        const app = await appFor(t, h);
        const payload = {
          threadId: h.threadId,
          content: 'work',
          idempotencyKey: randomUUID(),
          [field]: ['opus-5'],
          ...(field === 'whisperTo' ? { visibility: 'whisper' } : {}),
        };
        const send = (body) => {
          const boundary = 'receipt-fields';
          return app.inject({
            method: 'POST',
            url: '/api/messages',
            headers: {
              'x-cat-cafe-user': 'owner',
              ...(transport === 'multipart' ? { 'content-type': `multipart/form-data; boundary=${boundary}` } : {}),
            },
            payload:
              transport === 'json'
                ? body
                : Object.entries(body)
                    .flatMap(([key, value]) =>
                      (Array.isArray(value) ? value : [value]).map(
                        (item) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${item}\r\n`,
                      ),
                    )
                    .join('') + `--${boundary}--\r\n`,
          });
        };
        const first = await send(payload);
        assert.equal(first.statusCode, 202, first.body);
        const [entry] = await h.ledger.list(h.threadId);
        if (retired) {
          await h.ledger.claim(h.threadId, entry.id, 'retire', 200, 'opus-5');
          await h.ledger.commit(h.threadId, entry.id, 'retire', 'processing', 201);
        }
        removeMember('opus-5');
        const replay = await send(payload);
        assert.equal(replay.statusCode, 202, replay.body);
        assert.equal(replay.json().userMessageId, first.json().userMessageId);
        assert.deepEqual(
          (await h.ledger.list(h.threadId)).flatMap((row) => row.targets),
          retired ? [] : ['opus-5'],
        );
        const conflict = await send({ ...payload, [field]: ['codex'] });
        assert.notEqual(conflict.statusCode, 202, conflict.body);
        assert.match(conflict.body, /identity conflict/);
        for (const id of ['opus-5', 'ghost', '__none__']) {
          const fresh = await send({ ...payload, idempotencyKey: randomUUID(), [field]: [id] });
          assert.equal(fresh.statusCode, 400, fresh.body);
        }
        assert.equal(
          (await h.messages.getByThread(h.threadId, 50, 'owner', { includeQueuedUserMessages: true })).length,
          1,
        );
        await h.processor.requestDrain(h.threadId);
        assert.deepEqual(h.calls, []);
      });
    }
  }
}

for (const stage of ['pending', 'partial', 'retired', 'reopened']) {
  it(`Bundle exact receipt reuses targets after disablement: ${stage}`, async (t) => {
    const h = successorFixture(t);
    const sourceThread = h.threads.create('owner', 'Source');
    const source = await h.messages.append({
      from: { kind: 'user', userId: 'owner' },
      userId: 'owner',
      threadId: sourceThread.id,
      content: 'source',
      mentions: [],
      timestamp: 1,
    });
    let app = await appFor(t, h);
    const request = {
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: {
        threadId: h.threadId,
        content: '',
        idempotencyKey: randomUUID(),
        messageBundle: {
          sourceThreadId: sourceThread.id,
          items: [{ kind: 'message', messageId: source.id }],
          targetCats: ['opus-5', 'codex'],
        },
      },
    };
    const first = await app.inject(request);
    assert.equal(first.statusCode, 202, first.body);
    const [entry] = await h.ledger.list(h.threadId);
    getRoster()['opus-5'] = { ...getRoster()['opus-5'], available: false, successor: 'codex' };
    if (stage !== 'pending') {
      await h.ledger.claim(h.threadId, entry.id, 'first', 200, 'opus-5');
      await h.ledger.commit(h.threadId, entry.id, 'first', 'processing', 201);
    }
    if (stage === 'retired' || stage === 'reopened') {
      await h.ledger.claim(h.threadId, entry.id, 'last', 202, 'codex');
      await h.ledger.commit(h.threadId, entry.id, 'last', 'processing', 203);
    }
    if (stage === 'reopened') app = await appFor(t, { ...h, queue: new InvocationQueue(h.ledger) });
    const replay = await app.inject(request);
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(replay.json().messageBundleId, first.json().messageBundleId);
    assert.deepEqual(
      (await h.ledger.list(h.threadId)).flatMap((row) => row.targets),
      stage === 'pending' ? ['opus-5', 'codex'] : stage === 'partial' ? ['codex'] : [],
    );
    assert.deepEqual(h.calls, []);
  });
}

it('Bundle replay rejects a different refs-only carrier even when its summary is unchanged', async (t) => {
  const h = successorFixture(t);
  const app = await appFor(t, h);
  const sourceThread = h.threads.create('owner', 'Source');
  const sources = await Promise.all(
    ['first', 'second'].map((content, index) =>
      h.messages.append({
        from: { kind: 'user', userId: 'owner' },
        userId: 'owner',
        threadId: sourceThread.id,
        content,
        mentions: [],
        timestamp: index + 1,
      }),
    ),
  );
  const bundle = {
    sourceThreadId: sourceThread.id,
    note: 'original note',
    items: [{ kind: 'message', messageId: sources[0].id }],
    targetCats: ['opus-5'],
  };
  const request = {
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { threadId: h.threadId, content: '', idempotencyKey: randomUUID(), messageBundle: bundle },
  };
  const first = await app.inject(request);
  assert.equal(first.statusCode, 202, first.body);
  for (const change of [
    { note: 'different note' },
    { items: [{ kind: 'message', messageId: sources[1].id }] },
    { targetCats: ['codex'] },
  ]) {
    const conflict = await app.inject({
      ...request,
      payload: { ...request.payload, messageBundle: { ...bundle, ...change } },
    });
    assert.notEqual(conflict.statusCode, 202, conflict.body);
    assert.match(conflict.body, /identity conflict/);
  }
  assert.equal((await h.messages.getByThread(h.threadId, 50, 'owner', { includeQueuedUserMessages: true })).length, 1);
});

for (const content of ['@opus-5 work', 'work']) {
  for (const state of ['disabled', 'removed', 'retired']) {
    it(`Live receipt owns its selected target after it becomes ${state}: ${content}`, async (t) => {
      const h = successorFixture(t);
      const app = await appFor(t, h);
      const request = {
        method: 'POST',
        url: '/api/messages',
        headers: { 'x-cat-cafe-user': 'owner', 'x-cat-cafe-live-session': 'receipt-call' },
        payload: { threadId: h.threadId, content, idempotencyKey: randomUUID() },
      };
      const first = await app.inject(request);
      assert.equal(first.statusCode, 202, first.body);
      const [entry] = await h.ledger.list(h.threadId);
      if (state === 'retired') {
        await h.ledger.claim(h.threadId, entry.id, 'retire', 200, 'opus-5');
        await h.ledger.commit(h.threadId, entry.id, 'retire', 'processing', 201);
      }
      getRoster()['opus-5'] = { ...getRoster()['opus-5'], available: false, successor: 'codex' };
      if (state === 'removed') removeMember('opus-5');
      const replay = await app.inject(request);
      assert.equal(replay.statusCode, 202, replay.body);
      assert.equal(replay.json().userMessageId, first.json().userMessageId);
      assert.deepEqual(
        (await h.messages.getById(first.json().userMessageId)).mentions,
        content.startsWith('@') ? ['opus-5'] : [],
      );
      const changedSession = await app.inject({
        ...request,
        headers: { ...request.headers, 'x-cat-cafe-live-session': 'other-call' },
      });
      assert.equal(changedSession.statusCode, 409, changedSession.body);
      const retarget = await app.inject({ ...request, payload: { ...request.payload, mentions: ['codex'] } });
      assert.equal(retarget.statusCode, 409, retarget.body);
      assert.deepEqual(
        (await h.ledger.list(h.threadId)).flatMap((row) => row.targets),
        state === 'retired' ? [] : ['opus-5'],
      );
      await h.processor.requestDrain(h.threadId);
      assert.deepEqual(h.calls, []);
    });
  }
}

it('Live receipt verifies attachments through the same Message envelope as Queue send', async (t) => {
  const h = successorFixture(t);
  const app = await appFor(t, h);
  const request = {
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner', 'x-cat-cafe-live-session': 'receipt-call' },
    payload: { threadId: h.threadId, content: 'work', mentions: ['opus-5'], idempotencyKey: randomUUID() },
  };
  assert.equal((await app.inject(request)).statusCode, 202);
  const conflict = await app.inject({
    ...request,
    payload: {
      ...request.payload,
      contextAttachments: [{ v: 1, id: 'new-context', kind: 'thread', threadId: 'other', title: 'different context' }],
    },
  });
  assert.notEqual(conflict.statusCode, 202, conflict.body);
  assert.match(conflict.body, /identity conflict/);
  assert.equal((await h.messages.getByThread(h.threadId, 50, 'owner', { includeQueuedUserMessages: true })).length, 1);
});
