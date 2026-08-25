import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

import { createChatGptPageAdapter } from '../src/plugins/cloud-cat-personal-host/extension/chatgpt-page-adapter.mjs';
import {
  observedComposerText,
  replaceWithMisplacedTrailingBreak,
  replaceWithObservedInsertedShape,
  replaceWithOrdinaryHardBreak,
  restoreObservedEmptyShape,
} from './helpers/f247-prosemirror-composer-fixture.js';

function replaceWithParagraphs(document, element, text) {
  element.replaceChildren(
    ...text.split('\n').map((line) => {
      const paragraph = document.createElement('p');
      if (line.length === 0) paragraph.append(document.createElement('br'));
      else paragraph.textContent = line;
      return paragraph;
    }),
  );
}

function createNormalizedFixture({ replaceInserted = replaceWithParagraphs } = {}) {
  const dom = new JSDOM(
    `<!doctype html><body>
      <main id="messages"></main>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">Send</button>
    </body>`,
    { url: 'https://chatgpt.com/c/conversation-7', pretendToBeVisual: true },
  );
  const document = dom.window.document;
  const composer = document.querySelector('#prompt-textarea');
  composer.classList.add('ProseMirror');
  composer.dataset.virtualkeyboard = 'true';
  restoreObservedEmptyShape(document, composer);
  let sendCount = 0;
  const sentTexts = [];
  const sendButton = document.querySelector('[data-testid="send-button"]');
  sendButton.disabled = true;
  composer.addEventListener('input', (event) => {
    if (event.inputType !== 'insertText') return;
    queueMicrotask(() => {
      restoreObservedEmptyShape(document, composer);
      sendButton.disabled = true;
    });
  });
  document.execCommand = (command, _showUi, value) => {
    if (command === 'insertText' && typeof value === 'string') {
      replaceInserted(document, composer, value);
      sendButton.disabled = false;
      return true;
    }
    if (command === 'delete') {
      restoreObservedEmptyShape(document, composer);
      sendButton.disabled = true;
      return true;
    }
    return false;
  };
  sendButton.addEventListener('click', () => {
    sendCount += 1;
    const sentText = observedComposerText(composer);
    sentTexts.push(sentText);
    const message = document.createElement('article');
    message.dataset.messageAuthorRole = 'user';
    message.dataset.messageId = `host-message-${sendCount}`;
    replaceWithParagraphs(document, message, sentText);
    document.querySelector('#messages').append(message);
    restoreObservedEmptyShape(document, composer);
    sendButton.disabled = true;
  });
  return {
    dom,
    document,
    composer,
    getSendCount: () => sendCount,
    sentTexts,
  };
}

function createAdapter(fixture, overrides = {}) {
  return createChatGptPageAdapter({
    document: fixture.document,
    location: fixture.dom.window.location,
    MutationObserver: fixture.dom.window.MutationObserver,
    ...overrides,
  });
}

