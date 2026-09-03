import { createHash } from 'node:crypto';

import { ledgerKey } from './native-ledger.mjs';
import { safeRevisions, safeToken } from './native-results.mjs';

const PROTOCOL_VERSION = 2;
const MAX_CONTENT_BYTES = 128 * 1024;
const MAX_LOCAL_FRAME_BYTES = 256 * 1024;
const MAX_REQUEST_ID_LENGTH = 200;
const ASSISTANT_OBSERVATION_DIAGNOSTIC_FIELDS = [
  'v',
  'userTurnConnected',
  'anchorTurnFound',
  'followingTurnCount',
  'assistantCandidateCount',
  'laterUserTurnPresent',
  'assistantHostIdStatus',
  'assistantContentStatus',
  'streamingControlPresent',
];

function exactRevisions(expected, observed) {
  return (
    expected &&
    observed &&
    expected.helper === observed.helper &&
    expected.extension === observed.extension &&
    expected.pageAdapter === observed.pageAdapter
  );
}

function safeContent(value) {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_CONTENT_BYTES;
}

function failure(requestId, errorCode) {
  return {
    v: PROTOCOL_VERSION,
    kind: 'assistant_return_error',
    requestId: safeToken(requestId, 200) ? requestId : 'invalid-request',
    errorCode,
  };
}

function pendingReturn(entry) {
  const value = entry.assistantReturn;
  if (!value || value.state !== 'pending' || !safeToken(value.assistantMessageId, 512) || !safeContent(value.content)) {
    return null;
  }
  return {
    conversationId: entry.conversationId,
    sourceMessageId: entry.idempotencyKey,
    assistantMessageId: value.assistantMessageId,
    content: value.content,
  };
}

function assistantReturnsResult(requestId, value) {
  return {
    v: PROTOCOL_VERSION,
    kind: 'assistant_returns',
    requestId,
    returns: value ? [value] : [],
  };
}

function fitsAssistantReturnsFrame(value, requestId = 'x'.repeat(MAX_REQUEST_ID_LENGTH)) {
  const serialized = `${JSON.stringify(assistantReturnsResult(requestId, value))}\n`;
  return Buffer.byteLength(serialized, 'utf8') <= MAX_LOCAL_FRAME_BYTES;
}

function hasOnlyFields(value, allowed) {
  return Object.keys(value).every((field) => allowed.includes(field));
}

function validObservedRevisions(message) {
  const observedRevisions = safeRevisions(message?.observedRevisions);
  const tokens = [
    [message?.requestId, 200],
    [message?.conversationId, 200],
    [message?.idempotencyKey, 512],
    [message?.hostMessageId, 512],
    [message?.assistantMessageId, 512],
  ];
  if (message?.v !== PROTOCOL_VERSION || !tokens.every(([value, maximum]) => safeToken(value, maximum))) return null;
  return safeContent(message.content) ? observedRevisions : null;
}

function validAssistantObservationDiagnostic(value) {
  return (
    value?.v === 1 &&
    hasOnlyFields(value, ASSISTANT_OBSERVATION_DIAGNOSTIC_FIELDS) &&
    Object.keys(value).length === ASSISTANT_OBSERVATION_DIAGNOSTIC_FIELDS.length &&
    ['userTurnConnected', 'anchorTurnFound', 'laterUserTurnPresent', 'streamingControlPresent'].every(
      (field) => typeof value[field] === 'boolean',
    ) &&
    ['followingTurnCount', 'assistantCandidateCount'].every(
      (field) => Number.isInteger(value[field]) && value[field] >= 0 && value[field] <= 1_000,
    ) &&
    ['not_observed', 'unique', 'missing_or_ambiguous'].includes(value.assistantHostIdStatus) &&
    ['not_observed', 'missing', 'present', 'oversized'].includes(value.assistantContentStatus)
  );
}

function validObservationFailure(message) {
  const observedRevisions = safeRevisions(message?.observedRevisions);
  const tokens = [
    [message?.requestId, 200],
    [message?.conversationId, 200],
    [message?.idempotencyKey, 512],
    [message?.hostMessageId, 512],
    [message?.errorCode, 80],
  ];
  if (message?.v !== PROTOCOL_VERSION || !tokens.every(([value, maximum]) => safeToken(value, maximum))) return null;
  return validAssistantObservationDiagnostic(message.diagnostic) ? observedRevisions : null;
}

function existingMatches(existing, message, digest) {
  return (
    existing.assistantMessageId === message.assistantMessageId &&
    existing.contentDigest === digest &&
    existing.content === message.content
  );
}

function existingFailureMatches(existing, message) {
  return (
    existing.errorCode === message.errorCode &&
    ASSISTANT_OBSERVATION_DIAGNOSTIC_FIELDS.every((field) => existing.diagnostic?.[field] === message.diagnostic[field])
  );
}

function matchingEntry(ledger, message, observedRevisions) {
  const entry = ledger.get(ledgerKey(message.conversationId, message.idempotencyKey));
  if (!entry || entry.submitted !== true) return null;
  if (!exactRevisions(entry.expectedRevisions, observedRevisions)) return null;
  return entry.hostMessageId === message.hostMessageId ? entry : null;
}

function assistantReturnIsAcked(entry) {
  return Object.hasOwn(entry, 'assistantReturnAckedAt');
}

async function persistPending(entry, pending, persist) {
  entry.assistantReturn = pending;
  try {
    await persist();
  } catch (error) {
    if (entry.assistantReturn === pending) delete entry.assistantReturn;
    throw error;
  }
}

