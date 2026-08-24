#!/usr/bin/env node

import { timingSafeEqual } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  authorizePersonalChromeConversation,
  conversationIdFromExactChatGptUrl,
  PersonalChromeConversationAuthorizationError,
  readPersonalChromeConversationAuthorizations,
} from './conversation-binding.mjs';
import { encodeNativeMessage, NativeMessageDecoder } from './native-framing.mjs';
import { hasCapacityForEntry, ledgerKey, loadLedger, textDigest, writeAtomicLedger } from './native-ledger.mjs';
import {
  applyTerminalResult,
  failureFor,
  safeErrorCode,
  safeRevisions,
  safeToken,
  terminalResult,
} from './native-results.mjs';
import { acquireSocketLease, prepareSocketPath } from './native-socket-lease.mjs';
import { readPersonalChromePairingRecord } from './pairing-record.mjs';

const LOCAL_FRAME_LIMIT = 256 * 1024;
const APPEND_PROTOCOL_VERSION = 2;
const PROGRESS_ORDER = new Map([
  ['accepted', 0],
  ['extension_received', 1],
  ['inserted', 2],
  ['submitted', 3],
]);

function parseAppendRequest(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('INVALID_REQUEST');
  if (value.v !== APPEND_PROTOCOL_VERSION || value.kind !== 'append_message') throw new Error('INVALID_REQUEST');
  if (!safeToken(value.requestId, 200)) throw new Error('INVALID_REQUEST');
  if (!safeToken(value.conversationId, 200)) throw new Error('INVALID_REQUEST');
  if (!safeToken(value.idempotencyKey, 512)) throw new Error('INVALID_REQUEST');
  if (typeof value.text !== 'string' || value.text.trim().length === 0 || Buffer.byteLength(value.text) > 128 * 1024) {
    throw new Error('INVALID_REQUEST');
  }
  const expectedRevisions = safeRevisions(value.expectedRevisions);
  if (!expectedRevisions) throw new Error('INVALID_REQUEST');
  return {
    v: APPEND_PROTOCOL_VERSION,
    kind: 'append_message',
    requestId: value.requestId,
    conversationId: value.conversationId,
    text: value.text,
    idempotencyKey: value.idempotencyKey,
    expectedRevisions,
  };
}

function parseBindingRequest(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('INVALID_REQUEST');
  if (value.v !== 1 || value.kind !== 'bind_conversation') throw new Error('INVALID_REQUEST');
  if (!safeToken(value.requestId, 200)) throw new Error('INVALID_REQUEST');
  if (!safeToken(value.conversationId, 200)) throw new Error('INVALID_REQUEST');
  if (conversationIdFromExactChatGptUrl(value.chatUrl) !== value.conversationId) {
    throw new Error('INVALID_REQUEST');
  }
  return {
    v: 1,
    kind: 'bind_conversation',
    requestId: value.requestId,
    conversationId: value.conversationId,
    chatUrl: `https://chatgpt.com/c/${value.conversationId}`,
  };
}

function parseBindingQuery(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('INVALID_REQUEST');
  if (value.v !== 1 || value.kind !== 'query_binding') throw new Error('INVALID_REQUEST');
  if (!safeToken(value.requestId, 200)) throw new Error('INVALID_REQUEST');
  if (Object.keys(value).some((key) => !['v', 'kind', 'requestId'].includes(key))) throw new Error('INVALID_REQUEST');
  return { v: 1, kind: 'query_binding', requestId: value.requestId };
}

function parseHealthRequest(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('INVALID_REQUEST');
  if (value.v !== APPEND_PROTOCOL_VERSION || value.kind !== 'health_check' || !safeToken(value.requestId, 200)) {
    throw new Error('INVALID_REQUEST');
  }
  const expectedRevisions = safeRevisions(value.expectedRevisions);
  if (!expectedRevisions) throw new Error('INVALID_REQUEST');
  if (value.conversationId !== undefined && !safeToken(value.conversationId, 200)) throw new Error('INVALID_REQUEST');
  return {
    v: APPEND_PROTOCOL_VERSION,
    kind: 'health_check',
    requestId: value.requestId,
    expectedRevisions,
    ...(value.conversationId === undefined ? {} : { conversationId: value.conversationId }),
  };
}

