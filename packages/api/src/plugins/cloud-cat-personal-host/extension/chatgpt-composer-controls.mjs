import { ChatGptPageAdapterError, firstMatch } from './chatgpt-page-contract.mjs';

export const SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="发送提示"]',
];
const GENERATING_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="停止生成"]',
  'form[data-chatgpt-composer] button[type="button"][aria-label="停止"]',
  'form[data-chatgpt-composer] button[type="button"][aria-label="Stop"]',
];

export function assistantIsStreaming(document) {
  return firstMatch(document, GENERATING_SELECTORS) !== null;
}

export function requireIdleComposer(document) {
  if (assistantIsStreaming(document)) {
    throw new ChatGptPageAdapterError('CHATGPT_GENERATING', 'ChatGPT is generating a response');
  }
}

export function sendButtonIsDisabled(button) {
  return button.disabled === true || button.getAttribute('aria-disabled') === 'true';
}

export function findSendButton(document, composer) {
  const form = composer.closest('form[data-chatgpt-composer]');
  const candidates = [
    ...new Set(
      (form ?? document).querySelectorAll(
        [...SEND_BUTTON_SELECTORS, ...(form ? ['button[type="submit"]'] : [])].join(','),
      ),
    ),
  ].filter((button) => !button.closest('[hidden], [aria-hidden="true"]'));
  if (candidates.length > 1) {
    throw new ChatGptPageAdapterError('SEND_BUTTON_AMBIGUOUS', 'ChatGPT exposes multiple submit controls');
  }
  return candidates[0] ?? null;
}

export function waitForSendButton({ document, composer, MutationObserver, timeoutMs }) {
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
      try {
        requireIdleComposer(document);
        const button = findSendButton(document, composer);
        if (!button) return;
        if (typeof button.click !== 'function' || !button.isConnected) {
          throw new ChatGptPageAdapterError('SEND_BUTTON_INVALID', 'ChatGPT control is not safely clickable');
        }
        if (sendButtonIsDisabled(button)) {
          sawDisabledButton = true;
          return;
        }
        finish(() => resolve(button));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'aria-disabled', 'aria-label', 'type', 'data-testid', 'hidden', 'aria-hidden'],
    });
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new ChatGptPageAdapterError(
              sawDisabledButton ? 'SEND_BUTTON_DISABLED' : 'SEND_BUTTON_NOT_FOUND',
              sawDisabledButton ? 'ChatGPT submit remained disabled' : 'ChatGPT submit was not found',
            ),
          ),
        ),
      timeoutMs,
    );
    scan();
  });
}
