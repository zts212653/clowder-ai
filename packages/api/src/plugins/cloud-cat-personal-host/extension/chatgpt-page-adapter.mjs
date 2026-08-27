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
const MESSAGE_TURN_SELECTOR = 'article[data-testid^="conversation-turn-"], article';

function hostMessageIdFor(message) {
  const owner = message.closest('[data-message-id]');
  const ownerId = owner?.getAttribute('data-message-id')?.trim();
  if (ownerId) return ownerId;

  const turn = message.closest(MESSAGE_TURN_SELECTOR);
  if (!turn) return null;
  const candidates = [...turn.querySelectorAll('[data-message-id]')]
    .map((candidate) => candidate.getAttribute('data-message-id')?.trim())
    .filter(Boolean);
  return candidates.length === 1 ? candidates[0] : null;
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
        if (contentEditableText(message) !== text) continue;
        finish(() => resolve({ hostMessageId: messageId }));
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
            'ChatGPT did not expose a new user message with a real data-message-id',
          ),
        ),
      );
    }, timeoutMs);
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
  return receipt;
}

export function createChatGptPageAdapter({
  document,
  location,
  MutationObserver,
  onProgress = () => undefined,
  observationTimeoutMs = 10_000,
  sendButtonTimeoutMs = 2_000,
  adapterRevision = 'unversioned',
  artifactRevision = 'unversioned',
}) {
  if (!document?.querySelector || !location || typeof MutationObserver !== 'function') {
    throw new ChatGptPageAdapterError('INVALID_ENVIRONMENT', 'document, location, and MutationObserver are required');
  }
  requireTimeout(observationTimeoutMs, 10, 60_000, 'observationTimeoutMs');
  requireTimeout(sendButtonTimeoutMs, 10, 10_000, 'sendButtonTimeoutMs');
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
});
