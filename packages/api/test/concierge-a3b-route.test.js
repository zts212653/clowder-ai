/**
 * Concierge A3b Route tests (F229 PR-A3b)
 *
 * Covers:
 * - POST /api/concierge/relay (§1a RelayReceipt INV R1-R4, §1c EscalationContext E1-E2)
 * - POST /api/concierge/relay/:receiptId/retry
 * - POST /api/concierge/confirm (§1b PendingConfirmation INV C1-C4)
 * - GET  /api/concierge/peek
 * - PUT  /api/concierge/config ballPosition (INV-P3)
 * - Architecture: R4 relay key write locality
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const USER_HEADER = { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' };

// Shared test fixture builder
async function buildApp() {
  const { conciergeRoutes } = await import('../dist/routes/concierge.js');
  const { MemoryConciergeConfigStore } = await import('../dist/domains/concierge/ConciergeConfigStore.js');
  const { ConciergeThreadService } = await import('../dist/domains/concierge/ConciergeThreadService.js');
  const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
  const { MemoryConciergeRelayStore } = await import('../dist/domains/concierge/ConciergeRelayStore.js');
  const { MemoryConciergeConfirmationStore } = await import('../dist/domains/concierge/ConciergeConfirmationStore.js');
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

  const conciergeConfigStore = new MemoryConciergeConfigStore();
  const threadStore = new ThreadStore();
  const conciergeThreadService = new ConciergeThreadService({ threadStore, conciergeConfigStore });
  const conciergeRelayStore = new MemoryConciergeRelayStore();
  const conciergeConfirmationStore = new MemoryConciergeConfirmationStore();
  const messageStore = new MessageStore();

  // Register a messages route stub so relay dispatch can POST to it
  const app = Fastify();

  // Stub POST /api/messages so relay dispatch via inject() gets a 200
  app.post('/api/messages', async (_req, reply) => {
    reply.status(200);
    return { id: 'msg-stub-1', status: 'ok' };
  });

  await app.register(conciergeRoutes, {
    conciergeConfigStore,
    conciergeThreadService,
    conciergeRelayStore,
    conciergeConfirmationStore,
    messageStore,
  });

  return { app, conciergeRelayStore, conciergeConfirmationStore, messageStore, threadStore };
}

// ---------------------------------------------------------------------------
// POST /api/concierge/relay — §1a RelayReceipt + §1c EscalationContext
// ---------------------------------------------------------------------------

describe('POST /api/concierge/relay', () => {
  let app, conciergeRelayStore;

  beforeEach(async () => {
    ({ app, conciergeRelayStore } = await buildApp());
  });

  it('R1: creates receipt before dispatch — receipt exists after 200', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/relay',
      headers: USER_HEADER,
      payload: {
        targetThreadId: 'thread-target-1',
        targetCats: ['opus'],
        originalText: '帮我问一下砚砚那个 bug 修好了吗',
        sourceMessageId: 'msg-src-1',
        conciergeThreadId: 'thread-concierge-1',
      },
    });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'dispatched');
    assert.ok(body.receiptId);

    // Verify receipt exists in store
    const receipt = await conciergeRelayStore.get(body.receiptId);
    assert.ok(receipt, 'receipt should exist after dispatch');
    assert.equal(receipt.status, 'dispatched');
    assert.equal(receipt.userId, 'test-user');
    assert.equal(receipt.originalText, '帮我问一下砚砚那个 bug 修好了吗');
  });

  it('E2: originalText with line-start @ is neutralized by ZWNJ (R-review P1 R2 fix)', async () => {
    // Build a fresh app with a capturing stub to inspect relay content
    let capturedPayload;
    const { conciergeRoutes: routes } = await import('../dist/routes/concierge.js');
    const { MemoryConciergeConfigStore } = await import('../dist/domains/concierge/ConciergeConfigStore.js');
    const { ConciergeThreadService } = await import('../dist/domains/concierge/ConciergeThreadService.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MemoryConciergeRelayStore } = await import('../dist/domains/concierge/ConciergeRelayStore.js');
    const { MemoryConciergeConfirmationStore } = await import(
      '../dist/domains/concierge/ConciergeConfirmationStore.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const captureApp = Fastify();
    captureApp.post('/api/messages', async (req, reply) => {
      capturedPayload = req.body;
      reply.status(200);
      return { id: 'msg-captured', status: 'ok' };
    });
    const configStore = new MemoryConciergeConfigStore();
    await captureApp.register(routes, {
      conciergeConfigStore: configStore,
      conciergeThreadService: new ConciergeThreadService({
        threadStore: new ThreadStore(),
        conciergeConfigStore: configStore,
      }),
      conciergeRelayStore: new MemoryConciergeRelayStore(),
      conciergeConfirmationStore: new MemoryConciergeConfirmationStore(),
      messageStore: new MessageStore(),
    });

    await captureApp.inject({
      method: 'POST',
      url: '/api/concierge/relay',
      headers: USER_HEADER,
      payload: {
        targetThreadId: 'thread-injection-test',
        targetCats: ['opus'],
        originalText: '@codex 帮我看看\n这行没有at\n@sonnet 也帮忙',
        sourceMessageId: 'msg-inject-1',
        conciergeThreadId: 'thread-c-inject',
      },
    });

    assert.ok(capturedPayload, 'should have captured the relay message payload');
    const content = capturedPayload.content;

    // The real target handle should still be at line-start (first line)
    assert.ok(content.startsWith('@opus'), 'target handle @opus should be at line-start');

    // User text lines should have ZWNJ (U+200C) between `> ` and content.
    // This prevents the a2a-mentions router from matching — it strips `> ` prefix
    // but sees `‌@codex` which does NOT startsWith('@').
    const ZWNJ = '‌';
    const userLines = content.split('\n').filter((l) => l.startsWith('> '));
    assert.ok(userLines.length >= 3, 'should have at least 3 quoted lines');
    for (const line of userLines) {
      // After stripping `> ` prefix, line must NOT start with `@`
      const afterPrefix = line.replace(/^>\s*/, '');
      assert.ok(!afterPrefix.startsWith('@'), `user text line should not start with @ after prefix strip: "${line}"`);
      // Verify ZWNJ is present between `> ` and content
      assert.ok(line.includes(`> ${ZWNJ}`), `user text line should contain ZWNJ after "> ": "${line}"`);
    }
  });

  it('E2b: ZWNJ-quoted user text survives a2a-mentions parseA2AMentions (router-level proof)', async () => {
    // Import the actual router parser to prove ZWNJ prevents routing
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');

    // Simulate what buildRelayContent produces
    const ZWNJ = '‌';
    const userText = '@codex 帮我看看\n这行没有at\n@sonnet 也帮忙';
    const quotedText = userText
      .split('\n')
      .map((line) => `> ${ZWNJ}${line}`)
      .join('\n');
    const relayContent = `@opus\n\n---\n**前台猫转达的消息：**\n\n${quotedText}\n\n---\n*footer*`;

    // Parse: only @opus (the real target) should be detected, NOT @codex or @sonnet
    const mentions = parseA2AMentions(relayContent);
    assert.ok(mentions.includes('opus'), 'target @opus should be routed');
    assert.ok(!mentions.includes('codex'), '@codex in user text must NOT be routed');
    assert.ok(!mentions.includes('sonnet'), '@sonnet in user text must NOT be routed');
  });

  it('R3: receipt has clientMessageId for idempotent dispatch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/relay',
      headers: USER_HEADER,
      payload: {
        targetThreadId: 'thread-t2',
        targetCats: ['sonnet'],
        originalText: 'test relay',
        sourceMessageId: 'msg-src-2',
        conciergeThreadId: 'thread-c2',
      },
    });
    const body = JSON.parse(res.body);
    const receipt = await conciergeRelayStore.get(body.receiptId);
    // Cloud P1 fix: clientMessageId must be a valid UUID (no prefix) for messages schema
    assert.equal(receipt.clientMessageId, body.receiptId, 'clientMessageId should equal receiptId (valid UUID)');
  });

  it('E1: rejects empty originalText (schema validation)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/relay',
      headers: USER_HEADER,
      payload: {
        targetThreadId: 'thread-t3',
        targetCats: ['opus'],
        originalText: '', // empty — violates min(1)
        sourceMessageId: 'msg-src-3',
        conciergeThreadId: 'thread-c3',
      },
    });
    assert.equal(res.statusCode, 400, `expected 400 for empty originalText, got: ${res.body}`);
  });

  it('E1: rejects missing targetCats (schema validation)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/relay',
      headers: USER_HEADER,
      payload: {
        targetThreadId: 'thread-t4',
        targetCats: [], // empty — violates min(1)
        originalText: 'test',
        sourceMessageId: 'msg-src-4',
        conciergeThreadId: 'thread-c4',
      },
    });
    assert.equal(res.statusCode, 400, `expected 400 for empty targetCats, got: ${res.body}`);
  });

  it('returns 401 without identity', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/relay',
      headers: { 'content-type': 'application/json' },
      payload: {
        targetThreadId: 'thread-t5',
        targetCats: ['opus'],
        originalText: 'test',
        sourceMessageId: 'msg-5',
        conciergeThreadId: 'thread-c5',
      },
    });
    assert.equal(res.statusCode, 401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/concierge/relay/:receiptId/retry — INV R2 manual retry
// ---------------------------------------------------------------------------

describe('POST /api/concierge/relay/:receiptId/retry', () => {
  let app, conciergeRelayStore;

  beforeEach(async () => {
    ({ app, conciergeRelayStore } = await buildApp());
  });

  it('R2: can retry a dispatch_failed receipt', async () => {
    // Manually create a failed receipt
    const receipt = {
      id: 'retry-test-1',
      userId: 'test-user',
      conciergeThreadId: 'thread-c-retry',
      targetThreadId: 'thread-t-retry',
      targetCats: ['opus'],
      originalText: 'retry me',
      sourceMessageId: 'msg-retry-1',
      clientMessageId: 'relay-retry-test-1',
      status: 'dispatch_failed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await conciergeRelayStore.create(receipt);

    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/relay/retry-test-1/retry',
      headers: { 'x-cat-cafe-user': 'test-user' }, // no content-type (no body)
    });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'dispatched');

    // Verify receipt is now dispatched
    const updated = await conciergeRelayStore.get('retry-test-1');
    assert.equal(updated.status, 'dispatched');
  });

  it('R2: rejects retry on non-failed receipt (409)', async () => {
    const receipt = {
      id: 'retry-test-2',
      userId: 'test-user',
      conciergeThreadId: 'thread-c2',
      targetThreadId: 'thread-t2',
      targetCats: ['opus'],
      originalText: 'already dispatched',
      sourceMessageId: 'msg-retry-2',
      clientMessageId: 'relay-retry-test-2',
      status: 'dispatched',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await conciergeRelayStore.create(receipt);

    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/relay/retry-test-2/retry',
      headers: { 'x-cat-cafe-user': 'test-user' },
    });
    assert.equal(res.statusCode, 409, `expected 409 for already-dispatched, got: ${res.body}`);
  });

  it('returns 404 for non-existent receipt', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/relay/nonexistent-id/retry',
      headers: { 'x-cat-cafe-user': 'test-user' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 404 when receipt belongs to different user', async () => {
    const receipt = {
      id: 'retry-test-3',
      userId: 'other-user',
      conciergeThreadId: 'thread-c3',
      targetThreadId: 'thread-t3',
      targetCats: ['opus'],
      originalText: 'wrong user',
      sourceMessageId: 'msg-retry-3',
      clientMessageId: 'relay-retry-test-3',
      status: 'dispatch_failed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await conciergeRelayStore.create(receipt);

    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/relay/retry-test-3/retry',
      headers: { 'x-cat-cafe-user': 'test-user' },
    });
    assert.equal(res.statusCode, 404, 'should not see other users receipts');
  });
});

