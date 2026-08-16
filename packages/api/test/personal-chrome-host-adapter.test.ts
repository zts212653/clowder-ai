import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  createPersonalChromeHostAdapterFromEnv,
  PersonalChromeHostAdapter,
  PersonalChromeHostError,
  RefreshablePersonalChromeHostAdapter,
} from '../src/domains/cats/services/cloud-bridge/personal-chrome-host/personal-chrome-host-adapter.js';

const sockets = new Set<string>();
const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...sockets].map((path) => unlink(path).catch(() => undefined)));
  await Promise.all([...roots].map((path) => rm(path, { recursive: true, force: true })));
  sockets.clear();
  roots.clear();
});

async function writePairingRecord(path: string, socketPath: string, pairingSecret: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      extensionId: 'a'.repeat(32),
      socketPath,
      ledgerPath: join(dirname(path), 'delivery-ledger.json'),
      pairingSecret,
      artifactDigest: `sha512:${'0'.repeat(128)}`,
      installedAt: '2026-08-12T23:00:00.000Z',
      updatedAt: '2026-08-12T23:00:00.000Z',
    })}\n`,
    { mode: 0o600 },
  );
}

async function startReplyServer(
  reply: (envelope: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ socketPath: string; close: () => Promise<void>; calls: Record<string, unknown>[] }> {
  const socketPath = `/tmp/cat-cafe-f247-adapter-${process.pid}-${Math.random().toString(16).slice(2)}.sock`;
  sockets.add(socketPath);
  const calls: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline === -1) return;
      const envelope = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
      calls.push(envelope);
      socket.end(`${JSON.stringify(reply(envelope))}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    calls,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

