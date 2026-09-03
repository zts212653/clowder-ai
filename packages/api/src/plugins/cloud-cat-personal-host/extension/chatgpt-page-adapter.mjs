import {
  composerSnapshot,
  composerTextResult,
  insertComposerText,
  restoreAfterNoSend,
} from './chatgpt-composer-transaction.mjs';
import {
  ChatGptPageAdapterError,
  composerDomFingerprint,
  contentEditableText,
  conversationIdFromLocation,
  firstMatch,
  requireContentString,
  requireExactString,
  requireTimeout,
  SAFE_CONVERSATION_ID,
} from './chatgpt-page-contract.mjs';

const COMPOSER_SELECTORS = [
  '#prompt-textarea[contenteditable="true"]',
  'div[contenteditable="true"][data-virtualkeyboard="true"]',
  'textarea[data-id="root"]',
];
const SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="发送提示"]',
];
const USER_MESSAGE_SELECTOR = '[data-message-author-role="user"]';
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"]';
const MESSAGE_TURN_SELECTOR = 'article[data-testid^="conversation-turn-"], article';
const RENDERED_MESSAGE_CONTENT_SELECTOR = '.whitespace-pre-wrap';
const STOP_BUTTON_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="停止生成"]',
];
const SAFE_TURN_ID = /^conversation-turn-[A-Za-z0-9._:-]+$/;
const MAX_ASSISTANT_CONTENT_BYTES = 128 * 1024;

function enclosingTurn(message) {
  return message.closest(MESSAGE_TURN_SELECTOR);
}

function hostMessageIdFor(message) {
  const owner = message.closest('[data-message-id]');
  const ownerId = owner?.getAttribute('data-message-id')?.trim();
  if (ownerId) return ownerId;

  const turn = enclosingTurn(message);
  if (!turn) return null;
  const candidates = [...turn.querySelectorAll('[data-message-id]')]
    .map((candidate) => candidate.getAttribute('data-message-id')?.trim())
    .filter(Boolean);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return null;

  const turnId = turn.getAttribute('data-testid')?.trim();
  if (!turnId || !SAFE_TURN_ID.test(turnId)) return null;
  const matchingTurns = [...message.ownerDocument.querySelectorAll(MESSAGE_TURN_SELECTOR)].filter(
    (candidate) => candidate.getAttribute('data-testid')?.trim() === turnId,
  );
  return matchingTurns.length === 1 ? turnId : null;
}

function renderedNodeHasExactText(node, expectedText) {
  const normalized = contentEditableText(node);
  const projections = normalized === null ? [node.innerText, node.textContent] : [normalized];
  return projections.some((value) => typeof value === 'string' && value === expectedText);
}

function renderedMessageHasExactText(message, expectedText) {
  const renderedContent = [...message.querySelectorAll(RENDERED_MESSAGE_CONTENT_SELECTOR)];
  if (renderedContent.length === 0) return renderedNodeHasExactText(message, expectedText);
  return renderedContent.length === 1 && renderedNodeHasExactText(renderedContent[0], expectedText);
}

export { ChatGptPageAdapterError };

function sendButtonIsDisabled(button) {
  return button.disabled === true || button.getAttribute('aria-disabled') === 'true';
}

function waitForSendButton({ document, MutationObserver, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let sawDisabledButton = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observer.disconnect();
      callback();
    };
    const scan = () => {
      const button = firstMatch(document, SEND_BUTTON_SELECTORS);
      if (!button) return;
      if (typeof button.click !== 'function' || !button.isConnected) {
        finish(() =>
          reject(new ChatGptPageAdapterError('SEND_BUTTON_INVALID', 'ChatGPT send button is not safely clickable')),
        );
        return;
      }
      if (sendButtonIsDisabled(button)) {
        sawDisabledButton = true;
        return;
      }
      finish(() => resolve(button));
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-disabled'],
    });
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new ChatGptPageAdapterError(
            sawDisabledButton ? 'SEND_BUTTON_DISABLED' : 'SEND_BUTTON_NOT_FOUND',
            sawDisabledButton ? 'ChatGPT send button remained disabled' : 'ChatGPT send button was not found',
          ),
        ),
      );
    }, timeoutMs);
    scan();
  });
}

