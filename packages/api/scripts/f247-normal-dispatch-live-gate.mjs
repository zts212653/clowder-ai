#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { isCloudBridgeOutboundReceiptV1 } from '@cat-cafe/shared';

export class NormalDispatchLiveGateError extends Error {
  constructor(code, message, diagnostic) {
    super(message);
    this.name = 'NormalDispatchLiveGateError';
    this.code = code;
    if (diagnostic !== undefined) this.diagnostic = diagnostic;
  }
}

function receiptFromMessage(message, sourceMessageId) {
  if (message?.replyTo !== sourceMessageId || message?.source?.connector !== 'cloud-bridge-status') return undefined;
  const receipt = message.source?.meta?.cloudBridgeOutboundReceipt;
  return isCloudBridgeOutboundReceiptV1(receipt) && receipt.sourceMessageId === sourceMessageId ? receipt : undefined;
}

function requireObservedDelivery(receipt) {
  if (receipt.status === 'sent' && receipt.transport === 'host' && receipt.hostMessageId) return;
  throw new NormalDispatchLiveGateError(
    'DELIVERY_NOT_OBSERVED',
    'normal dispatch did not produce a host-observed receipt',
    receipt.failure,
  );
}

function observeGateState(messages, sourceMessageId) {
  if (!Array.isArray(messages)) {
    throw new NormalDispatchLiveGateError('INVALID_MESSAGE_SNAPSHOT', 'message reader returned an invalid snapshot');
  }
  if (!messages.some((message) => message?.id === sourceMessageId)) {
    throw new NormalDispatchLiveGateError('SOURCE_NOT_FOUND', 'the exact normal-dispatch source message is absent');
  }
  const receipt = messages.map((message) => receiptFromMessage(message, sourceMessageId)).find(Boolean);
  if (!receipt) return {};
  requireObservedDelivery(receipt);
  const remoteReturn = messages.find(
    (message) =>
      message?.catId === receipt.targetCatId && message?.replyTo === sourceMessageId && message?.id !== sourceMessageId,
  );
  return { receipt, remoteReturn };
}

export async function runPersonalChromeNormalDispatchLiveGate({
  sourceMessageId,
  readMessages,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = 120_000,
  pollMs = 500,
}) {
  if (typeof sourceMessageId !== 'string' || sourceMessageId.length === 0 || sourceMessageId.length > 512) {
    throw new NormalDispatchLiveGateError('INVALID_SOURCE_MESSAGE_ID', 'sourceMessageId must be an exact message ref');
  }
  if (typeof readMessages !== 'function') {
    throw new NormalDispatchLiveGateError('INVALID_READER', 'readMessages is required');
  }
  const deadline = Date.now() + timeoutMs;
  let observedReceipt;
  do {
    const observation = observeGateState(await readMessages(), sourceMessageId);
    observedReceipt = observation.receipt;
    if (observedReceipt && observation.remoteReturn) {
      return {
        status: 'PASS',
        sourceMessageId,
        targetCatId: observedReceipt.targetCatId,
        hostMessageId: observedReceipt.hostMessageId,
        returnMessageId: observation.remoteReturn.id,
      };
    }
    if (Date.now() >= deadline) break;
    await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);

  throw new NormalDispatchLiveGateError(
    observedReceipt ? 'RETURN_NOT_OBSERVED' : 'RECEIPT_NOT_OBSERVED',
    observedReceipt
      ? 'host delivery was observed, but the exact source-bound cloud return was not'
      : 'normal dispatch did not publish a typed outbound receipt before the deadline',
  );
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function runFromCli() {
  const sourceMessageId = argument('--source-message-id');
  const threadId = argument('--thread-id');
  const apiUrl = argument('--api-url') ?? process.env.CAT_CAFE_API_URL ?? 'http://localhost:3004';
  const userId = argument('--user-id') ?? process.env.CAT_CAFE_USER_ID;
  if (!threadId) throw new NormalDispatchLiveGateError('THREAD_REQUIRED', '--thread-id is required');
  return runPersonalChromeNormalDispatchLiveGate({
    sourceMessageId,
    async readMessages() {
      const url = new URL('/api/messages', apiUrl);
      url.searchParams.set('threadId', threadId);
      url.searchParams.set('limit', '200');
      const response = await fetch(url, { headers: userId ? { 'x-user-id': userId } : {} });
      if (!response.ok) throw new Error(`message snapshot failed with HTTP ${response.status}`);
      return (await response.json()).messages;
    },
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runFromCli()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      const typed = error instanceof NormalDispatchLiveGateError;
      process.stdout.write(
        `${JSON.stringify(
          {
            status: 'NOT_OBSERVED',
            code: typed ? error.code : 'LIVE_GATE_FAILED',
            detail: error instanceof Error ? error.message : 'unknown',
            ...(typed && error.diagnostic ? { diagnostic: error.diagnostic } : {}),
          },
          null,
          2,
        )}\n`,
      );
      process.exitCode = 2;
    });
}
