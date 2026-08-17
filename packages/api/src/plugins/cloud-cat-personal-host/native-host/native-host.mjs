#!/usr/bin/env node

import { timingSafeEqual } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { encodeNativeMessage, NativeMessageDecoder } from './native-framing.mjs';
import { hasCapacityForEntry, ledgerKey, loadLedger, textDigest, writeAtomicLedger } from './native-ledger.mjs';
import { applyTerminalResult, failureFor, safeErrorCode, safeToken, terminalResult } from './native-results.mjs';
import { acquireSocketLease, prepareSocketPath } from './native-socket-lease.mjs';
import { readPersonalChromePairingRecord } from './pairing-record.mjs';

const LOCAL_FRAME_LIMIT = 256 * 1024;
const PROGRESS_ORDER = new Map([
  ['accepted', 0],
  ['extension_received', 1],
  ['inserted', 2],
  ['submitted', 3],
]);

function parseAppendRequest(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('INVALID_REQUEST');
  if (value.v !== 1 || value.kind !== 'append_message') throw new Error('INVALID_REQUEST');
  if (!safeToken(value.requestId, 200)) throw new Error('INVALID_REQUEST');
  if (!safeToken(value.conversationId, 200)) throw new Error('INVALID_REQUEST');
  if (!safeToken(value.idempotencyKey, 512)) throw new Error('INVALID_REQUEST');
  if (typeof value.text !== 'string' || value.text.trim().length === 0 || Buffer.byteLength(value.text) > 128 * 1024) {
    throw new Error('INVALID_REQUEST');
  }
  return {
    v: 1,
    kind: 'append_message',
    requestId: value.requestId,
    conversationId: value.conversationId,
    text: value.text,
    idempotencyKey: value.idempotencyKey,
  };
}