function observeHostMessage({ document, MutationObserver, existingIds, text, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observer.disconnect();
      callback();
    };
    const scan = () => {
      for (const message of document.querySelectorAll(USER_MESSAGE_SELECTOR)) {
        const messageId = hostMessageIdFor(message);
        if (!messageId || existingIds.has(messageId)) continue;
        if (!renderedMessageHasExactText(message, text)) continue;
        finish(() => resolve({ hostMessageId: messageId, turn: enclosingTurn(message) }));
        return;
      }
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new ChatGptPageAdapterError(
            'HOST_MESSAGE_NOT_OBSERVED',
            'ChatGPT did not expose a new user message with one unique Host-provided turn identifier',
          ),
        ),
      );
    }, timeoutMs);
    scan();
  });
}

function messageRoleElements(turn) {
  const elements = [];
  if (turn.matches?.('[data-message-author-role]')) elements.push(turn);
  elements.push(...turn.querySelectorAll('[data-message-author-role]'));
  return elements;
}

function boundedAssistantText(message) {
  const raw = typeof message.innerText === 'string' ? message.innerText : message.textContent;
  const content = typeof raw === 'string' ? raw.trim() : '';
  if (!content || new TextEncoder().encode(content).byteLength > MAX_ASSISTANT_CONTENT_BYTES) return null;
  return content;
}

function assistantContentStatus(message) {
  const raw = typeof message?.innerText === 'string' ? message.innerText : message?.textContent;
  const content = typeof raw === 'string' ? raw.trim() : '';
  if (!content) return 'missing';
  return new TextEncoder().encode(content).byteLength > MAX_ASSISTANT_CONTENT_BYTES ? 'oversized' : 'present';
}

function assistantIsStreaming(document) {
  return firstMatch(document, STOP_BUTTON_SELECTORS) !== null;
}

function causalAssistantCandidate(turn) {
  const roles = messageRoleElements(turn);
  if (roles.some((candidate) => candidate.matches(USER_MESSAGE_SELECTOR))) {
    return {
      error: new ChatGptPageAdapterError(
        'ASSISTANT_TURN_SUPERSEDED',
        'a later user turn appeared before the source-bound assistant final',
      ),
    };
  }
  const assistants = roles.filter((candidate) => candidate.matches(ASSISTANT_MESSAGE_SELECTOR));
  if (assistants.length === 0) return null;
  if (assistants.length !== 1) {
    return {
      error: new ChatGptPageAdapterError(
        'AMBIGUOUS_ASSISTANT_TURN',
        'the causal ChatGPT turn exposed multiple assistant message candidates',
      ),
    };
  }
  return { message: assistants[0] };
}

function sourceTurnForHostMessage(document, hostMessageId) {
  const matchingTurns = [
    ...new Set(
      [...document.querySelectorAll(USER_MESSAGE_SELECTOR)]
        .filter((message) => hostMessageIdFor(message) === hostMessageId)
        .map(enclosingTurn)
        .filter(Boolean),
    ),
  ];
  return matchingTurns.length === 1 ? matchingTurns[0] : null;
}

function findCausalAssistantCandidate(document, hostMessageId) {
  const userTurn = sourceTurnForHostMessage(document, hostMessageId);
  if (!userTurn) return null;
  const turns = [...document.querySelectorAll(MESSAGE_TURN_SELECTOR)];
  const anchorIndex = turns.indexOf(userTurn);
  if (anchorIndex === -1) return null;
  for (const turn of turns.slice(anchorIndex + 1)) {
    const candidate = causalAssistantCandidate(turn);
    if (candidate) return { turn, ...candidate };
  }
  return null;
}

