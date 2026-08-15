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
const USER_MESSAGE_SELECTOR = '[data-message-author-role="user"][data-message-id]';
const SAFE_CONVERSATION_ID = /^[A-Za-z0-9-]+$/;

export class ChatGptPageAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChatGptPageAdapterError';
    this.code = code;
  }
}

function requireExactString(value, label, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new ChatGptPageAdapterError('INVALID_REQUEST', `${label} must be a non-empty exact string`);
  }
  return value;
}

function requireContentString(value) {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    new TextEncoder().encode(value).byteLength > 128 * 1024
  ) {
    throw new ChatGptPageAdapterError('INVALID_REQUEST', 'text must contain at most 131072 bytes');
  }
  return value;
}

function conversationIdFromLocation(location) {
  if (location.protocol !== 'https:' || location.hostname !== 'chatgpt.com') return null;
  const match = location.pathname.match(/^\/c\/([A-Za-z0-9-]+)\/?$/);
  return match?.[1] ?? null;
}

function firstMatch(document, selectors) {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) return element;
  }
  return null;
}

function insertComposerText(document, composer, text) {
  if (composer instanceof document.defaultView.HTMLTextAreaElement) {
    const descriptor = Object.getOwnPropertyDescriptor(document.defaultView.HTMLTextAreaElement.prototype, 'value');
    descriptor?.set?.call(composer, text);
  } else {
    composer.replaceChildren(document.createTextNode(text));
  }
  const inputEvent = new document.defaultView.InputEvent('input', {
    bubbles: true,
    composed: true,
    inputType: 'insertText',
    data: text,
  });
  composer.dispatchEvent(inputEvent);
  const inserted = composer instanceof document.defaultView.HTMLTextAreaElement ? composer.value : composer.textContent;
  if (inserted !== text) {
    throw new ChatGptPageAdapterError('COMPOSER_INSERT_FAILED', 'composer did not retain the exact append text');
  }
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
        const messageId = message.getAttribute('data-message-id');
        if (!messageId || existingIds.has(messageId)) continue;
        if (message.textContent !== text) continue;
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

export function createChatGptPageAdapter({
  document,
  location,
  MutationObserver,
  onProgress = () => undefined,
  observationTimeoutMs = 10_000,
}) {
  if (!document?.querySelector || !location || typeof MutationObserver !== 'function') {
    throw new ChatGptPageAdapterError('INVALID_ENVIRONMENT', 'document, location, and MutationObserver are required');
  }
  if (!Number.isInteger(observationTimeoutMs) || observationTimeoutMs < 10 || observationTimeoutMs > 60_000) {
    throw new ChatGptPageAdapterError('INVALID_ENVIRONMENT', 'observationTimeoutMs must be between 10 and 60000');
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
        if (conversationIdFromLocation(location) !== conversationId) {
          throw new ChatGptPageAdapterError(
            'CONVERSATION_MISMATCH',
            'bound conversation does not match the current ChatGPT tab',
          );
        }
        const composer = firstMatch(document, COMPOSER_SELECTORS);
        if (!composer) throw new ChatGptPageAdapterError('COMPOSER_NOT_FOUND', 'ChatGPT composer was not found');
        const sendButton = firstMatch(document, SEND_BUTTON_SELECTORS);
        if (!sendButton)
          throw new ChatGptPageAdapterError('SEND_BUTTON_NOT_FOUND', 'ChatGPT send button was not found');
        const existingIds = new Set(
          [...document.querySelectorAll(USER_MESSAGE_SELECTOR)]
            .map((message) => message.getAttribute('data-message-id'))
            .filter(Boolean),
        );
        const observed = observeHostMessage({
          document,
          MutationObserver,
          existingIds,
          text,
          timeoutMs: observationTimeoutMs,
        });
        insertComposerText(document, composer, text);
        await onProgress('inserted', { requestId, conversationId, idempotencyKey });
        sendButton.click();
        await onProgress('submitted', { requestId, conversationId, idempotencyKey });
        const receipt = await observed;
        await onProgress('host_observed', {
          requestId,
          conversationId,
          idempotencyKey,
          hostMessageId: receipt.hostMessageId,
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