describe('ChatGPT page adapter multiline normalization', () => {
  it('accepts the owner-observed text block with a ProseMirror trailing break', async () => {
    const fixture = createNormalizedFixture({ replaceInserted: replaceWithObservedInsertedShape });
    const adapter = createAdapter(fixture);
    const text = 'alpha\nbeta\ngamma\n\ndelta';

    const result = await adapter.appendMessage({
      requestId: 'request-observed-trailing-break',
      conversationId: 'conversation-7',
      text,
      idempotencyKey: 'source-message-observed-trailing-break',
    });

    assert.equal(result.hostMessageId, 'host-message-1');
    assert.equal(fixture.getSendCount(), 1);
    assert.deepEqual(fixture.sentTexts, [text]);
  });

  it('preserves an ordinary BR as a user-authored hard break', async () => {
    const fixture = createNormalizedFixture({ replaceInserted: replaceWithOrdinaryHardBreak });
    const adapter = createAdapter(fixture);
    const text = 'alpha\nbeta\ngamma';

    const result = await adapter.appendMessage({
      requestId: 'request-ordinary-hard-break',
      conversationId: 'conversation-7',
      text,
      idempotencyKey: 'source-message-ordinary-hard-break',
    });

    assert.equal(result.hostMessageId, 'host-message-1');
    assert.equal(fixture.getSendCount(), 1);
    assert.deepEqual(fixture.sentTexts, [text]);
  });

  it('fails closed when a ProseMirror trailing break is not actually trailing', async () => {
    const fixture = createNormalizedFixture({ replaceInserted: replaceWithMisplacedTrailingBreak });
    const adapter = createAdapter(fixture);

    await assert.rejects(
      adapter.appendMessage({
        requestId: 'request-misplaced-trailing-break',
        conversationId: 'conversation-7',
        text: 'alphabeta',
        idempotencyKey: 'source-message-misplaced-trailing-break',
      }),
      (error) =>
        error.code === 'COMPOSER_INSERT_FAILED' &&
        error.diagnostic.fingerprint.nodes.some(
          (node) => node.path === 'composer/p[0]/br[1]' && node.trailingBreak === true,
        ),
    );

    assert.equal(fixture.getSendCount(), 0);
    assert.equal(fixture.document.querySelectorAll('[data-message-id]').length, 0);
    assert.equal(fixture.composer.textContent, '');
  });

  it('accepts ChatGPT block-DOM normalization of an exact runtime delta', async () => {
    const fixture = createNormalizedFixture();
    const adapter = createAdapter(fixture);
    const text =
      '<thread-runtime>\n{"sourceMessageId":"source-message-9","cloudReturnBinding":"cbr1.token"}\n</thread-runtime>\n\ninspect the exact source';

    const result = await adapter.appendMessage({
      requestId: 'request-normalized-multiline',
      conversationId: 'conversation-7',
      text,
      idempotencyKey: 'source-message-9',
    });

    assert.equal(result.hostMessageId, 'host-message-1');
    assert.equal(fixture.getSendCount(), 1);
    assert.deepEqual(fixture.sentTexts, [text]);
  });

  it('reports a bounded text-free fingerprint and first unsupported path', async () => {
    const fixture = createNormalizedFixture();
    const adapter = createAdapter(fixture, {
      async onProgress(status) {
        if (status !== 'inserted') return;
        const paragraph = fixture.document.createElement('p');
        const mark = fixture.document.createElement('mark');
        mark.textContent = 'must never enter diagnostics';
        paragraph.append(mark);
        fixture.composer.replaceChildren(paragraph);
      },
    });

    await assert.rejects(
      adapter.appendMessage({
        requestId: 'request-real-shape-unknown-node',
        conversationId: 'conversation-7',
        text: 'must never enter diagnostics',
        idempotencyKey: 'source-message-real-shape-unknown-node',
      }),
      (error) => {
        assert.equal(error.code, 'COMPOSER_DOM_UNSUPPORTED');
        assert.equal(error.diagnostic.fingerprint.firstUnsupportedPath, 'composer/p[0]/mark[0]');
        const serialized = JSON.stringify(error.diagnostic);
        assert.equal(serialized.includes('must never enter diagnostics'), false);
        assert.ok(error.diagnostic.fingerprint.nodes.length <= 12);
        return true;
      },
    );

    assert.equal(fixture.getSendCount(), 0);
    assert.equal(fixture.document.querySelectorAll('[data-message-id]').length, 0);
    assert.equal(fixture.composer.textContent, '');
  });

  it('still fails closed when the normalized composer changes one character', async () => {
    const fixture = createNormalizedFixture();
    const adapter = createAdapter(fixture, {
      async onProgress(status) {
        if (status === 'inserted') fixture.composer.querySelector('p').textContent = 'owner mutation';
      },
    });

    await assert.rejects(
      adapter.appendMessage({
        requestId: 'request-mutated-multiline',
        conversationId: 'conversation-7',
        text: 'line one\nline two',
        idempotencyKey: 'source-message-mutated-multiline',
      }),
      (error) => error.code === 'COMPOSER_CHANGED_BEFORE_SUBMIT',
    );

    assert.equal(fixture.getSendCount(), 0);
    assert.equal(fixture.composer.textContent, '');
  });

  it('fails closed when the composer is mutated into a nested block tree', async () => {
    const fixture = createNormalizedFixture();
    const adapter = createAdapter(fixture, {
      async onProgress(status) {
        if (status !== 'inserted') return;
        const outerBlock = fixture.document.createElement('div');
        outerBlock.append('alpha');
        const nestedBlock = fixture.document.createElement('div');
        nestedBlock.textContent = 'beta';
        outerBlock.append(nestedBlock);
        fixture.composer.replaceChildren(outerBlock);
      },
    });

    await assert.rejects(
      adapter.appendMessage({
        requestId: 'request-nested-block-mutation',
        conversationId: 'conversation-7',
        text: 'alphabeta',
        idempotencyKey: 'source-message-nested-block-mutation',
      }),
      (error) =>
        error.code === 'COMPOSER_DOM_UNSUPPORTED' &&
        error.diagnostic.fingerprint.firstUnsupportedPath === 'composer/div[0]/div[1]',
    );

    assert.equal(fixture.getSendCount(), 0);
    assert.equal(fixture.document.querySelectorAll('[data-message-id]').length, 0);
    assert.equal(fixture.composer.textContent, '');
  });

  it('rechecks the conversation after insertion and restores without sending when it changes', async () => {
    const fixture = createNormalizedFixture();
    const location = {
      protocol: 'https:',
      hostname: 'chatgpt.com',
      pathname: '/c/conversation-7',
    };
    const adapter = createAdapter(fixture, {
      location,
      async onProgress(status) {
        if (status === 'inserted') location.pathname = '/c/conversation-8';
      },
    });

    await assert.rejects(
      adapter.appendMessage({
        requestId: 'request-conversation-recheck',
        conversationId: 'conversation-7',
        text: 'line one\nline two',
        idempotencyKey: 'source-message-conversation-recheck',
      }),
      (error) => error.code === 'CONVERSATION_MISMATCH',
    );

    assert.equal(fixture.getSendCount(), 0);
    assert.equal(fixture.composer.textContent, '');
  });

  it('fails closed when the send button becomes disabled after insertion', async () => {
    const fixture = createNormalizedFixture();
    const adapter = createAdapter(fixture, {
      sendButtonTimeoutMs: 20,
      async onProgress(status) {
        if (status === 'inserted') {
          fixture.document.querySelector('[data-testid="send-button"]').disabled = true;
        }
      },
    });

    await assert.rejects(
      adapter.appendMessage({
        requestId: 'request-send-button-recheck',
        conversationId: 'conversation-7',
        text: 'line one\nline two',
        idempotencyKey: 'source-message-send-button-recheck',
      }),
      (error) => error.code === 'SEND_BUTTON_DISABLED',
    );

    assert.equal(fixture.getSendCount(), 0);
    assert.equal(fixture.composer.textContent, '');
  });

  it('restores a composer mutated by a native transaction that reports failure', async () => {
    const fixture = createNormalizedFixture();
    const nativeCommand = fixture.document.execCommand;
    let restoreCount = 0;
    fixture.document.execCommand = (command, showUi, value) => {
      if (command === 'insertText') {
        fixture.composer.textContent = value;
        return false;
      }
      if (command === 'delete') restoreCount += 1;
      return nativeCommand(command, showUi, value);
    };
    const adapter = createAdapter(fixture);

    await assert.rejects(
      adapter.appendMessage({
        requestId: 'request-native-false-after-mutation',
        conversationId: 'conversation-7',
        text: 'must be restored after rejected native mutation',
        idempotencyKey: 'source-message-native-false-after-mutation',
      }),
      (error) => error.code === 'COMPOSER_NATIVE_INSERT_UNAVAILABLE',
    );

    assert.equal(fixture.composer.textContent, '');
    assert.equal(fixture.getSendCount(), 0);
    assert.equal(restoreCount, 1);
  });
});