function assistantObservationDiagnostic(document, userTurn, hostMessageId) {
  const turns = [...document.querySelectorAll(MESSAGE_TURN_SELECTOR)];
  const currentUserTurn = sourceTurnForHostMessage(document, hostMessageId);
  const anchorIndex = turns.indexOf(currentUserTurn);
  const followingTurns = anchorIndex === -1 ? [] : turns.slice(anchorIndex + 1);
  const followingRoles = followingTurns.flatMap(messageRoleElements);
  const assistantCandidates = followingRoles.filter((candidate) => candidate.matches(ASSISTANT_MESSAGE_SELECTOR));
  const contentStatuses = assistantCandidates.map(assistantContentStatus);
  const assistantHostIdStatus =
    assistantCandidates.length === 0
      ? 'not_observed'
      : assistantCandidates.length === 1 && hostMessageIdFor(assistantCandidates[0])
        ? 'unique'
        : 'missing_or_ambiguous';
  const assistantContentStatusValue = contentStatuses.includes('oversized')
    ? 'oversized'
    : contentStatuses.includes('present')
      ? 'present'
      : contentStatuses.includes('missing')
        ? 'missing'
        : 'not_observed';
  return {
    v: 1,
    userTurnConnected: userTurn?.isConnected === true,
    anchorTurnFound: anchorIndex !== -1,
    followingTurnCount: Math.min(followingTurns.length, 1_000),
    assistantCandidateCount: Math.min(assistantCandidates.length, 1_000),
    laterUserTurnPresent: followingRoles.some((candidate) => candidate.matches(USER_MESSAGE_SELECTOR)),
    assistantHostIdStatus,
    assistantContentStatus: assistantContentStatusValue,
    streamingControlPresent: assistantIsStreaming(document),
  };
}

function observeCausalAssistantFinal({
  document,
  MutationObserver,
  timeoutMs,
  quietMs,
  requestId,
  conversationId,
  idempotencyKey,
  hostMessageId,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let assistantTurn = null;
    let assistantMessage = null;
    let quietTimer = null;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(quietTimer);
      observer.disconnect();
      callback();
    };
    const settleIfQuiet = () => {
      if (!assistantTurn || !assistantMessage) return;
      const content = boundedAssistantText(assistantMessage);
      const assistantMessageId = hostMessageIdFor(assistantMessage);
      if (!content || !assistantMessageId) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        const stableContent = boundedAssistantText(assistantMessage);
        const stableId = hostMessageIdFor(assistantMessage);
        if (stableContent !== content || stableId !== assistantMessageId || assistantIsStreaming(document)) {
          settleIfQuiet();
          return;
        }
        finish(() =>
          resolve({
            requestId,
            conversationId,
            idempotencyKey,
            hostMessageId,
            assistantMessageId,
            content,
          }),
        );
      }, quietMs);
    };
    const scan = () => {
      const candidate = findCausalAssistantCandidate(document, hostMessageId);
      if (!candidate) return;
      if (candidate.error) {
        finish(() => reject(candidate.error));
        return;
      }
      if (assistantTurn && assistantTurn !== candidate.turn) {
        const previousId = hostMessageIdFor(assistantMessage);
        const candidateId = hostMessageIdFor(candidate.message);
        if (previousId && candidateId && previousId !== candidateId) {
          finish(() =>
            reject(
              new ChatGptPageAdapterError(
                'AMBIGUOUS_ASSISTANT_TURN',
                'the causal ChatGPT assistant turn changed its Host-provided identifier during observation',
              ),
            ),
          );
          return;
        }
      }
      assistantTurn = candidate.turn;
      assistantMessage = candidate.message;
      settleIfQuiet();
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    const timeoutTimer = setTimeout(() => {
      finish(() =>
        reject(
          new ChatGptPageAdapterError(
            'ASSISTANT_FINAL_NOT_OBSERVED',
            'ChatGPT did not expose one stable assistant final causally following the dispatched user turn',
          ),
        ),
      );
    }, timeoutMs);
    timeoutTimer.unref?.();
    scan();
  });
}

function requireMatchingConversation(location, conversationId, message) {
  if (conversationIdFromLocation(location) !== conversationId) {
    throw new ChatGptPageAdapterError('CONVERSATION_MISMATCH', message);
  }
}

function unsupportedComposerError({ code, message, composer, phase, adapterRevision, artifactRevision, path }) {
  const fingerprint = composerDomFingerprint(composer, {
    phase,
    adapterRevision,
    artifactRevision,
    firstUnsupportedPath: path,
  });
  return new ChatGptPageAdapterError(code, message, {
    v: 1,
    errorCode: code,
    fingerprint,
    nextAction: 'inspect_bound_tab',
  });
}

