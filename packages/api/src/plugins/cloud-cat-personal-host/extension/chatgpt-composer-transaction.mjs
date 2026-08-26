import { ChatGptPageAdapterError, inspectContentEditableText } from './chatgpt-page-contract.mjs';

export function composerTextResult(document, composer) {
  return composer instanceof document.defaultView.HTMLTextAreaElement
    ? { status: 'ok', text: composer.value }
    : inspectContentEditableText(composer);
}

export function composerText(document, composer) {
  const result = composerTextResult(document, composer);
  return result.status === 'ok' ? result.text : null;
}

export function composerSnapshot(document, composer) {
  if (composer instanceof document.defaultView.HTMLTextAreaElement) {
    return { kind: 'textarea', value: composer.value };
  }
  return { kind: 'contenteditable', html: composer.innerHTML };
}

function dispatchComposerInput(document, composer, { inputType, data }) {
  const inputEvent = new document.defaultView.InputEvent('input', {
    bubbles: true,
    composed: true,
    inputType,
    data,
  });
  composer.dispatchEvent(inputEvent);
}

function setTextareaText(document, composer, text) {
  const descriptor = Object.getOwnPropertyDescriptor(document.defaultView.HTMLTextAreaElement.prototype, 'value');
  descriptor?.set?.call(composer, text);
}

export function insertComposerText(document, composer, text, onMutated) {
  if (composer instanceof document.defaultView.HTMLTextAreaElement) {
    setTextareaText(document, composer, text);
    onMutated();
    dispatchComposerInput(document, composer, { inputType: 'insertText', data: text });
  } else {
    composer.focus({ preventScroll: true });
    const selection = document.defaultView.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const accepted =
      typeof document.execCommand === 'function' && document.execCommand('insertText', false, text) === true;
    if (!accepted) {
      const rejectedState = composerTextResult(document, composer);
      if (rejectedState.status !== 'ok' || rejectedState.text !== '') onMutated();
      throw new ChatGptPageAdapterError(
        'COMPOSER_NATIVE_INSERT_UNAVAILABLE',
        'ChatGPT composer did not accept a native editor transaction',
      );
    }
    onMutated();
  }
  if (composerText(document, composer) !== text) {
    throw new ChatGptPageAdapterError('COMPOSER_INSERT_FAILED', 'composer did not retain the exact append text');
  }
}

function restoreComposer(document, composer, snapshot) {
  if (snapshot.kind === 'textarea') {
    setTextareaText(document, composer, snapshot.value);
    dispatchComposerInput(document, composer, { inputType: 'deleteContentBackward', data: null });
  } else {
    composer.focus({ preventScroll: true });
    const selection = document.defaultView.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (typeof document.execCommand !== 'function' || document.execCommand('delete', false) !== true) {
      throw new ChatGptPageAdapterError('COMPOSER_RESTORE_FAILED', 'composer rejected the native restore transaction');
    }
  }
  const restored =
    snapshot.kind === 'textarea' ? composer.value === snapshot.value : composerText(document, composer) === '';
  if (!restored) {
    throw new ChatGptPageAdapterError(
      'COMPOSER_RESTORE_FAILED',
      'composer could not be restored after a no-send failure',
    );
  }
}

export function restoreAfterNoSend(document, composer, snapshot) {
  try {
    restoreComposer(document, composer, snapshot);
  } catch (error) {
    if (error instanceof ChatGptPageAdapterError) throw error;
    throw new ChatGptPageAdapterError(
      'COMPOSER_RESTORE_FAILED',
      'composer could not be restored after a no-send failure',
    );
  }
}
