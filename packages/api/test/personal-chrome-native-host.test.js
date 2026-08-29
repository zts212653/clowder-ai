import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PersonalChromeConversationAuthorizationError,
  readPersonalChromeConversationAuthorizations,
  writePersonalChromeConversationAuthorizationsAtomic,
} from '../src/plugins/cloud-cat-personal-host/native-host/conversation-binding.mjs';
import {
  buildNativeHostInstallPlan,
  installNativeHost,
  uninstallNativeHost,
} from '../src/plugins/cloud-cat-personal-host/native-host/install-host.mjs';
import {
  encodeNativeMessage,
  NativeMessageDecoder,
} from '../src/plugins/cloud-cat-personal-host/native-host/native-framing.mjs';
import { createNativeHostBridge as createNativeHostBridgeImpl } from '../src/plugins/cloud-cat-personal-host/native-host/native-host.mjs';
import {
  LEDGER_ENTRY_LIMIT,
  LEDGER_FILE_LIMIT,
  loadLedger,
  textDigest,
  writeAtomicLedger,
} from '../src/plugins/cloud-cat-personal-host/native-host/native-ledger.mjs';

const bridges = [];
const ledgerArtifacts = new Set();
const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const nativeHostEntrypoint = join(apiRoot, 'src/plugins/cloud-cat-personal-host/native-host/native-host.mjs');
const helperArtifactRevision = `sha512:${'0'.repeat(128)}`;

async function createNativeHostBridge(options) {
  const bridge = await createNativeHostBridgeImpl({ helperArtifactRevision, ...options });
  return {
    ...bridge,
    acceptNativeMessage(message) {
      const normalized =
        message?.kind === 'append_result' && message.observedRevisions === undefined
          ? {
              ...message,
              observedRevisions: {
                helper: helperArtifactRevision,
                extension: '0.2.5',
                pageAdapter: '2026-08-27.1',
              },
            }
          : message;
      return bridge.acceptNativeMessage(normalized);
    },
  };
}

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
  await Promise.all([...ledgerArtifacts].map((path) => rm(path, { recursive: true, force: true })));
  ledgerArtifacts.clear();
});

function testPaths(label) {
  const root = mkdtempSync(join(tmpdir(), `f247-${label}-`));
  const paths = {
    socketPath: join(root, 'host.sock'),
    ledgerPath: join(root, 'ledger.json'),
    conversationBindingPath: join(root, 'conversation-binding.json'),
  };
  ledgerArtifacts.add(root);
  writeFileSync(
    paths.conversationBindingPath,
    `${JSON.stringify({
      schemaVersion: 1,
      provider: 'chatgpt',
      conversationId: 'conversation-7',
      chatUrl: 'https://chatgpt.com/c/conversation-7',
      boundAt: '2026-08-21T07:00:00.000Z',
      updatedAt: '2026-08-21T07:00:00.000Z',
    })}\n`,
    { mode: 0o600 },
  );
  return paths;
}

function localAppend(socketPath, pairingSecret, request) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let input = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline === -1) return;
      resolve(JSON.parse(input.slice(0, newline)));
      socket.end();
    });
    socket.once('connect', () => socket.write(`${JSON.stringify({ pairingSecret, request })}\n`));
  });
}

function appendRequest(overrides = {}) {
  return {
    v: 2,
    kind: 'append_message',
    requestId: 'request-1',
    conversationId: 'conversation-7',
    text: 'hello cloud cat',
    idempotencyKey: 'source-message-9',
    expectedRevisions: {
      helper: helperArtifactRevision,
      extension: '0.2.5',
      pageAdapter: '2026-08-27.1',
    },
    ...overrides,
  };
}

async function waitForPath(path, child, getSpawnError, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`native host exited before creating its socket: ${child.exitCode}`);
    try {
      await stat(path);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for native host socket: ${path}`);
}

async function waitForPathRemoval(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for native host socket removal: ${path}`);
}

function readOneNativeMessage(stream, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const decoder = new NativeMessageDecoder();
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for native host stdout frame'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off('data', onData);
      stream.off('error', onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      try {
        const messages = decoder.push(chunk);
        if (messages.length === 0) return;
        cleanup();
        resolve(messages[0]);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    stream.on('data', onData);
    stream.on('error', onError);
  });
}