// ---------------------------------------------------------------------------
// POST /api/concierge/confirm — §1b PendingConfirmation
// ---------------------------------------------------------------------------

describe('POST /api/concierge/confirm', () => {
  let app, conciergeConfirmationStore;

  beforeEach(async () => {
    ({ app, conciergeConfirmationStore } = await buildApp());
  });

  it('C1: can confirm a rendered confirmation', async () => {
    await conciergeConfirmationStore.create({
      id: 'confirm-1',
      userId: 'test-user',
      messageId: 'msg-1',
      action: { kind: 'concierge_teleport', threadId: 'thread-1' },
      status: 'rendered',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/confirm',
      headers: USER_HEADER,
      payload: { confirmationId: 'confirm-1', status: 'confirmed' },
    });
    assert.equal(res.statusCode, 200, `expected 200, got: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'confirmed');
  });

  it('C1: can cancel a rendered confirmation', async () => {
    await conciergeConfirmationStore.create({
      id: 'confirm-2',
      userId: 'test-user',
      messageId: 'msg-2',
      action: { kind: 'concierge_go', targetThreadId: 'thread-2' },
      status: 'rendered',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/confirm',
      headers: USER_HEADER,
      payload: { confirmationId: 'confirm-2', status: 'cancelled' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'cancelled');
  });

  it('C1: rejects transition from confirmed → cancelled (409)', async () => {
    await conciergeConfirmationStore.create({
      id: 'confirm-3',
      userId: 'test-user',
      messageId: 'msg-3',
      action: { kind: 'concierge_teleport', threadId: 'thread-3' },
      status: 'rendered',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    // First confirm
    await conciergeConfirmationStore.updateStatus('confirm-3', 'confirmed');

    // Try to cancel already-confirmed
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/confirm',
      headers: USER_HEADER,
      payload: { confirmationId: 'confirm-3', status: 'cancelled' },
    });
    assert.equal(res.statusCode, 409, `expected 409 for already-confirmed, got: ${res.body}`);
  });

  it('returns 404 for non-existent confirmation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/confirm',
      headers: USER_HEADER,
      payload: { confirmationId: 'nonexistent', status: 'confirmed' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 404 when confirmation belongs to different user', async () => {
    await conciergeConfirmationStore.create({
      id: 'confirm-4',
      userId: 'other-user',
      messageId: 'msg-4',
      action: { kind: 'concierge_go', targetThreadId: 'thread-4' },
      status: 'rendered',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/confirm',
      headers: USER_HEADER,
      payload: { confirmationId: 'confirm-4', status: 'confirmed' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 401 without identity', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/concierge/confirm',
      headers: { 'content-type': 'application/json' },
      payload: { confirmationId: 'confirm-5', status: 'confirmed' },
    });
    assert.equal(res.statusCode, 401);
  });
});

// ---------------------------------------------------------------------------
// GET /api/concierge/peek
// ---------------------------------------------------------------------------

describe('GET /api/concierge/peek', () => {
  let app, messageStore;
  /** Actual message IDs from store (auto-generated by MessageStore.append) */
  const msgIds = [];

  beforeEach(async () => {
    ({ app, messageStore } = await buildApp());
    msgIds.length = 0;

    // Seed messages in a thread — append returns StoredMessage with generated id
    for (let i = 0; i < 7; i++) {
      const stored = messageStore.append({
        threadId: 'peek-thread',
        content: `Message ${i}`,
        userId: 'test-user',
        catId: i % 2 === 0 ? null : 'opus',
        timestamp: Date.now() + i * 1000,
      });
      msgIds.push(stored.id);
    }
  });

  it('returns message window around target', async () => {
    const targetId = msgIds[3]; // 4th message
    const res = await app.inject({
      method: 'GET',
      url: `/api/concierge/peek?threadId=peek-thread&messageId=${targetId}&windowSize=2`,
      headers: { 'x-cat-cafe-user': 'test-user' },
    });
    assert.equal(res.statusCode, 200, `expected 200, got: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.threadId, 'peek-thread');
    assert.equal(body.messageId, targetId);
    assert.ok(Array.isArray(body.window));
    // Should have messages idx 1..5 (3±2)
    assert.equal(body.window.length, 5);
    const target = body.window.find((m) => m.isTarget);
    assert.ok(target, 'window should contain the target message');
    assert.equal(target.id, targetId);
  });

  it('clamps window at thread boundaries', async () => {
    const firstId = msgIds[0]; // first message
    const res = await app.inject({
      method: 'GET',
      url: `/api/concierge/peek?threadId=peek-thread&messageId=${firstId}&windowSize=3`,
      headers: { 'x-cat-cafe-user': 'test-user' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.window.length >= 1 && body.window.length <= 4);
    assert.equal(body.window[0].id, firstId);
    assert.equal(body.window[0].isTarget, true);
  });

  it('returns 404 for non-existent message', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/concierge/peek?threadId=peek-thread&messageId=nonexistent',
      headers: { 'x-cat-cafe-user': 'test-user' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 400 for missing query params', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/concierge/peek',
      headers: { 'x-cat-cafe-user': 'test-user' },
    });
    assert.equal(res.statusCode, 400);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/concierge/config — ballPosition persistence (INV-P3)
// ---------------------------------------------------------------------------

describe('PUT /api/concierge/config — ballPosition', () => {
  let app;

  beforeEach(async () => {
    ({ app } = await buildApp());
  });

  it('P3: accepts valid ball position', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/concierge/config',
      headers: USER_HEADER,
      payload: { ballPosition: { x: 100, y: 200 } },
    });
    assert.equal(res.statusCode, 200, `expected 200, got: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.deepStrictEqual(body.config.ballPosition, { x: 100, y: 200 });
  });

  it('P3: accepts null ball position (reset to default)', async () => {
    // First set a position
    await app.inject({
      method: 'PUT',
      url: '/api/concierge/config',
      headers: USER_HEADER,
      payload: { ballPosition: { x: 50, y: 50 } },
    });
    // Then reset to null
    const res = await app.inject({
      method: 'PUT',
      url: '/api/concierge/config',
      headers: USER_HEADER,
      payload: { ballPosition: null },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.config.ballPosition, null);
  });

  it('rejects non-finite x/y values', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/concierge/config',
      headers: USER_HEADER,
      payload: { ballPosition: { x: Infinity, y: 100 } },
    });
    assert.equal(res.statusCode, 400);
  });
});

// ---------------------------------------------------------------------------
// Architecture: R4 relay key write locality
// ---------------------------------------------------------------------------

describe('Architecture: R4 relay key write locality', () => {
  it('relay store create is only called in concierge relay route', async () => {
    // grep-based architecture test: conciergeRelayStore.create should only
    // appear in the relay route file (not in other domains)
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const routeFile = path.resolve(import.meta.dirname, '../src/routes/concierge.ts');
    const routeContent = await fs.readFile(routeFile, 'utf-8');

    // Verify the relay store write exists in the route
    assert.ok(
      routeContent.includes('conciergeRelayStore.create('),
      'relay route should contain relayStore.create call',
    );

    // Verify no other route file writes to relay store
    const routesDir = path.resolve(import.meta.dirname, '../src/routes');
    const routeFiles = await fs.readdir(routesDir);
    for (const file of routeFiles) {
      if (file === 'concierge.ts') continue; // skip the legitimate writer
      const content = await fs.readFile(path.join(routesDir, file), 'utf-8');
      assert.ok(
        !content.includes('conciergeRelayStore.create(') && !content.includes('RelayStore.create('),
        `R4 violation: ${file} should not write relay records`,
      );
    }
  });
});