function secretsMatch(expected, received) {
  if (typeof received !== 'string') return false;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(received, 'utf8');
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

function sendSocketResult(socket, result) {
  if (!socket.destroyed) socket.end(`${JSON.stringify(result)}\n`);
}

export async function createNativeHostBridge(options) {
  if (!options?.socketPath || !options?.ledgerPath) throw new Error('socketPath and ledgerPath are required');
  if (typeof options.pairingSecret !== 'string' || options.pairingSecret.length < 32) {
    throw new Error('pairingSecret must contain at least 32 characters');
  }
  if (typeof options.sendNative !== 'function') throw new Error('sendNative is required');
  if (options.writeLedger !== undefined && typeof options.writeLedger !== 'function') {
    throw new Error('writeLedger must be a function');
  }
  const writeLedger = options.writeLedger ?? writeAtomicLedger;

  const ledger = await loadLedger(options.ledgerPath);
  let ledgerDirty = false;
  for (const entry of ledger.values()) {
    if (entry.state !== 'host_observed' && entry.state !== 'failed') {
      entry.state = 'failed';
      entry.errorCode = 'AMBIGUOUS_EFFECT';
      ledgerDirty = true;
    }
  }
  if (ledgerDirty) await writeAtomicLedger(options.ledgerPath, ledger);

  await mkdir(dirname(options.socketPath), { recursive: true });
  const socketLease = await acquireSocketLease(options.socketPath);
  try {
    await prepareSocketPath(options.socketPath);
  } catch (error) {
    await socketLease.release();
    throw error;
  }
  const pendingByKey = new Map();
  const keyByRequestId = new Map();
  const openSockets = new Set();
  const dispatchWaiters = [];
  let dispatchCount = 0;
  let stopped = false;
  let persistenceQueue = Promise.resolve();

  const persist = () => {
    const snapshot = new Map([...ledger].map(([key, value]) => [key, { ...value }]));
    const write = persistenceQueue.then(() => writeLedger(options.ledgerPath, snapshot));
    persistenceQueue = write.catch(() => undefined);
    return write;
  };

  function announceDispatch() {
    dispatchCount += 1;
    for (let index = dispatchWaiters.length - 1; index >= 0; index -= 1) {
      if (dispatchCount >= dispatchWaiters[index].count) {
        dispatchWaiters.splice(index, 1)[0].resolve();
      }
    }
  }

  async function settle(key, result) {
    const pending = pendingByKey.get(key);
    if (!pending) return;
    const entry = ledger.get(key);
    if (!entry) return;
    applyTerminalResult(entry, result);
    await persist();
    pendingByKey.delete(key);
    keyByRequestId.delete(pending.canonicalRequestId);
    for (const responder of pending.responders) {
      sendSocketResult(responder.socket, terminalResult(entry, responder.requestId));
    }
  }

  async function handleEnvelope(socket, rawEnvelope) {
    const rawRequest = rawEnvelope?.request;
    if (!secretsMatch(options.pairingSecret, rawEnvelope?.pairingSecret)) {
      sendSocketResult(socket, failureFor(rawRequest, 'PAIRING_REJECTED'));
      return;
    }
    let request;
    try {
      request = parseAppendRequest(rawRequest);
    } catch {
      sendSocketResult(socket, failureFor(rawRequest, 'INVALID_REQUEST'));
      return;
    }
    const key = ledgerKey(request.conversationId, request.idempotencyKey);
    const digest = textDigest(request.text);
    const existing = ledger.get(key);
    if (existing && existing.textDigest !== digest) {
      sendSocketResult(socket, failureFor(request, 'IDEMPOTENCY_CONFLICT'));
      return;
    }
    const pending = pendingByKey.get(key);
    if (pending) {
      pending.responders.push({ socket, requestId: request.requestId });
      return;
    }
    if (existing?.state === 'host_observed' || existing?.state === 'failed') {
      sendSocketResult(socket, terminalResult(existing, request.requestId));
      return;
    }
    const acceptedEntry = {
      conversationId: request.conversationId,
      idempotencyKey: request.idempotencyKey,
      textDigest: digest,
      state: 'accepted',
    };
    if (!existing && !hasCapacityForEntry(ledger, acceptedEntry)) {
      sendSocketResult(socket, failureFor(request, 'LEDGER_CAPACITY_EXCEEDED'));
      return;
    }

    ledger.set(key, acceptedEntry);
    pendingByKey.set(key, {
      canonicalRequestId: request.requestId,
      responders: [{ socket, requestId: request.requestId }],
    });
    keyByRequestId.set(request.requestId, key);
    try {
      await persist();
      await options.sendNative(request);
      announceDispatch();
    } catch {
      await settle(key, failureFor(request, 'NATIVE_DISPATCH_FAILED'));
    }
  }

  const server = createServer((socket) => {
    openSockets.add(socket);
    let input = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.on('close', () => openSockets.delete(socket));
    socket.on('data', (chunk) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > LOCAL_FRAME_LIMIT) {
        handled = true;
        sendSocketResult(socket, failureFor(undefined, 'LOCAL_FRAME_TOO_LARGE'));
        return;
      }
      const newline = input.indexOf('\n');
      if (newline === -1) return;
      handled = true;
      let envelope;
      try {
        envelope = JSON.parse(input.slice(0, newline));
      } catch {
        sendSocketResult(socket, failureFor(undefined, 'INVALID_LOCAL_FRAME'));
        return;
      }
      void handleEnvelope(socket, envelope).catch(() => {
        sendSocketResult(socket, failureFor(envelope?.request, 'HELPER_INTERNAL_ERROR'));
      });
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.socketPath, resolve);
    });
    await chmod(options.socketPath, 0o600);
  } catch (error) {
    if (server.listening) {
      await new Promise((resolve, reject) =>
        server.close((closeError) => (closeError ? reject(closeError) : resolve())),
      );
    }
    await socketLease.release();
    throw error;
  }

  async function acceptProgress(message) {
    if (message?.kind !== 'append_progress') return false;
    const key = keyByRequestId.get(message.requestId);
    const entry = key ? ledger.get(key) : undefined;
    const currentOrder = entry ? PROGRESS_ORDER.get(entry.state) : undefined;
    const nextOrder = PROGRESS_ORDER.get(message.status);
    if (
      entry &&
      message.idempotencyKey === entry.idempotencyKey &&
      nextOrder !== undefined &&
      currentOrder !== undefined &&
      nextOrder >= currentOrder
    ) {
      entry.state = message.status;
      await persist();
    }
    return true;
  }

  async function acceptTerminalResult(message) {
    if (message?.v !== 1 || message?.kind !== 'append_result') return;
    const key = keyByRequestId.get(message.requestId);
    if (!key) return;
    const entry = ledger.get(key);
    if (!entry || message.idempotencyKey !== entry.idempotencyKey) {
      await settle(key, failureFor(message, 'INVALID_HOST_RECEIPT'));
      return;
    }
    if (message.status === 'host_observed') {
      await settle(key, message);
      return;
    }
    const errorCode = safeErrorCode(message.errorCode) ? message.errorCode : 'NATIVE_DELIVERY_FAILED';
    await settle(key, failureFor(message, errorCode));
  }

  return {
    socketPath: options.socketPath,
    ledgerPath: options.ledgerPath,
    async acceptNativeMessage(message) {
      if (await acceptProgress(message)) return;
      await acceptTerminalResult(message);
    },
    waitForDispatchCount(count) {
      if (dispatchCount >= count) return Promise.resolve();
      return new Promise((resolve) => dispatchWaiters.push({ count, resolve }));
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        for (const [key, pending] of pendingByKey) {
          const entry = ledger.get(key);
          for (const responder of pending.responders) {
            sendSocketResult(
              responder.socket,
              failureFor({ requestId: responder.requestId, idempotencyKey: entry?.idempotencyKey }, 'HOST_STOPPED'),
            );
          }
        }
        for (const socket of openSockets) socket.destroy();
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        await persistenceQueue;
      } finally {
        await socketLease.release();
      }
    },
  };
}