function waitForChildExit(child, timeoutMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve([child.exitCode, child.signalCode]);
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = (exitCode, signal) => {
      cleanup();
      resolve([exitCode, signal]);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for native host process exit'));
    }, timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

describe('Native Messaging framing', () => {
  it('round-trips split frames without treating partial input as a message', () => {
    const decoder = new NativeMessageDecoder();
    const encoded = encodeNativeMessage({ kind: 'hello', v: 1 });
    assert.deepEqual(decoder.push(encoded.subarray(0, 3)), []);
    assert.deepEqual(decoder.push(encoded.subarray(3)), [{ kind: 'hello', v: 1 }]);
  });

  it('rejects zero-length and oversized frames before JSON parsing', () => {
    const zero = Buffer.alloc(4);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(1_048_577, 0);
    assert.throws(() => new NativeMessageDecoder().push(zero), /length/i);
    assert.throws(() => new NativeMessageDecoder().push(oversized), /large/i);
  });

  it('rejects a truncated frame when native stdin closes', () => {
    const decoder = new NativeMessageDecoder();
    const encoded = encodeNativeMessage({ kind: 'hello', v: 1 });
    decoder.push(encoded.subarray(0, encoded.length - 1));
    assert.throws(() => decoder.finish(), /truncated/i);
  });
});

describe('personal Chrome native host bridge', () => {
  it('rejects a legacy v1 append before Chrome dispatch', async () => {
    const paths = testPaths('legacy-v1-append');
    const forwarded = [];
    let bridge;
    bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: async (message) => {
        forwarded.push(message);
        await bridge.acceptNativeMessage({
          v: 2,
          kind: 'append_result',
          requestId: message.requestId,
          idempotencyKey: message.idempotencyKey,
          status: 'host_observed',
          hostMessageId: 'must-not-be-observed',
        });
      },
    });
    bridges.push(bridge);

    const result = await localAppend(paths.socketPath, 'a'.repeat(64), appendRequest({ v: 1 }));

    assert.equal(result.errorCode, 'INVALID_REQUEST');
    assert.deepEqual(forwarded, []);
    assert.equal((await loadLedger(paths.ledgerPath)).size, 0);
  });

  it('maps a legacy extension response to stale_adapter without waiting for timeout', async () => {
    const paths = testPaths('legacy-extension-health');
    const forwarded = [];
    let bridge;
    bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: async (message) => {
        forwarded.push(message);
        await bridge.acceptNativeMessage({
          v: 1,
          kind: 'append_result',
          requestId: message.requestId,
          idempotencyKey: 'invalid-key',
          status: 'failed',
          errorCode: 'INVALID_REQUEST',
        });
      },
    });
    bridges.push(bridge);

    const result = await localAppend(paths.socketPath, 'a'.repeat(64), {
      v: 2,
      kind: 'health_check',
      requestId: 'health-legacy-extension',
      conversationId: 'conversation-7',
      expectedRevisions: {
        helper: helperArtifactRevision,
        extension: '0.2.5',
        pageAdapter: '2026-08-27.1',
      },
    });

    assert.equal(result.status, 'stale_adapter');
    assert.equal(result.errorCode, 'STALE_EXTENSION_PROTOCOL');
    assert.deepEqual(result.observedRevisions, {
      helper: helperArtifactRevision,
      extension: '0.0.0',
      pageAdapter: 'unobserved',
    });
    assert.deepEqual(
      forwarded.map((message) => message.kind),
      ['health_check'],
    );
  });

  it('returns typed needs-binding before ledger admission or Chrome dispatch', async () => {
    const paths = testPaths('needs-binding');
    await unlink(paths.conversationBindingPath);
    const forwarded = [];
    const bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: (message) => forwarded.push(message),
    });
    bridges.push(bridge);

    const result = await localAppend(paths.socketPath, 'a'.repeat(64), appendRequest());

    assert.equal(result.errorCode, 'NEEDS_BINDING');
    assert.deepEqual(forwarded, []);
    assert.equal((await loadLedger(paths.ledgerPath)).size, 0);
  });

  it('appends an explicit extension authorization before returning its receipt', async () => {
    const paths = testPaths('explicit-binding');
    await unlink(paths.conversationBindingPath);
    const outbound = [];
    const bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: (message) => outbound.push(message),
      now: () => new Date('2026-08-21T07:30:00.000Z'),
    });
    bridges.push(bridge);

    await bridge.acceptNativeMessage({
      v: 1,
      kind: 'bind_conversation',
      requestId: 'binding-request-1',
      conversationId: 'conversation-8',
      chatUrl: 'https://chatgpt.com/c/conversation-8',
    });

    assert.deepEqual(await readPersonalChromeConversationAuthorizations(paths.conversationBindingPath), {
      schemaVersion: 2,
      provider: 'chatgpt',
      conversations: [
        {
          conversationId: 'conversation-8',
          chatUrl: 'https://chatgpt.com/c/conversation-8',
          authorizedAt: '2026-08-21T07:30:00.000Z',
          updatedAt: '2026-08-21T07:30:00.000Z',
        },
      ],
      updatedAt: '2026-08-21T07:30:00.000Z',
    });
    assert.deepEqual(outbound, [
      {
        v: 1,
        kind: 'binding_result',
        requestId: 'binding-request-1',
        status: 'bound',
        conversationId: 'conversation-8',
        boundAt: '2026-08-21T07:30:00.000Z',
      },
    ]);
  });

  it('reports the durable binding to a restarted extension without rewriting it', async () => {
    const paths = testPaths('binding-status');
    await readPersonalChromeConversationAuthorizations(paths.conversationBindingPath);
    const before = await readFile(paths.conversationBindingPath, 'utf8');
    const outbound = [];
    const bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: (message) => outbound.push(message),
    });
    bridges.push(bridge);

    await bridge.acceptNativeMessage({
      v: 1,
      kind: 'query_binding',
      requestId: 'binding-status-1',
    });

    assert.deepEqual(outbound, [
      {
        v: 1,
        kind: 'binding_status',
        requestId: 'binding-status-1',
        status: 'bound',
        conversationId: 'conversation-7',
        boundAt: '2026-08-21T07:00:00.000Z',
      },
    ]);
    assert.equal(await readFile(paths.conversationBindingPath, 'utf8'), before);
  });

  it(
    'refuses to erase an invalid prior collection during a new authorization',
    { skip: process.platform === 'win32' },
    async () => {
      const paths = testPaths('explicit-rebind-recovery');
      await chmod(paths.conversationBindingPath, 0o644);
      const outbound = [];
      const bridge = await createNativeHostBridge({
        ...paths,
        pairingSecret: 'a'.repeat(64),
        sendNative: (message) => outbound.push(message),
        now: () => new Date('2026-08-21T07:31:00.000Z'),
      });
      bridges.push(bridge);

      await bridge.acceptNativeMessage({
        v: 1,
        kind: 'bind_conversation',
        requestId: 'binding-recovery-1',
        conversationId: 'conversation-8',
        chatUrl: 'https://chatgpt.com/c/conversation-8',
      });

      assert.equal((await stat(paths.conversationBindingPath)).mode & 0o777, 0o644);
      assert.deepEqual(outbound, [
        {
          v: 1,
          kind: 'binding_result',
          requestId: 'binding-recovery-1',
          status: 'failed',
          errorCode: 'BINDING_WRITE_FAILED',
        },
      ]);
    },
  );

  it('returns a typed binding failure when atomic persistence fails', async () => {
    const paths = testPaths('explicit-binding-write-failure');
    const before = await readFile(paths.conversationBindingPath, 'utf8');
    const outbound = [];
    const bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: (message) => outbound.push(message),
      authorizeConversation: async () => {
        const error = new Error('disk full');
        error.code = 'ENOSPC';
        throw error;
      },
    });
    bridges.push(bridge);

    await bridge.acceptNativeMessage({
      v: 1,
      kind: 'bind_conversation',
      requestId: 'binding-write-failure-1',
      conversationId: 'conversation-8',
      chatUrl: 'https://chatgpt.com/c/conversation-8',
    });

    assert.deepEqual(outbound, [
      {
        v: 1,
        kind: 'binding_result',
        requestId: 'binding-write-failure-1',
        status: 'failed',
        errorCode: 'BINDING_WRITE_FAILED',
      },
    ]);
    assert.equal(await readFile(paths.conversationBindingPath, 'utf8'), before);
  });

  it('exposes authorization contention as a bounded cause without leaking persisted binding data', async () => {
    const paths = testPaths('explicit-binding-busy');
    const before = await readFile(paths.conversationBindingPath, 'utf8');
    const outbound = [];
    const bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: (message) => outbound.push(message),
      authorizeConversation: async () => {
        throw new PersonalChromeConversationAuthorizationError(
          'AUTHORIZATION_BUSY',
          'conversation authorization mutation remained busy',
        );
      },
    });
    bridges.push(bridge);

    await bridge.acceptNativeMessage({
      v: 1,
      kind: 'bind_conversation',
      requestId: 'binding-busy-1',
      conversationId: 'conversation-8',
      chatUrl: 'https://chatgpt.com/c/conversation-8',
    });

    assert.deepEqual(outbound, [
      {
        v: 1,
        kind: 'binding_result',
        requestId: 'binding-busy-1',
        status: 'failed',
        errorCode: 'AUTHORIZATION_BUSY',
      },
    ]);
    assert.equal(await readFile(paths.conversationBindingPath, 'utf8'), before);
    assert.equal(JSON.stringify(outbound).includes('conversation-7'), false);
  });

  it(
    'returns typed binding-record-invalid before ledger admission or Chrome dispatch',
    { skip: process.platform === 'win32' },
    async () => {
      const paths = testPaths('invalid-binding');
      await chmod(paths.conversationBindingPath, 0o644);
      const forwarded = [];
      const bridge = await createNativeHostBridge({
        ...paths,
        pairingSecret: 'a'.repeat(64),
        sendNative: (message) => forwarded.push(message),
      });
      bridges.push(bridge);

      const result = await localAppend(paths.socketPath, 'a'.repeat(64), appendRequest());

      assert.equal(result.errorCode, 'BINDING_RECORD_INVALID');
      assert.deepEqual(forwarded, []);
      assert.equal((await loadLedger(paths.ledgerPath)).size, 0);
    },
  );

  it('rejects a routed conversation that does not match the explicit Host authorization', async () => {
    const paths = testPaths('binding-mismatch');
    const forwarded = [];
    const bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: (message) => forwarded.push(message),
    });
    bridges.push(bridge);

    const result = await localAppend(
      paths.socketPath,
      'a'.repeat(64),
      appendRequest({ conversationId: 'conversation-8' }),
    );

    assert.equal(result.errorCode, 'BOUND_CONVERSATION_MISMATCH');
    assert.deepEqual(forwarded, []);
    assert.equal((await loadLedger(paths.ledgerPath)).size, 0);
  });

  it('keeps two conversations authorized and dispatches each retry-idempotently', async () => {
    const paths = testPaths('two-authorized-conversations');
    const outbound = [];
    const bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: (message) => outbound.push(message),
      now: (() => {
        const timestamps = [new Date('2026-08-21T07:30:00.000Z'), new Date('2026-08-21T07:31:00.000Z')];
        return () => timestamps.shift() ?? new Date('2026-08-21T07:31:00.000Z');
      })(),
    });
    bridges.push(bridge);

    await bridge.acceptNativeMessage({
      v: 1,
      kind: 'bind_conversation',
      requestId: 'authorize-conversation-8',
      conversationId: 'conversation-8',
      chatUrl: 'https://chatgpt.com/c/conversation-8',
    });
    const authorizations = await readPersonalChromeConversationAuthorizations(paths.conversationBindingPath);
    assert.deepEqual(
      authorizations.conversations.map((entry) => entry.conversationId),
      ['conversation-7', 'conversation-8'],
    );
    outbound.length = 0;

    const first = localAppend(
      paths.socketPath,
      'a'.repeat(64),
      appendRequest({ requestId: 'request-conversation-7', idempotencyKey: 'source-thread-a' }),
    );
    const second = localAppend(
      paths.socketPath,
      'a'.repeat(64),
      appendRequest({
        requestId: 'request-conversation-8',
        conversationId: 'conversation-8',
        idempotencyKey: 'source-thread-b',
      }),
    );
    await bridge.waitForDispatchCount(2);
    for (const request of outbound.filter((message) => message.kind === 'append_message')) {
      await bridge.acceptNativeMessage({
        v: 2,
        kind: 'append_result',
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        status: 'host_observed',
        hostMessageId: `host-${request.conversationId}`,
      });
    }

    assert.equal((await first).hostMessageId, 'host-conversation-7');
    assert.equal((await second).hostMessageId, 'host-conversation-8');
    const retry = await localAppend(
      paths.socketPath,
      'a'.repeat(64),
      appendRequest({
        requestId: 'retry-conversation-8',
        conversationId: 'conversation-8',
        idempotencyKey: 'source-thread-b',
      }),
    );
    assert.equal(retry.hostMessageId, 'host-conversation-8');
    assert.equal(outbound.filter((message) => message.kind === 'append_message').length, 2);
  });

  it('probes and refuses to replace a live socket without an owner lease', async () => {
    const paths = testPaths('legacy-live-owner');
    const liveOwner = createServer((socket) => socket.end());
    await new Promise((resolve, reject) => {
      liveOwner.once('error', reject);
      liveOwner.listen(paths.socketPath, resolve);
    });

    try {
      await assert.rejects(async () => {
        const replacement = await createNativeHostBridge({
          ...paths,
          pairingSecret: 'b'.repeat(64),
          sendNative: () => undefined,
        });
        bridges.push(replacement);
      }, /socket already has a live owner/);
      assert.equal((await stat(paths.socketPath)).isSocket(), true);
    } finally {
      await new Promise((resolve) => liveOwner.close(resolve));
    }
  });

  it('holds socket ownership until the original helper finishes stopping', async () => {
    const paths = testPaths('stopping-owner');
    let releaseWrite;
    let announceWrite;
    const writeStarted = new Promise((resolve) => {
      announceWrite = resolve;
    });
    const writeGate = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    const bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: () => undefined,
      writeLedger: async (path, entries) => {
        announceWrite();
        await writeGate;
        await writeAtomicLedger(path, entries);
      },
    });
    bridges.push(bridge);

    const pending = localAppend(paths.socketPath, 'a'.repeat(64), appendRequest());
    await writeStarted;
    const stopping = bridge.stop();
    await waitForPathRemoval(paths.socketPath);

    try {
      await assert.rejects(async () => {
        const replacement = await createNativeHostBridge({
          ...paths,
          pairingSecret: 'b'.repeat(64),
          sendNative: () => undefined,
        });
        bridges.push(replacement);
      }, /socket already has a live owner/);
    } finally {
      releaseWrite();
      await stopping;
    }

    assert.equal((await pending).errorCode, 'HOST_STOPPED');
    const replacement = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'b'.repeat(64),
      sendNative: () => undefined,
    });
    bridges.push(replacement);
    const result = await localAppend(paths.socketPath, 'a'.repeat(64), appendRequest());
    assert.equal(result.errorCode, 'PAIRING_REJECTED');
  });

  it('reclaims an owner lease left by a dead helper process', async () => {
    const paths = testPaths('dead-owner');
    const ownerPath = `${paths.socketPath}.owner`;
    await writeFile(ownerPath, `${JSON.stringify({ pid: 2_147_483_647, token: 'dead-owner' })}\n`, { mode: 0o600 });

    try {
      const bridge = await createNativeHostBridge({
        ...paths,
        pairingSecret: 'a'.repeat(64),
        sendNative: () => undefined,
      });
      bridges.push(bridge);
      assert.equal((await stat(paths.socketPath)).isSocket(), true);
    } finally {
      await unlink(ownerPath).catch(() => undefined);
    }
  });

  it('rejects a pairing mismatch without forwarding text to Chrome', async () => {
    const paths = testPaths('pairing');
    const forwarded = [];
    const bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: (message) => forwarded.push(message),
    });
    bridges.push(bridge);

    const result = await localAppend(paths.socketPath, 'b'.repeat(64), appendRequest());

    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'PAIRING_REJECTED');
    assert.deepEqual(forwarded, []);
  });

  it('coalesces concurrent retries and returns one DOM-observed receipt to both callers', async () => {
    const paths = testPaths('dedupe');
    const forwarded = [];
    const bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: (message) => forwarded.push(message),
    });
    bridges.push(bridge);

    const first = localAppend(paths.socketPath, 'a'.repeat(64), appendRequest({ requestId: 'request-1' }));
    const retry = localAppend(paths.socketPath, 'a'.repeat(64), appendRequest({ requestId: 'request-2' }));
    await bridge.waitForDispatchCount(1);
    assert.equal(forwarded.length, 1);
    assert.equal('pairingSecret' in forwarded[0], false);
    assert.ok(['request-1', 'request-2'].includes(forwarded[0].requestId));

    await bridge.acceptNativeMessage({
      v: 2,
      kind: 'append_result',
      // Concurrent Unix socket connects have no arrival-order guarantee. Reply to
      // whichever retry became the canonical dispatch; both callers must share it.
      requestId: forwarded[0].requestId,
      idempotencyKey: 'source-message-9',
      status: 'host_observed',
      hostMessageId: 'chatgpt-user-message-42',
    });

    const receipts = [await first, await retry];
    assert.deepEqual(
      receipts.map((receipt) => receipt.hostMessageId),
      ['chatgpt-user-message-42', 'chatgpt-user-message-42'],
    );
    assert.deepEqual(
      receipts.map((receipt) => receipt.idempotentReplay).sort(),
      [false, true],
      'one canonical delivery and one coalesced retry must be distinguishable',
    );
    assert.equal(forwarded.length, 1);

    const terminalRetry = await localAppend(
      paths.socketPath,
      'a'.repeat(64),
      appendRequest({ requestId: 'request-3' }),
    );
    assert.equal(terminalRetry.hostMessageId, 'chatgpt-user-message-42');
    assert.equal(terminalRetry.idempotentReplay, true);
  });

  it('does not expose a terminal receipt to retries before the terminal ledger write commits', async () => {
    const paths = testPaths('terminal-durability');
    let releaseTerminalWrite;
    let announceTerminalWrite;
    const terminalWriteStarted = new Promise((resolve) => {
      announceTerminalWrite = resolve;
    });
    const terminalWriteGate = new Promise((resolve) => {
      releaseTerminalWrite = resolve;
    });
    let writes = 0;
    const bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: () => undefined,
      writeLedger: async (path, entries) => {
        writes += 1;
        if (writes === 2) {
          announceTerminalWrite();
          await terminalWriteGate;
        }
        await writeAtomicLedger(path, entries);
      },
    });
    bridges.push(bridge);

    const first = localAppend(paths.socketPath, 'a'.repeat(64), appendRequest({ requestId: 'request-1' }));
    await bridge.waitForDispatchCount(1);
    const terminalAcceptance = bridge.acceptNativeMessage({
      v: 2,
      kind: 'append_result',
      requestId: 'request-1',
      idempotencyKey: 'source-message-9',
      status: 'host_observed',
      hostMessageId: 'chatgpt-user-message-42',
    });
    await terminalWriteStarted;

    const retry = localAppend(paths.socketPath, 'a'.repeat(64), appendRequest({ requestId: 'request-2' }));
    const earlyRetryOutcome = await Promise.race([
      retry.then(() => 'resolved'),
      new Promise((resolve) => setImmediate(() => resolve('pending'))),
    ]);
    assert.equal(earlyRetryOutcome, 'pending');

    releaseTerminalWrite();
    await terminalAcceptance;
    assert.equal((await first).hostMessageId, 'chatgpt-user-message-42');
    assert.equal((await retry).hostMessageId, 'chatgpt-user-message-42');
  });

  it('rejects new idempotency keys at the durable ledger capacity without corrupting restart', async () => {
    const paths = testPaths('ledger-capacity');
    const entries = new Map();
    for (let index = 0; index < LEDGER_ENTRY_LIMIT; index += 1) {
      const conversationId = `conversation-${index}`;
      const idempotencyKey = `source-${index}`;
      entries.set(`${conversationId}\u0000${idempotencyKey}`, {
        conversationId,
        idempotencyKey,
        textDigest: textDigest(`text-${index}`),
        state: 'failed',
        errorCode: 'TEST_TERMINAL',
      });
    }
    await writeAtomicLedger(paths.ledgerPath, entries);
    const forwarded = [];
    const bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: (message) => forwarded.push(message),
    });
    bridges.push(bridge);

    const result = await localAppend(paths.socketPath, 'a'.repeat(64), appendRequest());

    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'LEDGER_CAPACITY_EXCEEDED');
    assert.deepEqual(forwarded, []);
    assert.equal((await loadLedger(paths.ledgerPath)).size, LEDGER_ENTRY_LIMIT);
  });

  it('refuses an oversized serialized ledger before replacing the last valid file', async () => {
    const paths = testPaths('ledger-byte-limit');
    const valid = new Map([
      [
        'conversation-7\u0000source-message-9',
        {
          conversationId: 'conversation-7',
          idempotencyKey: 'source-message-9',
          textDigest: textDigest('hello cloud cat'),
          state: 'failed',
          errorCode: 'TEST_TERMINAL',
        },
      ],
    ]);
    await writeAtomicLedger(paths.ledgerPath, valid);
    const before = await readFile(paths.ledgerPath, 'utf8');
    const oversized = new Map(valid);
    oversized.set('oversized', {
      conversationId: 'conversation-oversized',
      idempotencyKey: 'source-oversized',
      textDigest: 'x'.repeat(LEDGER_FILE_LIMIT),
      state: 'failed',
      errorCode: 'TEST_TERMINAL',
    });

    await assert.rejects(() => writeAtomicLedger(paths.ledgerPath, oversized), /capacity exceeded/);

    assert.equal(await readFile(paths.ledgerPath, 'utf8'), before);
    assert.equal((await loadLedger(paths.ledgerPath)).size, 1);
  });

  it('persists a mode-0600 terminal receipt and reuses it after restart without redispatch', async () => {
    const paths = testPaths('restart');
    const forwarded = [];
    const bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: (message) => forwarded.push(message),
    });
    bridges.push(bridge);

    const first = localAppend(paths.socketPath, 'a'.repeat(64), appendRequest());
    await bridge.waitForDispatchCount(1);
    await bridge.acceptNativeMessage({
      v: 2,
      kind: 'append_result',
      requestId: 'request-1',
      idempotencyKey: 'source-message-9',
      status: 'host_observed',
      hostMessageId: 'chatgpt-user-message-42',
    });
    await first;
    await bridge.stop();
    bridges.splice(bridges.indexOf(bridge), 1);

    assert.equal((await stat(paths.ledgerPath)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(paths.ledgerPath, 'utf8')).version, 1);

    const replayed = [];
    const restarted = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: (message) => replayed.push(message),
    });
    bridges.push(restarted);
    const retry = await localAppend(
      paths.socketPath,
      'a'.repeat(64),
      appendRequest({ requestId: 'request-after-restart' }),
    );
    assert.equal(retry.hostMessageId, 'chatgpt-user-message-42');
    assert.deepEqual(replayed, []);
  });

  it('turns a restart after dispatch but before receipt into a terminal ambiguous effect', async () => {
    const paths = testPaths('ambiguous');
    const bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: () => undefined,
    });
    bridges.push(bridge);
    const pending = localAppend(paths.socketPath, 'a'.repeat(64), appendRequest());
    await bridge.waitForDispatchCount(1);
    await bridge.stop();
    bridges.splice(bridges.indexOf(bridge), 1);
    const stopped = await pending;
    assert.equal(stopped.errorCode, 'HOST_STOPPED');
    assert.equal(stopped.idempotencyKey, 'source-message-9');
    assert.equal(stopped.idempotentReplay, false);

    const replayed = [];
    const restarted = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: (message) => replayed.push(message),
    });
    bridges.push(restarted);
    const retry = await localAppend(
      paths.socketPath,
      'a'.repeat(64),
      appendRequest({ requestId: 'request-after-ambiguous-restart' }),
    );
    assert.equal(retry.status, 'failed');
    assert.equal(retry.errorCode, 'AMBIGUOUS_EFFECT');
    assert.equal(retry.idempotentReplay, true);
    assert.deepEqual(replayed, []);
  });

  it('rejects reuse of an idempotency key with different text', async () => {
    const paths = testPaths('conflict');
    const bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: () => undefined,
    });
    bridges.push(bridge);
    const first = localAppend(paths.socketPath, 'a'.repeat(64), appendRequest());
    await bridge.waitForDispatchCount(1);
    const conflict = await localAppend(
      paths.socketPath,
      'a'.repeat(64),
      appendRequest({ requestId: 'request-conflict', text: 'different text' }),
    );
    assert.equal(conflict.errorCode, 'IDEMPOTENCY_CONFLICT');
    await bridge.acceptNativeMessage({
      v: 2,
      kind: 'append_result',
      requestId: 'request-1',
      idempotencyKey: 'source-message-9',
      status: 'failed',
      errorCode: 'TEST_CLEANUP',
    });
    await first;
  });

  it('normalizes an invalid extension error code before persisting or replying', async () => {
    const paths = testPaths('invalid-error-code');
    const bridge = await createNativeHostBridge({
      ...paths,
      pairingSecret: 'a'.repeat(64),
      sendNative: () => undefined,
    });
    bridges.push(bridge);
    const pending = localAppend(paths.socketPath, 'a'.repeat(64), appendRequest());
    await bridge.waitForDispatchCount(1);

    await bridge.acceptNativeMessage({
      v: 2,
      kind: 'append_result',
      requestId: 'request-1',
      idempotencyKey: 'source-message-9',
      status: 'failed',
      errorCode: 'bad-extension-error',
    });

    assert.equal((await pending).errorCode, 'NATIVE_DELIVERY_FAILED');
  });
});

