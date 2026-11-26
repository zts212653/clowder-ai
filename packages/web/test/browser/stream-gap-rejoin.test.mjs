import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild-wasm';
import { chromium } from 'playwright';
import { SocketManager } from '../../../api/dist/infrastructure/websocket/SocketManager.js';

const web = fileURLToPath(new URL('../..', import.meta.url));

test(
  'a missing live event rejoins the real room, rebuilds from server records and keeps streaming',
  { timeout: 60000 },
  async (t) => {
    // This dedicated HTTP/Socket.IO instance uses only in-memory synthetic records. It needs no
    // Redis, model credentials or existing runtime. Only the lossy transport is intercepted.
    const compiled = await build({
      entryPoints: [path.join(web, 'test/browser/fixtures/stream-gap-rejoin.tsx')],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      jsx: 'automatic',
      alias: { '@': path.join(web, 'src') },
      define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    });
    const server = createServer((request, response) => {
      if (request.url === '/proof.js') {
        response.setHeader('Content-Type', 'text/javascript');
        return response.end(compiled.outputFiles[0].text);
      }
      if (request.url.startsWith('/api/')) {
        response.setHeader('Content-Type', 'application/json');
        return response.end(JSON.stringify({ userId: 'default-user', queue: [], activeInvocations: [], cats: [] }));
      }
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html data-cat-cafe-api-origin="http://127.0.0.1:${server.address().port}">
        <div id="root"></div><script src="/proof.js"></script></html>`);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    // SocketManager's origin policy is also production code; allow only this ephemeral test origin.
    const previousOrigins = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = origin;
    let manager;
    try {
      manager = new SocketManager(server);
    } finally {
      if (previousOrigins === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = previousOrigins;
    }
    const joins = [];
    const connections = [];
    manager.getIO().on('connection', (socket) => {
      connections.push(socket.id);
      socket.on('join_room', (room) => joins.push(room));
    });
    let browser;
    t.after(async () => {
      await browser?.close();
      await new Promise((resolve) => manager.getIO().close(resolve));
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => t.diagnostic(message.text()));
    page.on('requestfailed', (request) => t.diagnostic(`${request.url()}: ${request.failure()?.errorText}`));
    let releaseJoin;
    let holdNextJoin = false;
    let dropped = 0;
    await page.routeWebSocket('**/socket.io/**', (socket) => {
      const upstream = socket.connectToServer();
      socket.onMessage((packet) => {
        if (holdNextJoin && String(packet).includes('"join_room","thread:gap-thread"')) {
          holdNextJoin = false;
          releaseJoin = () => upstream.send(packet);
        } else upstream.send(packet);
      });
      upstream.onMessage((packet) => {
        const text = String(packet);
        if (text.startsWith('42') && text.includes('"agent_message"')) {
          const [, event] = JSON.parse(text.slice(text.indexOf('[')));
          if (event.content === 'MISSED|' || event.content === 'MISSED-AGAIN|') {
            dropped++;
            return;
          }
        }
        socket.send(packet);
      });
    });
    const threadId = 'gap-thread';
    const messageId = 'reply';
    manager.openResponseStream({
      id: messageId,
      threadId,
      userId: 'default-user',
      from: { kind: 'agent', catId: 'opus' },
      catId: 'opus',
      content: '',
      timestamp: 1,
    });
    await page.goto(origin);
    await page.locator('main[data-connected="true"]').waitFor();
    const body = page.locator('[data-message-id="reply"]');
    const send = (content) =>
      manager.broadcastAgentMessage(
        {
          type: 'text',
          content,
          messageId,
          catId: 'opus',
          timestamp: 2,
          invocationId: 'parent',
          turnInvocationId: 'turn',
        },
        threadId,
      );
    const read = async (expected) => {
      try {
        await page.waitForFunction(
          (expected) => document.querySelector('[data-message-id="reply"]')?.textContent === expected,
          expected,
        );
      } catch (error) {
        t.diagnostic(`expected=${expected}; actual=${await body.textContent()}; joins=${JSON.stringify(joins)}`);
        throw error;
      }
    };
    await page.waitForFunction(() => document.querySelector('main')?.dataset.thread === 'gap-thread');
    // The server confirms joins asynchronously; observe the actual room, not the connect indicator.
    while (joins.filter((room) => room === 'thread:gap-thread').length === 0)
      await new Promise((resolve) => setTimeout(resolve, 10));
    send('A|');
    await read('A|');
    holdNextJoin = true;
    send('MISSED|');
    send('C|');
    // Rejoin is held at the wire: the gap event must still be written before recovery arrives.
    await read('A|C|');
    assert.equal(await body.getAttribute('data-prefix'), 'incomplete');
    assert.equal(typeof releaseJoin, 'function');
    releaseJoin();
    await read('A|MISSED|C|');
    assert.equal(await body.getAttribute('data-prefix'), 'complete');
    send('D|');
    await read('A|MISSED|C|D|');
    send('MISSED-AGAIN|');
    send('F|');
    await read('A|MISSED|C|D|MISSED-AGAIN|F|');
    assert.equal(joins.filter((room) => room === 'thread:gap-thread').length, 3);
    assert.equal(dropped, 2);
    // Leaving the foreground and returning also takes the server's complete list.
    await page.getByRole('button', { name: 'Other thread', exact: true }).click();
    await page.locator('main[data-thread="other-thread"]').waitFor();
    send('WHILE-AWAY|');
    await page.getByRole('button', { name: 'Return', exact: true }).click();
    await read('A|MISSED|C|D|MISSED-AGAIN|F|WHILE-AWAY|');
    // A stored terminal wins, including over a late event and a later room replay.
    manager.closeResponseStream(messageId);
    manager.broadcastToRoom(`thread:${threadId}`, 'message_snapshot_updated', {
      threadId,
      message: {
        id: messageId,
        threadId,
        from: { kind: 'agent', catId: 'opus' },
        catId: 'opus',
        content: 'STORED-FINAL',
        timestamp: 1,
        origin: 'stream',
        lifecycle: {
          kind: 'response',
          orderKey: '1:turn',
          invocationId: 'turn',
          targetId: 'opus',
          inputEntryIds: [],
          inputMessageIds: [],
          status: 'completed',
          startedAt: 1,
          completedAt: 3,
        },
      },
    });
    await read('STORED-FINAL');
    send('LATE|');
    manager.broadcastAgentMessage(
      { type: 'text', origin: 'callback', catId: 'opus', messageId: 'fence', content: 'AFTER-LATE' },
      threadId,
    );
    await page.locator('[data-message-id="fence"]', { hasText: 'AFTER-LATE' }).waitFor();
    assert.equal(await body.textContent(), 'STORED-FINAL');
    await page.getByRole('button', { name: 'Other thread', exact: true }).click();
    await page.getByRole('button', { name: 'Return', exact: true }).click();
    await read('STORED-FINAL');
    assert.deepEqual(errors, []);
    assert.equal(connections.length, 1, 'recovery rejoins rooms on the existing connection');
    console.log(
      JSON.stringify({
        origin,
        joins,
        dropped,
        connections: connections.length,
        final: await body.textContent(),
        errors,
      }),
    );
  },
);
