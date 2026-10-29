import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import {
  connectCodexAppServerHost,
  createCodexSocketDirectory,
  removeCodexSocketDirectory,
  spawnCodexAppServerHost,
} from '../dist/domains/cats/services/agents/providers/CodexUnixWebSocketSession.js';
import { DEFAULT_MAX_NDJSON_RECORD_BYTES } from '../dist/utils/ndjson-parser.js';

async function withClosingUnixWebSocket(reason, run) {
  const directory = createCodexSocketDirectory();
  const socketPath = join(directory, 'app-server.sock');
  const server = createServer();
  const webSockets = new WebSocketServer({ server });
  webSockets.on('connection', (socket) => (typeof reason === 'function' ? reason(socket) : socket.close(1009, reason)));
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

test('a local websocket record limit is not a provider resume-replacement verdict', async () => {
  await withClosingUnixWebSocket(
    (socket) => {
      // Declare a large frame without allocating or transmitting a 64MiB body.
      const header = Buffer.alloc(10);
      header[0] = 0x82;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(DEFAULT_MAX_NDJSON_RECORD_BYTES + 1), 2);
      socket._socket.write(header);
    },
    async (session) => {
      await assert.rejects(
        async () => {
          for await (const _message of session.read()) {
            /* no record can be admitted */
          }
        },
        (error) => error.code === 'NDJSON_RECORD_TOO_LARGE' && error.message !== 'Max payload size exceeded',
      );
    },
  );
});

test('unix host allows native cold initialization beyond ten seconds', { timeout: 20_000 }, async () => {
  const directory = createCodexSocketDirectory();
  const socketPath = join(directory, 'cold.sock');
  let host;
  try {
    host = await spawnCodexAppServerHost({
      command: process.execPath,
      args: [
        '-e',
        `setTimeout(() => require('node:net').createServer().listen(${JSON.stringify(socketPath)}), 11_000)`,
      ],
      socketDirectory: directory,
      socketPath,
    });
    assert.equal(host.isAlive, true);
  } finally {
    await host?.close();
    await removeCodexSocketDirectory(directory);
  }
});

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
  await withClosingUnixWebSocket(['Bearer sk', '-proj-abcdefghijklmnopqrstuvwxyz123456'].join(''), async (session) => {
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

test('unix host sanitizes stderr before taking its tail diagnostic', async () => {
  const directory = createCodexSocketDirectory();
  const socketPath = join(directory, 'missing.sock');
  const token = `sk-${'X'.repeat(40)}`;
  const stderr = `${'A'.repeat(1_100)}${token}${'B'.repeat(980)}`;
  try {
    await assert.rejects(
      () =>
        spawnCodexAppServerHost({
          command: process.execPath,
          args: ['--input-type=module', '-e', `process.stderr.write(${JSON.stringify(stderr)}); process.exit(1);`],
          socketDirectory: directory,
          socketPath,
        }),
      (error) => {
        assert.doesNotMatch(error.message, /X{8,}/);
        assert.match(error.message, /\[TOKEN_REDACTED\]/);
        return true;
      },
    );
  } finally {
    await removeCodexSocketDirectory(directory);
  }
});