describe('native host install plan', () => {
  it('pins the allowed extension origin and per-user macOS manifest path', () => {
    const extensionId = 'a'.repeat(32);
    const plan = buildNativeHostInstallPlan({
      platform: 'darwin',
      homeDirectory: '/home/user',
      extensionId,
      nativeHostPath: '/Applications/Clowder AI.app/Contents/Resources/personal-chrome-host',
    });
    assert.equal(
      plan.manifestPath,
      '/home/user/Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.catcafe.personal_cloud_cat_host.json',
    );
    assert.deepEqual(plan.manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
    assert.equal(plan.manifest.path, '/Applications/Clowder AI.app/Contents/Resources/personal-chrome-host');
    assert.equal(plan.manifest.type, 'stdio');
  });

  it('uses an explicit Chrome user-data directory for an isolated profile', () => {
    const plan = buildNativeHostInstallPlan({
      platform: 'darwin',
      homeDirectory: '/home/user',
      userDataDirectory: '/tmp/f247-isolated-profile',
      extensionId: 'a'.repeat(32),
      nativeHostPath: '/safe/helper',
    });
    assert.equal(
      plan.manifestPath,
      '/tmp/f247-isolated-profile/NativeMessagingHosts/ai.catcafe.personal_cloud_cat_host.json',
    );
  });

  it('rejects an untrusted extension ID or a relative helper path', () => {
    assert.throws(
      () =>
        buildNativeHostInstallPlan({
          platform: 'darwin',
          homeDirectory: '/home/user',
          extensionId: 'not-an-extension-id',
          nativeHostPath: '/safe/helper',
        }),
      /extensionId/,
    );
    assert.throws(
      () =>
        buildNativeHostInstallPlan({
          platform: 'darwin',
          homeDirectory: '/home/user',
          extensionId: 'a'.repeat(32),
          nativeHostPath: 'relative/helper',
        }),
      /absolute/,
    );
  });

  it(
    'stops the helper and releases its socket lease when Native Messaging decoding fails',
    { skip: process.platform === 'win32' },
    async () => {
      const testRoot = await mkdtemp(join(tmpdir(), 'f247-bad-'));
      const socketPath = join(testRoot, 'h.sock');
      const ownerPath = `${socketPath}.owner`;
      const child = spawn(nativeHostEntrypoint, [], {
        env: {
          ...process.env,
          CAT_CAFE_PERSONAL_CHROME_SOCKET: socketPath,
          CAT_CAFE_PERSONAL_CHROME_LEDGER: join(testRoot, 'r.json'),
          CAT_CAFE_PERSONAL_CHROME_PAIRING_SECRET: 'p'.repeat(64),
          CAT_CAFE_PERSONAL_CHROME_HELPER_ARTIFACT_REVISION: helperArtifactRevision,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let spawnError;
      let stderr = '';
      child.once('error', (error) => {
        spawnError = error;
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });

      try {
        await waitForPath(
          socketPath,
          child,
          () =>
            spawnError ??
            (child.exitCode !== null ? new Error(stderr || `native host exited ${child.exitCode}`) : undefined),
        );
        child.stdin.write(Buffer.alloc(4));
        const [exitCode, signal] = await waitForChildExit(child);
        assert.equal(signal, null);
        assert.equal(exitCode, 1);
        await waitForPathRemoval(socketPath);
        await waitForPathRemoval(ownerPath);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await once(child, 'exit');
        }
        await rm(testRoot, { recursive: true, force: true });
      }
    },
  );

  it(
    'launches the installed manifest target without inherited API env and exchanges a Native Messaging frame',
    { skip: process.platform === 'win32' },
    async () => {
      const testRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f247-native-launch-'));
      const projectRoot = join(testRoot, 'project');
      const pairingSecret = 'p'.repeat(64);
      const plan = await installNativeHost({
        platform: process.platform,
        homeDirectory: testRoot,
        projectRoot,
        extensionId: 'a'.repeat(32),
        generatePairingSecret: () => pairingSecret,
        now: () => new Date('2026-08-12T23:15:00.000Z'),
      });
      await writePersonalChromeConversationAuthorizationsAtomic(plan.conversationBindingPath, {
        schemaVersion: 2,
        provider: 'chatgpt',
        conversations: [
          {
            conversationId: 'conversation-7',
            chatUrl: 'https://chatgpt.com/c/conversation-7',
            authorizedAt: '2026-08-21T07:00:00.000Z',
            updatedAt: '2026-08-21T07:00:00.000Z',
          },
        ],
        updatedAt: '2026-08-21T07:00:00.000Z',
      });
      const mode = (await stat(plan.launcherPath)).mode & 0o777;
      assert.notEqual(mode & 0o111, 0, 'the POSIX manifest target must be executable');

      let spawnError;
      let stderr = '';
      const child = spawn(plan.launcherPath, [], {
        env: {
          HOME: testRoot,
          PATH: join(testRoot, 'path-without-node'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.once('error', (error) => {
        spawnError = error;
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });

      try {
        await waitForPath(
          plan.socketPath,
          child,
          () =>
            spawnError ??
            (child.exitCode !== null ? new Error(stderr || `native host exited ${child.exitCode}`) : undefined),
          10_000,
        );
        const expectedRevisions = {
          helper: plan.artifactDigest,
          extension: '0.2.5',
          pageAdapter: '2026-08-27.1',
        };
        const outboundPromise = readOneNativeMessage(child.stdout);
        const localResultPromise = localAppend(plan.socketPath, pairingSecret, appendRequest({ expectedRevisions }));
        const outbound = await outboundPromise;
        assert.deepEqual(outbound, appendRequest({ expectedRevisions }));

        child.stdin.write(
          encodeNativeMessage({
            v: 2,
            kind: 'append_result',
            requestId: outbound.requestId,
            idempotencyKey: outbound.idempotencyKey,
            status: 'host_observed',
            hostMessageId: 'chatgpt-user-message-launched-host-1',
            observedRevisions: expectedRevisions,
          }),
        );
        assert.equal((await localResultPromise).hostMessageId, 'chatgpt-user-message-launched-host-1');

        child.stdin.end();
        const [exitCode, signal] = await once(child, 'exit');
        assert.equal(signal, null);
        assert.equal(exitCode, 0);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await uninstallNativeHost({ platform: process.platform, projectRoot, homeDirectory: testRoot }).catch(
          () => undefined,
        );
        await rm(testRoot, { recursive: true, force: true });
      }
    },
  );
});
