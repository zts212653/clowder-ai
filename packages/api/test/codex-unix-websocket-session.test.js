import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import {
  connectCodexAppServerHost,
  createCodexSocketDirectory,
  removeCodexSocketDirectory,
} from '../dist/domains/cats/services/agents/providers/CodexUnixWebSocketSession.js';

async function withClosingUnixWebSocket(reason, run) {
  const directory = createCodexSocketDirectory();
  const socketPath = join(directory, 'app-server.sock');
  const server = createServer();
  const webSockets = new WebSocketServer({ server });
  webSockets.on('connection', (socket) => socket.close(1009, reason));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  const host = { isAlive: true, socketPath, close: async () => {} };
  let session;
  try {
    session = await connectCodexAppServerHost(host);
    await run(session);
  } finally {
    await session?.close().catch(() => {});
    await new Promise((resolve) => webSockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await removeCodexSocketDirectory(directory);
  }
}

test('unix websocket preserves the provider terminal diagnostic for replacement classification', async () => {
  await withClosingUnixWebSocket('Max payload size exceeded', async (session) => {
    await assert.rejects(
      async () => {
        for await (const _message of session.read()) {
          // The provider closes before producing a JSON-RPC message.
        }
      },
      (error) => error?.message === 'Max payload size exceeded',
    );
  });
});

test('unix websocket sanitizes provider terminal diagnostics before exposing them', async () => {
  await withClosingUnixWebSocket('Bearer sk-proj-abcdefghijklmnopqrstuvwxyz123456', async (session) => {
    await assert.rejects(
      async () => {
        for await (const _message of session.read()) {
          // The provider closes before producing a JSON-RPC message.
        }
      },
      (error) => error?.message === 'Bearer [TOKEN_REDACTED]',
    );
  });
});