describe('PersonalChromeHostAdapter', () => {
  it('activates and deactivates from the canonical pairing record without an API restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cat-cafe-f247-refreshable-'));
    roots.add(root);
    const pairingRecordPath = join(root, 'pairing.json');
    const secret = 'r'.repeat(64);
    const server = await startReplyServer((envelope) => {
      const request = envelope.request as Record<string, unknown>;
      return {
        v: 1,
        kind: 'append_result',
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        status: 'host_observed',
        hostMessageId: 'chatgpt-user-message-refreshable',
      };
    });
    const events: Array<{ context: object; message: string }> = [];
    const adapter = new RefreshablePersonalChromeHostAdapter({
      pairingRecordPath,
      env: {},
      requestId: () => 'refreshable-request',
      logger: {
        info: (context, message) => events.push({ context, message }),
        warn: (context, message) => events.push({ context, message }),
      },
    });

    try {
      await assert.rejects(
        adapter.append_message('conversation-7', 'hello', 'source-message-refreshable'),
        (error: unknown) => error instanceof PersonalChromeHostError && error.code === 'HOST_UNAVAILABLE',
      );

      await writePairingRecord(pairingRecordPath, server.socketPath, secret);
      assert.deepEqual(await adapter.append_message('conversation-7', 'hello', 'source-message-refreshable'), {
        hostMessageId: 'chatgpt-user-message-refreshable',
      });
      assert.equal(server.calls[0].pairingSecret as string, secret);

      await unlink(pairingRecordPath);
      await assert.rejects(
        adapter.append_message('conversation-7', 'hello again', 'source-message-after-uninstall'),
        (error: unknown) => error instanceof PersonalChromeHostError && error.code === 'HOST_UNAVAILABLE',
      );
      assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));
    } finally {
      await server.close();
    }
  });

  it('rejects a partial operator override instead of mixing env and persisted credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cat-cafe-f247-refreshable-partial-'));
    roots.add(root);
    const pairingRecordPath = join(root, 'pairing.json');
    await writePairingRecord(pairingRecordPath, '/tmp/persisted.sock', 's'.repeat(64));
    const adapter = new RefreshablePersonalChromeHostAdapter({
      pairingRecordPath,
      env: { CAT_CAFE_PERSONAL_CHROME_SOCKET: '/tmp/override.sock' },
      logger: { info: () => undefined, warn: () => undefined },
    });

    await assert.rejects(
      adapter.append_message('conversation-7', 'hello', 'source-message-partial'),
      (error: unknown) => error instanceof PersonalChromeHostError && error.code === 'INVALID_CONFIGURATION',
    );
  });

  it('activates from the runtime socket + pairing configuration without logging the secret', () => {
    const events: Array<{ context: object; message: string }> = [];
    const secret = 'runtime-secret'.repeat(4);
    const adapter = createPersonalChromeHostAdapterFromEnv(
      {
        CAT_CAFE_PERSONAL_CHROME_SOCKET: '/tmp/cat-cafe-personal-host.sock',
        CAT_CAFE_PERSONAL_CHROME_PAIRING_SECRET: secret,
      },
      {
        info: (context, message) => events.push({ context, message }),
        warn: (context, message) => events.push({ context, message }),
      },
    );

    assert.ok(adapter instanceof PersonalChromeHostAdapter);
    assert.equal(events.length, 1);
    assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));
  });

  it('keeps runtime activation disabled for absent, partial, or invalid configuration', () => {
    const events: Array<{ context: object; message: string }> = [];
    const logger = {
      info: (context: object, message: string) => events.push({ context, message }),
      warn: (context: object, message: string) => events.push({ context, message }),
    };

    assert.equal(createPersonalChromeHostAdapterFromEnv({}, logger), null);
    assert.equal(
      createPersonalChromeHostAdapterFromEnv(
        { CAT_CAFE_PERSONAL_CHROME_SOCKET: '/tmp/cat-cafe-personal-host.sock' },
        logger,
      ),
      null,
    );
    assert.equal(
      createPersonalChromeHostAdapterFromEnv(
        {
          CAT_CAFE_PERSONAL_CHROME_SOCKET: '/tmp/cat-cafe-personal-host.sock',
          CAT_CAFE_PERSONAL_CHROME_PAIRING_SECRET: 'too-short',
        },
        logger,
      ),
      null,
    );
    assert.equal(events.length, 2);
    assert.match(events[0].message, /incomplete/);
    assert.match(events[1].message, /rejected/);
  });

  it('sends the exact append contract with a local pairing secret and returns only the host receipt', async () => {
    const server = await startReplyServer((envelope) => {
      const request = envelope.request as Record<string, unknown>;
      return {
        v: 1,
        kind: 'append_result',
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        status: 'host_observed',
        hostMessageId: 'chatgpt-user-message-42',
      };
    });
    try {
      const adapter = new PersonalChromeHostAdapter({
        socketPath: server.socketPath,
        pairingSecret: 's'.repeat(64),
        requestId: () => 'request-1',
      });

      const result = await adapter.append_message('conversation-7', 'hello cloud cat', 'source-message-9');

      assert.deepEqual(result, { hostMessageId: 'chatgpt-user-message-42' });
      assert.deepEqual(server.calls, [
        {
          pairingSecret: 's'.repeat(64),
          request: {
            v: 1,
            kind: 'append_message',
            requestId: 'request-1',
            conversationId: 'conversation-7',
            text: 'hello cloud cat',
            idempotencyKey: 'source-message-9',
          },
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('fails closed when the helper reports success without a DOM host message ID', async () => {
    const server = await startReplyServer((envelope) => {
      const request = envelope.request as Record<string, unknown>;
      return {
        v: 1,
        kind: 'append_result',
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        status: 'host_observed',
        hostMessageId: '   ',
      };
    });
    try {
      const adapter = new PersonalChromeHostAdapter({
        socketPath: server.socketPath,
        pairingSecret: 's'.repeat(64),
        requestId: () => 'request-2',
      });
      await assert.rejects(
        adapter.append_message('conversation-7', 'hello', 'source-message-9'),
        (error: unknown) => error instanceof PersonalChromeHostError && error.code === 'INVALID_HOST_RECEIPT',
      );
    } finally {
      await server.close();
    }
  });

  it('preserves the helper error code instead of falling through to another browser transport', async () => {
    const server = await startReplyServer((envelope) => {
      const request = envelope.request as Record<string, unknown>;
      return {
        v: 1,
        kind: 'append_result',
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        status: 'failed',
        errorCode: 'PAIRING_REJECTED',
      };
    });
    try {
      const adapter = new PersonalChromeHostAdapter({
        socketPath: server.socketPath,
        pairingSecret: 'wrong'.repeat(16),
        requestId: () => 'request-3',
      });
      await assert.rejects(
        adapter.append_message('conversation-7', 'hello', 'source-message-9'),
        (error: unknown) => error instanceof PersonalChromeHostError && error.code === 'PAIRING_REJECTED',
      );
    } finally {
      await server.close();
    }
  });
});
