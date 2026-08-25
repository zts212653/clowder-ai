import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

export class LiveGateNotObservedError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'LiveGateNotObservedError';
    this.reason = reason;
  }
}

export function buildNotObservedLiveGateResult(error, context = {}) {
  if (!(error instanceof LiveGateNotObservedError)) return null;
  return {
    status: 'NOT_OBSERVED',
    reason: error.reason,
    detail: error.message,
    helperStarted: context.helperStarted === true,
    extensionId: context.extensionId,
    cleanup: 'complete',
  };
}

export function extensionIdFromWorkerUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'chrome-extension:' || !/^[a-p]{32}$/.test(url.hostname)) return null;
    return url.hostname;
  } catch {
    return null;
  }
}

export function extensionIdFromManifestKey(value) {
  if (
    typeof value !== 'string' ||
    value.length < 80 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error('extension manifest key must be canonical base64 DER');
  }
  const publicKey = Buffer.from(value, 'base64');
  if (publicKey.length < 64 || publicKey.toString('base64') !== value) {
    throw new Error('extension manifest key must be canonical base64 DER');
  }
  const prefix = createHash('sha256').update(publicKey).digest('hex').slice(0, 32);
  return [...prefix].map((character) => String.fromCharCode(97 + Number.parseInt(character, 16))).join('');
}

export function conversationIdFromChatGptUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com') return null;
    return url.pathname.match(/^\/c\/([A-Za-z0-9-]+)\/?$/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function isolatedLiveGateProjectRoot(userDataDir) {
  if (typeof userDataDir !== 'string' || !userDataDir || userDataDir.trim() !== userDataDir) {
    throw new Error('live gate userDataDir must be a non-empty exact path');
  }
  return join(resolve(userDataDir), 'cat-cafe-host-root');
}

export async function verifyBoundDelivery({ adapter, conversationId, text, idempotencyKey }) {
  const first = await adapter.append_message(conversationId, text, idempotencyKey);
  const retry = await adapter.append_message(conversationId, text, idempotencyKey);
  if (!first?.hostMessageId || retry?.hostMessageId !== first.hostMessageId) {
    throw new Error('retry receipt did not match the first DOM-observed host message ID');
  }
  return {
    hostMessageId: first.hostMessageId,
    retryHostMessageId: retry.hostMessageId,
  };
}

export async function verifyLiveDelivery({ adapter, conversationId, text, idempotencyKey, readActiveTabId }) {
  const activeTabBefore = await readActiveTabId();
  if (
    !Number.isInteger(activeTabBefore) &&
    !(typeof activeTabBefore === 'string' && activeTabBefore.length > 0 && activeTabBefore.length <= 200)
  ) {
    throw new Error('active tab was not observable before delivery');
  }
  const first = await adapter.append_message(conversationId, text, idempotencyKey);
  const activeTabBeforeRetry = await readActiveTabId();
  if (activeTabBeforeRetry !== activeTabBefore) {
    throw new Error('active tab changed before background delivery retry');
  }
  const retry = await adapter.append_message(conversationId, text, idempotencyKey);
  if (!first?.hostMessageId || retry?.hostMessageId !== first.hostMessageId) {
    throw new Error('retry receipt did not match the first DOM-observed host message ID');
  }
  const activeTabAfter = await readActiveTabId();
  if (activeTabAfter !== activeTabBefore) throw new Error('active tab changed during background delivery');
  return {
    hostMessageId: first.hostMessageId,
    retryHostMessageId: retry.hostMessageId,
    activeTabBefore,
    activeTabAfter,
    activeTabPreserved: true,
  };
}
