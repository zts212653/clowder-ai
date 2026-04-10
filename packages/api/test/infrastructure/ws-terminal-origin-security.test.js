/**
 * F156 Phase B-1: Terminal WebSocket Origin Security Tests
 *
 * Verifies that @fastify/websocket terminal endpoints reject connections
 * from unauthorized origins. These endpoints bypass Socket.IO entirely —
 * they need their own Origin guard.
 *
 * Phase A fixed Socket.IO (allowRequest). Phase B-1 fixes plain WS.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import websocketPlugin from '@fastify/websocket';
import Fastify from 'fastify';
import WebSocket from 'ws';

/**
 * Helper: attempt a WebSocket upgrade with specific headers.
 * Returns { upgraded, closeCode, statusCode, error }.
 */
function attemptWsUpgrade(port, path, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });

    const timer = setTimeout(() => {
      ws.close();
      resolve({ upgraded: false, error: 'timeout' });
    }, 3000);

    ws.on('open', () => {
      // Upgrade succeeded — handler will close shortly (no session exists)
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ upgraded: true, closeCode: code, reason: reason.toString() });
    });

    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      resolve({ upgraded: false, statusCode: res.statusCode });
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      resolve({ upgraded: false, error: err.message });
    });
  });
}

describe('F156 Phase B-1: Terminal WS Origin Security', () => {
  let app;
  let port;

  before(async () => {
    // Deterministic CORS behavior
    delete process.env.CORS_ALLOW_PRIVATE_NETWORK;
    delete process.env.FRONTEND_URL;
    delete process.env.FRONTEND_PORT;

    const { terminalRoutes } = await import('../../dist/routes/terminal.js');

    app = Fastify({ logger: false });
    await app.register(websocketPlugin);
    await app.register(terminalRoutes, {});
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = app.server.address().port;
  });

  after(async () => {
    await app?.close();
  });

  // --- AC-B1a: Origin validation on plain WS ---

  it('AC-B1a: rejects terminal session WS from evil origin', async () => {
    const result = await attemptWsUpgrade(port, '/api/terminal/sessions/test/ws', {
      origin: 'https://evil.example',
      'x-cat-cafe-user': 'default-user',
    });
    assert.strictEqual(result.upgraded, false, 'Evil origin WS must not upgrade');
    assert.strictEqual(result.statusCode, 403, 'Should get 403 Forbidden');
  });

  it('AC-B1a: rejects agent-pane WS from evil origin', async () => {
    const result = await attemptWsUpgrade(port, '/api/terminal/agent-panes/test-pane/ws?worktreeId=wt-1', {
      origin: 'https://evil.example',
      'x-cat-cafe-user': 'default-user',
    });
    assert.strictEqual(result.upgraded, false, 'Evil origin WS must not upgrade');
    assert.strictEqual(result.statusCode, 403, 'Should get 403 Forbidden');
  });

  it('AC-B1a: allows WS from localhost:3003', async () => {
    const result = await attemptWsUpgrade(port, '/api/terminal/sessions/test/ws', {
      origin: 'http://localhost:3003',
      'x-cat-cafe-user': 'default-user',
    });
    assert.strictEqual(result.upgraded, true, 'Legitimate origin should upgrade');
    // Handler closes with 4004 (no session) — proves Origin was accepted
    assert.strictEqual(result.closeCode, 4004, 'Handler should close 4004 (no session)');
  });

  it('AC-B1a: allows WS from 127.0.0.1 loopback', async () => {
    const result = await attemptWsUpgrade(port, '/api/terminal/sessions/test/ws', {
      origin: 'http://127.0.0.1:5173',
      'x-cat-cafe-user': 'default-user',
    });
    assert.strictEqual(result.upgraded, true, 'Loopback origin should upgrade');
  });

  it('AC-B1a: allows WS with no origin (non-browser client)', async () => {
    const result = await attemptWsUpgrade(port, '/api/terminal/sessions/test/ws', {
      'x-cat-cafe-user': 'default-user',
    });
    assert.strictEqual(result.upgraded, true, 'No-origin should upgrade');
  });

  it('AC-B1a: rejects private network origin by default', async () => {
    const result = await attemptWsUpgrade(port, '/api/terminal/sessions/test/ws', {
      origin: 'http://192.168.1.200:8080',
      'x-cat-cafe-user': 'default-user',
    });
    assert.strictEqual(result.upgraded, false, 'Private network should be rejected');
    assert.strictEqual(result.statusCode, 403);
  });

  // --- AC-B1b: Identity hardening ---

  it('AC-B1b: WS succeeds without userId (server determines identity)', async () => {
    // No X-Cat-Cafe-User header, no ?userId query param
    // After fix: WS identity is server-determined, preHandler skips for WS
    const result = await attemptWsUpgrade(port, '/api/terminal/sessions/test/ws', {
      origin: 'http://localhost:3003',
      // No identity at all
    });
    assert.strictEqual(result.upgraded, true, 'WS must not require client identity');
    assert.strictEqual(result.closeCode, 4004, 'Handler uses default-user, no session found');
  });
});
