import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { MatterMemoryService } from '../dist/domains/memory/matters/MatterMemoryService.js';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackMemoryRoutes } from '../dist/routes/callback-memory-routes.js';
import { memoryCueInvocationReadRoutes } from '../dist/routes/memory-cue-invocation-read.js';
import { memoryMatterRoutes } from '../dist/routes/memory-matter-routes.js';

describe('F332 shared matter memory through the authenticated callback', () => {
  let app;
  let evidenceStore;
  let messageStore;
  let threadStore;
  let threadA;
  let threadB;
  let credentials;
  let original;
  let correction;

  beforeEach(async () => {
    evidenceStore = new SqliteEvidenceStore(':memory:');
    await evidenceStore.initialize().catch((error) => {
      throw new Error(error.message, { cause: error });
    });
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    threadA = threadStore.create('owner-a', 'Design discussion');
    threadB = threadStore.create('owner-a', 'Implementation');
    original = messageStore.append({
      from: { kind: 'user', userId: 'owner-a' },
      userId: 'owner-a',
      threadId: threadA.id,
      content: 'Use the existing navigation for the settings entry.',
      mentions: [],
      timestamp: 1_000,
    });
    correction = messageStore.append({
      from: { kind: 'user', userId: 'owner-a' },
      userId: 'owner-a',
      threadId: threadA.id,
      content: 'The settings entry now belongs in the existing workspace panel.',
      mentions: [],
      timestamp: 2_000,
    });
    credentials = new Map([
      ['call-a', { threadId: threadA.id, catId: 'codex-astra' }],
      ['call-b', { threadId: threadB.id, catId: 'codex61-sol' }],
    ]);
    app = Fastify();
    app.addHook('onRequest', async (request) => {
      if (['owner-a', 'owner-b'].includes(request.headers['x-test-owner-session'])) {
        request.sessionUserId = request.headers['x-test-owner-session'];
        request.sessionBindingId = 'owner-test-session';
        request.sessionCsrfToken = 'test-csrf';
      }
    });
    registerCallbackAuthHook(app, {
      async verify(invocationId, token) {
        const caller = credentials.get(invocationId);
        if (!caller || token !== `token-${invocationId}`) return { ok: false, reason: 'invalid_token' };
        return {
          ok: true,
          record: {
            ...caller,
            invocationId,
            callbackToken: token,
            userId: 'owner-a',
            ownerAuthProvenance: 'strict',
            clientMessageIds: new Set(),
            createdAt: 1,
            expiresAt: null,
            state: 'active',
          },
        };
      },
    });
    const matterMemoryService = new MatterMemoryService({
      db: evidenceStore.getDb(),
      messageStore,
      threadStore,
      runWrite: (operation) => evidenceStore.runExclusive(operation),
    });
    await app.register(memoryMatterRoutes, { service: matterMemoryService });
    await app.register(memoryCueInvocationReadRoutes, {
      evidenceDb: evidenceStore.getDb(),
      matterMemoryService,
      threadStore,
      invocationRecordStore: {
        get: async (id) =>
          credentials.has(id)
            ? { id, userId: 'owner-a', threadId: credentials.get(id).threadId, targetCats: [credentials.get(id).catId] }
            : null,
      },
      turnExecutionStore: { get: async () => null },
    });
    await registerCallbackMemoryRoutes(app, {
      evidenceStore,
      messageStore,
      threadStore,
      matterMemoryService,
      markerQueue: {
        submit: async () => {
          throw new Error('This journey must not write a marker summary');
        },
      },
      reflectionService: {
        reflect: async () => {
          throw new Error('This journey must not invoke a summarizer');
        },
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await evidenceStore.close();
  });

  const headers = (invocationId) => ({
    'x-invocation-id': invocationId,
    'x-callback-token': `token-${invocationId}`,
  });
  const source = (message) => ({
    threadId: message.threadId,
    messageId: message.id,
    segment: 'body',
    start: 0,
    end: message.content.length,
    quote: message.content,
  });

  it('A writes an unindexed source; B reads it, then reads the corrected version through the same page', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-matters/write',
      headers: headers('call-a'),
      payload: {
        operation: 'create',
        requestId: 'create-matter',
        title: 'Settings entry',
        description: '背景：复用已有导航。仅适用于设置入口，不改变工程权限。',
        sources: [source(original)],
      },
    });
    assert.equal(created.statusCode, 201, `A must create one durable matter from a real source: ${created.body}`);
    const page = created.json().matter;

    const directoryA = await app.inject({ url: '/api/callbacks/memory-matters', headers: headers('call-a') });
    const directoryB = await app.inject({ url: '/api/callbacks/memory-matters', headers: headers('call-b') });
    assert.equal(directoryA.json().items[0].hasThreadSource, true);
    assert.equal(directoryB.json().items[0].hasThreadSource, false);
    assert.equal(evidenceStore.getDb().prepare('SELECT COUNT(*) AS n FROM memory_cue_events').get().n, 0);

    const first = await app.inject({
      method: 'GET',
      url: `/api/callbacks/memory-matters/${page.matterId}`,
      headers: headers('call-b'),
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().matter.description, '背景：复用已有导航。仅适用于设置入口，不改变工程权限。');
    assert.deepEqual(
      first.json().entries.map((entry) => entry.quote),
      [original.content],
    );
    assert.equal(first.json().entries[0].source.messageId, original.id);
    const events = evidenceStore.getDb().prepare('SELECT * FROM memory_cue_events ORDER BY rowid').all();
    assert.deepEqual(
      events.map((event) => event.consumption_outcome),
      ['presented', 'drilled'],
    );
    assert.ok(
      events.every((event) => event.consumer_cat_id === 'codex61-sol' && event.read_origin === 'explicit_read'),
    );
    assert.equal(JSON.parse(events[1].read_details_json).pageRevision, first.json().matter.revision);
    const receiptUrl = `/api/threads/${threadB.id}/invocations/call-b/memory-cues/${events[0].cue_id}/matter`;
    const receipt = await app.inject({
      url: `${receiptUrl}?catId=codex61-sol`,
      headers: { 'x-test-owner-session': 'owner-a' },
    });
    assert.equal(receipt.statusCode, 200);
    assert.equal(receipt.json().page.matter.description, first.json().matter.description);
    assert.equal(receipt.json().page.matter.revision, first.json().matter.revision);
    assert.equal(receipt.json().page.entries[0].quote, original.content);
    assert.equal(
      (await app.inject({ url: `${receiptUrl}?catId=codex-astra`, headers: { 'x-test-owner-session': 'owner-a' } }))
        .statusCode,
      404,
    );
    assert.equal(
      (await app.inject({ url: `${receiptUrl}?catId=codex61-sol`, headers: { 'x-test-owner-session': 'owner-b' } }))
        .statusCode,
      404,
    );
    const entryId = first.json().entries[0].entryId;

    const changed = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-matters/write',
      headers: headers('call-a'),
      payload: {
        operation: 'correct',
        requestId: 'correct-entry',
        matterId: page.matterId,
        expectedRevision: first.json().matter.revision,
        entryId,
        source: source(correction),
      },
    });
    assert.equal(changed.statusCode, 200);
    const reread = await app.inject({
      method: 'GET',
      url: `/api/callbacks/memory-matters/${page.matterId}`,
      headers: headers('call-b'),
    });
    assert.equal(reread.statusCode, 200);
    assert.deepEqual(
      reread.json().entries.map((entry) => entry.quote),
      [correction.content],
    );
    assert.equal(reread.json().entries[0].source.messageId, correction.id);
    assert.notEqual(reread.json().matter.revision, page.revision);
    const oldReceipt = await app.inject({
      url: `${receiptUrl}?catId=codex61-sol`,
      headers: { 'x-test-owner-session': 'owner-a' },
    });
    assert.deepEqual(oldReceipt.json(), { status: 'changed' });
    const currentCues = await app.inject({
      url: `/api/threads/${threadB.id}/invocations/call-b/memory-cues`,
      headers: { 'x-test-owner-session': 'owner-a' },
    });
    assert.deepEqual(
      currentCues.json().cues.map((cue) => cue.matterRead.status),
      ['changed', 'current'],
    );
    assert.ok(currentCues.json().cues.every((cue) => cue.source === 'pull'));
    assert.equal(evidenceStore.getDb().prepare('SELECT COUNT(*) AS count FROM evidence_docs').get().count, 0);
  });

  it('does not expose matter metadata or original quotes to self-reported owners or deleted reply threads', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/callbacks/memory-matters/write',
      headers: headers('call-a'),
      payload: {
        operation: 'create',
        requestId: 'private-receipt',
        title: 'Private sourced matter',
        sources: [source(original)],
      },
    });
    await app.inject({
      url: `/api/callbacks/memory-matters/${created.json().matter.matterId}`,
      headers: headers('call-b'),
    });
    const event = evidenceStore.getDb().prepare('SELECT cue_id FROM memory_cue_events LIMIT 1').get();
    const listUrl = `/api/threads/${threadB.id}/invocations/call-b/memory-cues`;
    const quoteUrl = `${listUrl}/${event.cue_id}/matter?catId=codex61-sol`;
    for (const forged of [
      { 'x-cat-cafe-user': 'owner-a' },
      { origin: 'http://localhost:3003', 'x-cat-cafe-user': 'owner-a' },
    ]) {
      const expanded = await app.inject({ url: quoteUrl, headers: forged });
      assert.equal(expanded.statusCode, 401, 'Only an authenticated owner session can expand original messages');
      assert.equal(expanded.body.includes(original.content), false);
      const metadata = await app.inject({ url: listUrl, headers: forged });
      assert.equal(metadata.body.includes('Private sourced matter'), false);
      assert.equal(metadata.body.includes('"resolverFamily":"matter"'), false);
    }
    assert.equal((await app.inject({ url: quoteUrl, headers: { 'x-test-owner-session': 'owner-a' } })).statusCode, 200);
    threadStore.softDelete(threadB.id);
    assert.equal((await app.inject({ url: listUrl, headers: { 'x-test-owner-session': 'owner-a' } })).statusCode, 404);
    assert.equal((await app.inject({ url: quoteUrl, headers: { 'x-test-owner-session': 'owner-a' } })).statusCode, 404);
  });

  it('rejects forged identity and callback credentials without writing, and resolves owner source selections', async () => {
    const payload = { operation: 'create', requestId: 'forged', title: 'Settings', sources: [source(original)] };
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/callbacks/memory-matters/write', payload })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/callbacks/memory-matters/write',
          headers: { ...headers('call-a'), 'x-callback-token': 'wrong' },
          payload,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/callbacks/memory-matters/write',
          headers: headers('call-a'),
          payload: { ...payload, ownerUserId: 'owner-b' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/memory/matters/write',
          headers: { 'x-cat-cafe-user': 'owner-a' },
          payload,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: '/api/memory/matters', headers: { 'x-cat-cafe-user': 'owner-a' } })).statusCode,
      401,
    );
    assert.equal(evidenceStore.getDb().prepare('SELECT COUNT(*) AS n FROM memory_matters').get().n, 0);
    const resolved = await app.inject({
      method: 'POST',
      url: '/api/memory/matters/source',
      headers: { 'x-test-owner-session': 'owner-a' },
      payload: { threadId: original.threadId, messageId: original.id, quote: original.content },
    });
    assert.deepEqual(resolved.json().source, source(original));
    const ownerWrite = await app.inject({
      method: 'POST',
      url: '/api/memory/matters/write',
      headers: { 'x-test-owner-session': 'owner-a', 'x-csrf-token': 'test-csrf', origin: 'http://localhost:3003' },
      payload,
    });
    assert.equal(ownerWrite.statusCode, 200, ownerWrite.body);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/memory/matters/write',
          headers: { 'x-test-owner-session': 'owner-a', origin: 'http://localhost:3003' },
          payload,
        })
      ).statusCode,
      403,
    );
    assert.equal(evidenceStore.getDb().prepare('SELECT COUNT(*) AS n FROM memory_cue_events').get().n, 0);
  });
});