export function createAssistantReturnInbox({ ledger, persist, now = () => new Date() }) {
  if (!(ledger instanceof Map) || typeof persist !== 'function') throw new Error('ledger and persist are required');

  async function acceptObserved(message) {
    if (message?.kind !== 'assistant_final_observed') return false;
    const observedRevisions = validObservedRevisions(message);
    if (!observedRevisions) return 'rejected';
    const entry = matchingEntry(ledger, message, observedRevisions);
    if (!entry) return 'rejected';
    if (entry.assistantObservationFailure || assistantReturnIsAcked(entry)) return 'rejected';
    const digest = createHash('sha256').update(message.content).digest('hex');
    const existing = entry.assistantReturn;
    if (existing) return existingMatches(existing, message, digest) ? 'accepted' : 'rejected';
    const pending = {
      state: 'pending',
      assistantMessageId: message.assistantMessageId,
      content: message.content,
      contentDigest: digest,
      observedAt: now().toISOString(),
    };
    const returnValue = pendingReturn({ ...entry, assistantReturn: pending });
    if (!returnValue || !fitsAssistantReturnsFrame(returnValue)) return 'rejected';
    await persistPending(entry, pending, persist);
    return 'accepted';
  }

  async function acceptObservationFailure(message) {
    if (message?.kind !== 'assistant_observation_failed') return false;
    const observedRevisions = validObservationFailure(message);
    if (!observedRevisions) return 'rejected';
    const entry = matchingEntry(ledger, message, observedRevisions);
    if (!entry) return 'rejected';
    if (entry.assistantReturn || assistantReturnIsAcked(entry)) return 'rejected';
    const existing = entry.assistantObservationFailure;
    const failure = {
      state: 'failed',
      errorCode: message.errorCode,
      diagnostic: { ...message.diagnostic },
      observedAt: now().toISOString(),
    };
    if (existing) return existingFailureMatches(existing, message) ? 'accepted' : 'rejected';
    entry.assistantObservationFailure = failure;
    try {
      await persist();
    } catch (error) {
      if (entry.assistantObservationFailure === failure) delete entry.assistantObservationFailure;
      throw error;
    }
    return 'accepted';
  }

  function listPending(request) {
    if (
      !hasOnlyFields(request, [
        'v',
        'kind',
        'requestId',
        'afterConversationId',
        'afterSourceMessageId',
        'afterAssistantMessageId',
      ])
    ) {
      return failure(request.requestId, 'INVALID_REQUEST');
    }
    const hasAfterConversation = Object.hasOwn(request, 'afterConversationId');
    const hasAfterSource = Object.hasOwn(request, 'afterSourceMessageId');
    const hasAfterAssistant = Object.hasOwn(request, 'afterAssistantMessageId');
    if (
      hasAfterConversation !== hasAfterSource ||
      hasAfterSource !== hasAfterAssistant ||
      (hasAfterConversation &&
        (!safeToken(request.afterConversationId, 200) ||
          !safeToken(request.afterSourceMessageId, 512) ||
          !safeToken(request.afterAssistantMessageId, 512)))
    ) {
      return failure(request.requestId, 'INVALID_REQUEST');
    }
    const candidates = [...ledger.values()]
      .map(pendingReturn)
      .filter((candidate) => candidate && fitsAssistantReturnsFrame(candidate, request.requestId));
    const cursorIndex = hasAfterConversation
      ? candidates.findIndex(
          (candidate) =>
            candidate.conversationId === request.afterConversationId &&
            candidate.sourceMessageId === request.afterSourceMessageId &&
            candidate.assistantMessageId === request.afterAssistantMessageId,
        )
      : -1;
    const value = candidates[cursorIndex >= 0 ? cursorIndex + 1 : 0];
    return assistantReturnsResult(request.requestId, value);
  }

  async function acknowledgePending(request) {
    if (
      !hasOnlyFields(request, ['v', 'kind', 'requestId', 'conversationId', 'sourceMessageId', 'assistantMessageId']) ||
      !safeToken(request.conversationId, 200) ||
      !safeToken(request.sourceMessageId, 512) ||
      !safeToken(request.assistantMessageId, 512)
    ) {
      return failure(request.requestId, 'INVALID_REQUEST');
    }
    const matches = [...ledger.values()].filter(
      (entry) =>
        entry.conversationId === request.conversationId &&
        entry.idempotencyKey === request.sourceMessageId &&
        entry.assistantReturn?.state === 'pending' &&
        entry.assistantReturn.assistantMessageId === request.assistantMessageId,
    );
    if (matches.length !== 1) return failure(request.requestId, 'ASSISTANT_RETURN_NOT_FOUND');
    const entry = matches[0];
    const pending = entry.assistantReturn;
    const previousAckedAt = entry.assistantReturnAckedAt;
    delete entry.assistantReturn;
    entry.assistantReturnAckedAt = now().toISOString();
    try {
      await persist();
    } catch (error) {
      entry.assistantReturn = pending;
      if (previousAckedAt === undefined) delete entry.assistantReturnAckedAt;
      else entry.assistantReturnAckedAt = previousAckedAt;
      throw error;
    }
    return {
      v: PROTOCOL_VERSION,
      kind: 'assistant_return_ack',
      requestId: request.requestId,
      status: 'acknowledged',
    };
  }

  async function handleLocalRequest(request) {
    if (request?.v !== PROTOCOL_VERSION || !safeToken(request.requestId, 200)) {
      return failure(request?.requestId, 'INVALID_REQUEST');
    }
    if (request.kind === 'list_assistant_returns') return listPending(request);
    if (request.kind === 'ack_assistant_return') return acknowledgePending(request);
    return failure(request.requestId, 'INVALID_REQUEST');
  }

  return { acceptObserved, acceptObservationFailure, handleLocalRequest };
}