function secretsMatch(expected, received) {
  if (typeof received !== 'string') return false;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(received, 'utf8');
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

function revisionsMatch(expected, observed) {
  return (
    observed &&
    observed.helper === expected.helper &&
    observed.extension === expected.extension &&
    observed.pageAdapter === expected.pageAdapter
  );
}

function projectedHealthStatus(message, exact) {
  if (exact && message.status === 'ready') return 'ready';
  return message.status === 'dormant' ? 'dormant' : 'stale_adapter';
}

function projectedHealthError(message, exact) {
  if (exact) return undefined;
  return safeErrorCode(message.errorCode) ? message.errorCode : 'STALE_ADAPTER';
}

function parsePairedAppendEnvelope(expectedPairingSecret, rawEnvelope) {
  const rawRequest = rawEnvelope?.request;
  if (!secretsMatch(expectedPairingSecret, rawEnvelope?.pairingSecret)) {
    return { failure: failureFor(rawRequest, 'PAIRING_REJECTED') };
  }
  try {
    return { request: parseAppendRequest(rawRequest) };
  } catch {
    return { failure: failureFor(rawRequest, 'INVALID_REQUEST') };
  }
}

function sendSocketResult(socket, result) {
  if (!socket.destroyed) socket.end(`${JSON.stringify(result)}\n`);
}

function respondFromExistingAdmission({ socket, request, digest, existing, pending }) {
  if (existing && existing.textDigest !== digest) {
    sendSocketResult(socket, failureFor(request, 'IDEMPOTENCY_CONFLICT'));
    return true;
  }
  if (pending) {
    pending.responders.push({ socket, requestId: request.requestId, idempotentReplay: true });
    return true;
  }
  if (existing?.state === 'host_observed' || existing?.state === 'failed') {
    sendSocketResult(socket, terminalResult(existing, request.requestId, true));
    return true;
  }
  return false;
}

function validateBridgeOptions(options) {
  if (!options?.socketPath || !options?.ledgerPath || !options?.conversationBindingPath) {
    throw new Error('socketPath, ledgerPath, and conversationBindingPath are required');
  }
  if (typeof options.pairingSecret !== 'string' || options.pairingSecret.length < 32) {
    throw new Error('pairingSecret must contain at least 32 characters');
  }
  if (!/^sha512:[a-f0-9]{128}$/.test(options.helperArtifactRevision)) {
    throw new Error('helperArtifactRevision must be a lowercase sha512 digest');
  }
  if (typeof options.sendNative !== 'function') throw new Error('sendNative is required');
  if (options.writeLedger !== undefined && typeof options.writeLedger !== 'function') {
    throw new Error('writeLedger must be a function');
  }
  if (options.authorizeConversation !== undefined && typeof options.authorizeConversation !== 'function') {
    throw new Error('authorizeConversation must be a function');
  }
}

async function bindingFailureForAppend(path, request) {
  try {
    // Read-only authorization check — skip legacy migration to avoid acquiring
    // the mutation lease on a hot path. Concurrent append checks must not consume
    // the finite cross-process mutation retry budget or project a valid record
    // as BINDING_RECORD_INVALID under I/O pressure.
    const collection = await readPersonalChromeConversationAuthorizations(path, { migrateLegacy: false });
    return collection.conversations.some((entry) => entry.conversationId === request.conversationId)
      ? null
      : 'BOUND_CONVERSATION_MISMATCH';
  } catch (error) {
    return error instanceof PersonalChromeConversationAuthorizationError && error.code === 'NEEDS_AUTHORIZATION'
      ? 'NEEDS_BINDING'
      : 'BINDING_RECORD_INVALID';
  }
}

function bindingRecordForRequest(path, request, timestamp, authorizeConversation) {
  return authorizeConversation(path, {
    conversationId: request.conversationId,
    chatUrl: request.chatUrl,
    authorizedAt: timestamp,
    updatedAt: timestamp,
  });
}

function bindingWriteFailureCode(error) {
  return error instanceof PersonalChromeConversationAuthorizationError && error.code === 'AUTHORIZATION_BUSY'
    ? 'AUTHORIZATION_BUSY'
    : 'BINDING_WRITE_FAILED';
}

async function bindingStatusForQuery(path, requestId) {
  try {
    const collection = await readPersonalChromeConversationAuthorizations(path);
    const record = collection.conversations.at(-1);
    if (!record) {
      return {
        v: 1,
        kind: 'binding_status',
        requestId,
        status: 'unbound',
        errorCode: 'NEEDS_BINDING',
      };
    }
    return {
      v: 1,
      kind: 'binding_status',
      requestId,
      status: 'bound',
      conversationId: record.conversationId,
      boundAt: record.authorizedAt,
    };
  } catch (error) {
    const needsBinding =
      error instanceof PersonalChromeConversationAuthorizationError && error.code === 'NEEDS_AUTHORIZATION';
    return {
      v: 1,
      kind: 'binding_status',
      requestId,
      status: needsBinding ? 'unbound' : 'failed',
      errorCode: needsBinding ? 'NEEDS_BINDING' : 'BINDING_RECORD_INVALID',
    };
  }
}

export async function createNativeHostBridge(options) {
  validateBridgeOptions(options);
  const writeLedger = options.writeLedger ?? writeAtomicLedger;
  const authorizeConversation = options.authorizeConversation ?? authorizePersonalChromeConversation;
  const now = options.now ?? (() => new Date());

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
  const pendingHealthByRequestId = new Map();
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
      sendSocketResult(responder.socket, terminalResult(entry, responder.requestId, responder.idempotentReplay));
    }
  }

  function healthResult(requestId, status, errorCode, observedRevisions) {
    return {
      v: APPEND_PROTOCOL_VERSION,
      kind: 'health_result',
      requestId,
      status,
      ...(errorCode ? { errorCode } : {}),
      ...(observedRevisions ? { observedRevisions } : {}),
    };
  }

  async function handleHealthEnvelope(socket, rawEnvelope) {
    if (rawEnvelope?.request?.kind !== 'health_check') return false;
    if (!secretsMatch(options.pairingSecret, rawEnvelope?.pairingSecret)) {
      sendSocketResult(socket, healthResult('invalid-request', 'failed', 'PAIRING_REJECTED'));
      return true;
    }
    let request;
    try {
      request = parseHealthRequest(rawEnvelope.request);
    } catch {
      sendSocketResult(socket, healthResult('invalid-request', 'failed', 'INVALID_REQUEST'));
      return true;
    }
    if (request.expectedRevisions.helper !== options.helperArtifactRevision) {
      sendSocketResult(
        socket,
        healthResult(request.requestId, 'stale_adapter', 'STALE_HELPER', {
          helper: options.helperArtifactRevision,
          extension: '0.0.0',
          pageAdapter: 'unobserved',
        }),
      );
      return true;
    }
    const timeout = setTimeout(() => {
      if (!pendingHealthByRequestId.has(request.requestId)) return;
      pendingHealthByRequestId.delete(request.requestId);
      sendSocketResult(socket, healthResult(request.requestId, 'failed', 'HEALTH_TIMEOUT'));
    }, 1_000);
    timeout.unref?.();
    pendingHealthByRequestId.set(request.requestId, {
      socket,
      timeout,
      expectedRevisions: request.expectedRevisions,
    });
    try {
      await options.sendNative(request);
    } catch {
      clearTimeout(timeout);
      pendingHealthByRequestId.delete(request.requestId);
      sendSocketResult(socket, healthResult(request.requestId, 'failed', 'NATIVE_DISPATCH_FAILED'));
    }
    return true;
  }

  async function handleEnvelope(socket, rawEnvelope) {
    if (await handleHealthEnvelope(socket, rawEnvelope)) return;
    const parsed = parsePairedAppendEnvelope(options.pairingSecret, rawEnvelope);
    if (parsed.failure) {
      sendSocketResult(socket, parsed.failure);
      return;
    }
    const request = parsed.request;
    if (request.expectedRevisions.helper !== options.helperArtifactRevision) {
      sendSocketResult(
        socket,
        failureFor(request, 'STALE_HELPER', {
          observedRevisions: {
            helper: options.helperArtifactRevision,
            extension: '0.0.0',
            pageAdapter: 'unobserved',
          },
        }),
      );
      return;
    }
    const bindingFailure = await bindingFailureForAppend(options.conversationBindingPath, request);
    if (bindingFailure) {
      sendSocketResult(socket, failureFor(request, bindingFailure));
      return;
    }
    const key = ledgerKey(request.conversationId, request.idempotencyKey);
    const digest = textDigest(request.text);
    const existing = ledger.get(key);
    const pending = pendingByKey.get(key);
    if (respondFromExistingAdmission({ socket, request, digest, existing, pending })) return;
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
      expectedRevisions: request.expectedRevisions,
      responders: [{ socket, requestId: request.requestId, idempotentReplay: false }],
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
    if (message?.v !== APPEND_PROTOCOL_VERSION || message?.kind !== 'append_result') return;
    const key = keyByRequestId.get(message.requestId);
    if (!key) return;
    const entry = ledger.get(key);
    const pending = pendingByKey.get(key);
    if (!entry || !pending || message.idempotencyKey !== entry.idempotencyKey) {
      await settle(key, failureFor(message, 'INVALID_HOST_RECEIPT'));
      return;
    }
    const observedRevisions = safeRevisions(message.observedRevisions);
    if (!revisionsMatch(pending.expectedRevisions, observedRevisions)) {
      await settle(
        key,
        failureFor(message, 'STALE_ADAPTER', {
          observedRevisions: observedRevisions ?? {
            helper: options.helperArtifactRevision,
            extension: '0.0.0',
            pageAdapter: 'unobserved',
          },
        }),
      );
      return;
    }
    if (message.status === 'host_observed') {
      await settle(key, message);
      return;
    }
    const errorCode = safeErrorCode(message.errorCode) ? message.errorCode : 'NATIVE_DELIVERY_FAILED';
    await settle(
      key,
      failureFor(message, errorCode, {
        observedRevisions,
        diagnostic: message.diagnostic,
      }),
    );
  }

  function acceptHealthResult(message) {
    const pending = pendingHealthByRequestId.get(message?.requestId);
    if (!pending) return message?.kind === 'health_result';
    clearTimeout(pending.timeout);
    pendingHealthByRequestId.delete(message.requestId);
    if (message?.v !== APPEND_PROTOCOL_VERSION || message?.kind !== 'health_result') {
      sendSocketResult(
        pending.socket,
        healthResult(message.requestId, 'stale_adapter', 'STALE_EXTENSION_PROTOCOL', {
          helper: pending.expectedRevisions.helper,
          extension: '0.0.0',
          pageAdapter: 'unobserved',
        }),
      );
      return true;
    }
    const observedRevisions = safeRevisions(message.observedRevisions);
    const exact = revisionsMatch(pending.expectedRevisions, observedRevisions);
    const errorCode = projectedHealthError(message, exact);
    sendSocketResult(pending.socket, {
      v: APPEND_PROTOCOL_VERSION,
      kind: 'health_result',
      requestId: message.requestId,
      status: projectedHealthStatus(message, exact),
      ...(errorCode ? { errorCode } : {}),
      ...(observedRevisions ? { observedRevisions } : {}),
    });
    return true;
  }

  async function acceptBindingRequest(message) {
    if (message?.kind !== 'bind_conversation') return false;
    let request;
    try {
      request = parseBindingRequest(message);
    } catch {
      await options.sendNative({
        v: 1,
        kind: 'binding_result',
        requestId: safeToken(message?.requestId, 200) ? message.requestId : 'invalid-request',
        status: 'failed',
        errorCode: 'INVALID_BINDING_REQUEST',
      });
      return true;
    }
    const timestamp = now().toISOString();
    let record;
    try {
      record = await bindingRecordForRequest(
        options.conversationBindingPath,
        request,
        timestamp,
        authorizeConversation,
      );
    } catch (error) {
      await options.sendNative({
        v: 1,
        kind: 'binding_result',
        requestId: request.requestId,
        status: 'failed',
        errorCode: bindingWriteFailureCode(error),
      });
      return true;
    }
    await options.sendNative({
      v: 1,
      kind: 'binding_result',
      requestId: request.requestId,
      status: 'bound',
      conversationId: record.authorization.conversationId,
      boundAt: record.authorization.authorizedAt,
    });
    return true;
  }

  async function acceptBindingQuery(message) {
    if (message?.kind !== 'query_binding') return false;
    let request;
    try {
      request = parseBindingQuery(message);
    } catch {
      await options.sendNative({
        v: 1,
        kind: 'binding_status',
        requestId: safeToken(message?.requestId, 200) ? message.requestId : 'invalid-request',
        status: 'failed',
        errorCode: 'INVALID_BINDING_QUERY',
      });
      return true;
    }
    await options.sendNative(await bindingStatusForQuery(options.conversationBindingPath, request.requestId));
    return true;
  }

  return {
    socketPath: options.socketPath,
    ledgerPath: options.ledgerPath,
    async acceptNativeMessage(message) {
      if (acceptHealthResult(message)) return;
      if (await acceptBindingRequest(message)) return;
      if (await acceptBindingQuery(message)) return;
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
            sendSocketResult(responder.socket, {
              ...failureFor({ requestId: responder.requestId, idempotencyKey: entry?.idempotencyKey }, 'HOST_STOPPED'),
              idempotentReplay: responder.idempotentReplay,
            });
          }
        }
        for (const socket of openSockets) socket.destroy();
        for (const pending of pendingHealthByRequestId.values()) clearTimeout(pending.timeout);
        pendingHealthByRequestId.clear();
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
      conversationBindingPath: resolve(dirname(record.ledgerPath), 'conversation-binding.json'),
      pairingSecret: record.pairingSecret,
      helperArtifactRevision: record.artifactDigest,
    };
  }
  const socketPath = env.CAT_CAFE_PERSONAL_CHROME_SOCKET;
  const ledgerPath = env.CAT_CAFE_PERSONAL_CHROME_LEDGER;
  const pairingSecret = env.CAT_CAFE_PERSONAL_CHROME_PAIRING_SECRET;
  const helperArtifactRevision = env.CAT_CAFE_PERSONAL_CHROME_HELPER_ARTIFACT_REVISION;
  if (!socketPath || !ledgerPath || !pairingSecret || !helperArtifactRevision) {
    throw new Error('required personal Chrome host configuration is missing');
  }
  return {
    socketPath,
    ledgerPath,
    conversationBindingPath: resolve(dirname(ledgerPath), 'conversation-binding.json'),
    pairingSecret,
    helperArtifactRevision,
  };
}

export async function runNativeHost(options = {}) {
  const { socketPath, ledgerPath, conversationBindingPath, pairingSecret, helperArtifactRevision } =
    await resolveNativeHostConfiguration(options);
  const decoder = new NativeMessageDecoder();
  const bridge = await createNativeHostBridge({
    socketPath,
    ledgerPath,
    conversationBindingPath,
    pairingSecret,
    helperArtifactRevision,
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
      for (const message of decoder.push(chunk)) void bridge.acceptNativeMessage(message).catch(stopAfterInputFailure);
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