function requireEmptyComposer(document, revisions) {
  const composer = firstMatch(document, COMPOSER_SELECTORS);
  if (!composer) throw new ChatGptPageAdapterError('COMPOSER_NOT_FOUND', 'ChatGPT composer was not found');
  const current = composerTextResult(document, composer);
  if (current.status === 'unsupported') {
    throw unsupportedComposerError({
      code: 'COMPOSER_DOM_UNSUPPORTED',
      message: `ChatGPT composer contains an unsupported node at ${current.path}`,
      composer,
      phase: 'empty_check',
      ...revisions,
      path: current.path,
    });
  }
  if (current.text !== '') {
    throw new ChatGptPageAdapterError('COMPOSER_NOT_EMPTY', 'ChatGPT composer contains an owner draft');
  }
  return composer;
}

function existingUserMessageIds(document) {
  return new Set([...document.querySelectorAll(USER_MESSAGE_SELECTOR)].map(hostMessageIdFor).filter(Boolean));
}

function requireSafeSubmissionState({
  document,
  location,
  composer,
  sendButton,
  conversationId,
  text,
  adapterRevision,
  artifactRevision,
}) {
  requireMatchingConversation(location, conversationId, 'bound conversation changed before ChatGPT submission');
  const current = composerTextResult(document, composer);
  if (current.status === 'unsupported') {
    throw unsupportedComposerError({
      code: 'COMPOSER_DOM_UNSUPPORTED',
      message: `ChatGPT composer contains an unsupported node at ${current.path}`,
      composer,
      phase: 'before_submit',
      adapterRevision,
      artifactRevision,
      path: current.path,
    });
  }
  if (current.text !== text) {
    throw new ChatGptPageAdapterError('COMPOSER_CHANGED_BEFORE_SUBMIT', 'ChatGPT composer changed before submission');
  }
  if (!sendButton.isConnected || sendButtonIsDisabled(sendButton)) {
    throw new ChatGptPageAdapterError(
      sendButtonIsDisabled(sendButton) ? 'SEND_BUTTON_DISABLED' : 'SEND_BUTTON_INVALID',
      'ChatGPT send button changed before submission',
    );
  }
}

async function submitPageMessage({
  document,
  location,
  MutationObserver,
  onProgress,
  observationTimeoutMs,
  sendButtonTimeoutMs,
  requestId,
  conversationId,
  text,
  idempotencyKey,
  adapterRevision,
  artifactRevision,
  assistantObservationTimeoutMs,
  assistantQuietMs,
  onAssistantFinal,
  onAssistantObservationFailure,
}) {
  requireMatchingConversation(location, conversationId, 'bound conversation does not match the current ChatGPT tab');
  const composer = requireEmptyComposer(document, { adapterRevision, artifactRevision });
  const snapshot = composerSnapshot(document, composer);
  const existingIds = existingUserMessageIds(document);
  let clicked = false;
  let mutated = false;
  try {
    insertComposerText(document, composer, text, () => {
      mutated = true;
    });
    await onProgress('inserted', { requestId, conversationId, idempotencyKey });
    const sendButton = await waitForSendButton({ document, MutationObserver, timeoutMs: sendButtonTimeoutMs });
    requireSafeSubmissionState({
      document,
      location,
      composer,
      sendButton,
      conversationId,
      text,
      adapterRevision,
      artifactRevision,
    });
    sendButton.click();
    clicked = true;
  } catch (error) {
    if (error instanceof ChatGptPageAdapterError && error.diagnostic === undefined) {
      error.diagnostic = {
        v: 1,
        errorCode: error.code,
        fingerprint: composerDomFingerprint(composer, {
          phase: 'failed_before_submit',
          adapterRevision,
          artifactRevision,
        }),
        nextAction: 'inspect_bound_tab',
      };
    }
    if (!clicked && mutated) restoreAfterNoSend(document, composer, snapshot);
    throw error;
  }
  await onProgress('submitted', { requestId, conversationId, idempotencyKey });
  const receipt = await observeHostMessage({
    document,
    MutationObserver,
    existingIds,
    text,
    timeoutMs: observationTimeoutMs,
  });
  await onProgress('host_observed', {
    requestId,
    conversationId,
    idempotencyKey,
    hostMessageId: receipt.hostMessageId,
  });
  void observeCausalAssistantFinal({
    document,
    MutationObserver,
    timeoutMs: assistantObservationTimeoutMs,
    quietMs: assistantQuietMs,
    requestId,
    conversationId,
    idempotencyKey,
    hostMessageId: receipt.hostMessageId,
  })
    .then(onAssistantFinal)
    .catch((error) =>
      onAssistantObservationFailure({
        requestId,
        conversationId,
        idempotencyKey,
        hostMessageId: receipt.hostMessageId,
        errorCode: typeof error?.code === 'string' ? error.code : 'PAGE_ADAPTER_FAILED',
        diagnostic: assistantObservationDiagnostic(document, receipt.turn, receipt.hostMessageId),
      }),
    )
    .catch(() => undefined);
  return { hostMessageId: receipt.hostMessageId };
}