function pairingRecordArgument(argv) {
  const index = argv.indexOf('--pairing-record');
  return index === -1 ? undefined : argv[index + 1];
}

export async function resolveNativeHostConfiguration({
  pairingRecordPath,
  env = process.env,
  argv = process.argv.slice(2),
} = {}) {
  const explicitRecordPath = pairingRecordPath ?? pairingRecordArgument(argv);
  if (explicitRecordPath) {
    const record = await readPersonalChromePairingRecord(explicitRecordPath);
    return {
      socketPath: record.socketPath,
      ledgerPath: record.ledgerPath,
      pairingSecret: record.pairingSecret,
    };
  }
  const socketPath = env.CAT_CAFE_PERSONAL_CHROME_SOCKET;
  const ledgerPath = env.CAT_CAFE_PERSONAL_CHROME_LEDGER;
  const pairingSecret = env.CAT_CAFE_PERSONAL_CHROME_PAIRING_SECRET;
  if (!socketPath || !ledgerPath || !pairingSecret) {
    throw new Error('required personal Chrome host configuration is missing');
  }
  return { socketPath, ledgerPath, pairingSecret };
}

export async function runNativeHost(options = {}) {
  const { socketPath, ledgerPath, pairingSecret } = await resolveNativeHostConfiguration(options);
  const decoder = new NativeMessageDecoder();
  const bridge = await createNativeHostBridge({
    socketPath,
    ledgerPath,
    pairingSecret,
    sendNative: (message) => {
      process.stdout.write(encodeNativeMessage(message));
    },
  });
  let bridgeStop;
  const stopBridge = () => {
    bridgeStop ??= bridge.stop();
    return bridgeStop;
  };
  const reportFailure = (error) => {
    process.exitCode = 1;
    process.stderr.write(`personal Chrome native host failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
  };
  const stopAfterInputFailure = (error) => {
    reportFailure(error);
    process.stdin.destroy();
    void stopBridge().catch(reportFailure);
  };
  process.stdin.on('data', (chunk) => {
    try {
      for (const message of decoder.push(chunk)) void bridge.acceptNativeMessage(message);
    } catch (error) {
      stopAfterInputFailure(error);
    }
  });
  process.stdin.once('end', () => {
    try {
      decoder.finish();
    } catch (error) {
      stopAfterInputFailure(error);
      return;
    }
    void stopBridge().catch(reportFailure);
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  runNativeHost({ argv: process.argv.slice(2) }).catch((error) => {
    process.stderr.write(`personal Chrome native host failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
    process.exitCode = 1;
  });
}