export function createChatGptPageAdapter({
  document,
  location,
  MutationObserver,
  onProgress = () => undefined,
  observationTimeoutMs = 10_000,
  sendButtonTimeoutMs = 2_000,
  assistantObservationTimeoutMs = 120_000,
  assistantQuietMs = 750,
  onAssistantFinal = () => undefined,
  onAssistantObservationFailure = () => undefined,
  adapterRevision = 'unversioned',
  artifactRevision = 'unversioned',
}) {
  if (!document?.querySelector || !location || typeof MutationObserver !== 'function') {
    throw new ChatGptPageAdapterError('INVALID_ENVIRONMENT', 'document, location, and MutationObserver are required');
  }
  requireTimeout(observationTimeoutMs, 10, 60_000, 'observationTimeoutMs');
  requireTimeout(sendButtonTimeoutMs, 10, 10_000, 'sendButtonTimeoutMs');
  requireTimeout(assistantObservationTimeoutMs, 10, 300_000, 'assistantObservationTimeoutMs');
  requireTimeout(assistantQuietMs, 10, 10_000, 'assistantQuietMs');
  if (typeof onAssistantFinal !== 'function') {
    throw new ChatGptPageAdapterError('INVALID_ENVIRONMENT', 'onAssistantFinal must be a function');
  }
  if (typeof onAssistantObservationFailure !== 'function') {
    throw new ChatGptPageAdapterError('INVALID_ENVIRONMENT', 'onAssistantObservationFailure must be a function');
  }
  const completedByKey = new Map();
  const inFlightByKey = new Map();
  let appendTail = Promise.resolve();

  return {
    async appendMessage(rawRequest) {
      const requestId = requireExactString(rawRequest?.requestId, 'requestId', 200);
      const conversationId = requireExactString(rawRequest?.conversationId, 'conversationId', 200);
      if (!SAFE_CONVERSATION_ID.test(conversationId)) {
        throw new ChatGptPageAdapterError('INVALID_REQUEST', 'conversationId has an invalid format');
      }
      const text = requireContentString(rawRequest?.text);
      const idempotencyKey = requireExactString(rawRequest?.idempotencyKey, 'idempotencyKey', 512);
      const dedupeKey = `${conversationId}\u0000${idempotencyKey}`;
      const completed = completedByKey.get(dedupeKey);
      if (completed) return completed;
      const inFlight = inFlightByKey.get(dedupeKey);
      if (inFlight) return inFlight;

      const runAppend = async () => {
        const receipt = await submitPageMessage({
          document,
          location,
          MutationObserver,
          onProgress,
          observationTimeoutMs,
          sendButtonTimeoutMs,
          requestId,
          conversationId,
          text,
          idempotencyKey,
          adapterRevision,
          artifactRevision,
          assistantObservationTimeoutMs,
          assistantQuietMs,
          onAssistantFinal,
          onAssistantObservationFailure,
        });
        completedByKey.set(dedupeKey, receipt);
        return receipt;
      };
      const operation = appendTail.then(runAppend, runAppend);
      appendTail = operation;
      inFlightByKey.set(dedupeKey, operation);
      try {
        return await operation;
      } finally {
        inFlightByKey.delete(dedupeKey);
      }
    },
  };
}

export const CHATGPT_PAGE_ADAPTER_SELECTORS = Object.freeze({
  composer: [...COMPOSER_SELECTORS],
  sendButton: [...SEND_BUTTON_SELECTORS],
  userMessage: USER_MESSAGE_SELECTOR,
  assistantMessage: ASSISTANT_MESSAGE_SELECTOR,
});
