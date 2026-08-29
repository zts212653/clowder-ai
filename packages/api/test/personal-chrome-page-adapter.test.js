import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

import { createChatGptPageAdapter } from '../src/plugins/cloud-cat-personal-host/extension/chatgpt-page-adapter.mjs';

function attachFixtureMessageId({ document, messageIdPlacement, turn, message, sendCount }) {
  const isTurnDescendant = messageIdPlacement.startsWith('turn-descendant');
  let idOwner = message;
  if (messageIdPlacement === 'turn') idOwner = turn;
  if (isTurnDescendant) idOwner = document.createElement('div');
  idOwner.dataset.messageId = `host-message-${sendCount}`;
  if (!isTurnDescendant) return;

  turn.append(idOwner);
  if (messageIdPlacement === 'turn-descendant-ambiguous') {
    const otherIdOwner = document.createElement('div');
    otherIdOwner.dataset.messageId = `other-host-message-${sendCount}`;
    turn.append(otherIdOwner);
  }
}

function createFixture({
  conversationId = 'conversation-7',
  addMessageId = true,
  messageIdPlacement = 'message',
  initialComposerText = '',
  sendButton = 'present',
} = {}) {
  const dom = new JSDOM(
    `<!doctype html><body>
      <main id="messages"></main>
      <div id="prompt-textarea" contenteditable="true">${initialComposerText}</div>
      ${sendButton === 'absent' ? '' : '<button data-testid="send-button">Send</button>'}
    </body>`,
    { url: `https://chatgpt.com/c/${conversationId}`, pretendToBeVisual: true },
  );
  const document = dom.window.document;
  const composer = document.querySelector('#prompt-textarea');
  document.execCommand = (command, _showUi, value) => {
    if (command === 'insertText' && typeof value === 'string') {
      composer.textContent = value;
      composer.dispatchEvent(
        new dom.window.InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: value,
        }),
      );
      return true;
    }
    if (command === 'delete') {
      composer.replaceChildren();
      composer.dispatchEvent(
        new dom.window.InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'deleteContentBackward',
          data: null,
        }),
      );
      return true;
    }
    return false;
  };
  let sendCount = 0;
  const sentTexts = [];
  const attachSendHandler = (button) =>
    button.addEventListener('click', () => {
      sendCount += 1;
      const composer = document.querySelector('#prompt-textarea');
      const sentText = composer.textContent;
      sentTexts.push(sentText);
      const turn = document.createElement('article');
      const message = messageIdPlacement === 'message' ? turn : document.createElement('div');
      message.dataset.messageAuthorRole = 'user';
      if (addMessageId) attachFixtureMessageId({ document, messageIdPlacement, turn, message, sendCount });
      message.textContent = sentText;
      if (message !== turn) turn.append(message);
      document.querySelector('#messages').append(turn);
      composer.replaceChildren();
    });
  const initialButton = document.querySelector('[data-testid="send-button"]');
  if (initialButton) attachSendHandler(initialButton);
  return { dom, document, attachSendHandler, getSendCount: () => sendCount, sentTexts };
}

describe('ChatGPT page adapter', () => {
  it('inserts exact text, submits once, and returns the DOM-provided user-message ID', async () => {
    const fixture = createFixture();
    const progress = [];
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      onProgress: (status) => progress.push(status),
    });

    const result = await adapter.appendMessage({
      requestId: 'request-1',
      conversationId: 'conversation-7',
      text: 'hello cloud cat',
      idempotencyKey: 'source-message-9',
    });

    assert.equal(result.hostMessageId, 'host-message-1');
    assert.equal(fixture.getSendCount(), 1);
    assert.deepEqual(progress, ['inserted', 'submitted', 'host_observed']);
  });

  it('accepts the real host ID from the enclosing ChatGPT turn', async () => {
    const fixture = createFixture({ messageIdPlacement: 'turn' });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      observationTimeoutMs: 25,
    });

    const result = await adapter.appendMessage({
      requestId: 'request-turn-id',
      conversationId: 'conversation-7',
      text: 'host id belongs to the enclosing turn',
      idempotencyKey: 'source-message-turn-id',
    });

    assert.equal(result.hostMessageId, 'host-message-1');
    assert.equal(fixture.getSendCount(), 1);
  });

  it('accepts the real host ID from a descendant of the enclosing ChatGPT turn', async () => {
    const fixture = createFixture({ messageIdPlacement: 'turn-descendant' });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      observationTimeoutMs: 25,
    });

    const result = await adapter.appendMessage({
      requestId: 'request-turn-descendant-id',
      conversationId: 'conversation-7',
      text: 'host id belongs to a descendant of the enclosing turn',
      idempotencyKey: 'source-message-turn-descendant-id',
    });

    assert.equal(result.hostMessageId, 'host-message-1');
    assert.equal(fixture.getSendCount(), 1);
  });

  it('fails closed when the enclosing ChatGPT turn exposes multiple possible host IDs', async () => {
    const fixture = createFixture({ messageIdPlacement: 'turn-descendant-ambiguous' });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      observationTimeoutMs: 25,
    });

    await assert.rejects(
      adapter.appendMessage({
        requestId: 'request-ambiguous-turn-descendant-id',
        conversationId: 'conversation-7',
        text: 'ambiguous real host ids must not produce a receipt',
        idempotencyKey: 'source-message-ambiguous-turn-descendant-id',
      }),
      (error) => error.code === 'HOST_MESSAGE_NOT_OBSERVED',
    );

    assert.equal(fixture.getSendCount(), 1);
  });

  it('inserts first, then waits for the send button that the input event renders', async () => {
    const fixture = createFixture({ sendButton: 'absent' });
    const composer = fixture.document.querySelector('#prompt-textarea');
    composer.addEventListener('input', () => {
      if (fixture.document.querySelector('[data-testid="send-button"]')) return;
      setTimeout(() => {
        const button = fixture.document.createElement('button');
        button.dataset.testid = 'send-button';
        button.textContent = 'Send';
        fixture.attachSendHandler(button);
        fixture.document.body.append(button);
      }, 5);
    });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      sendButtonTimeoutMs: 50,
    });

    const result = await adapter.appendMessage({
      requestId: 'request-dynamic-send',
      conversationId: 'conversation-7',
      text: 'button follows input',
      idempotencyKey: 'source-message-dynamic-send',
    });

    assert.equal(result.hostMessageId, 'host-message-1');
    assert.equal(fixture.getSendCount(), 1);
  });

  it('restores the exact empty composer and reports typed no-send when the button never appears', async () => {
    const fixture = createFixture({ sendButton: 'absent' });
    const composer = fixture.document.querySelector('#prompt-textarea');
    const inputTypes = [];
    composer.addEventListener('input', (event) => inputTypes.push(event.inputType));
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      sendButtonTimeoutMs: 20,
    });

    await assert.rejects(
      adapter.appendMessage({
        requestId: 'request-missing-send',
        conversationId: 'conversation-7',
        text: 'must be rolled back',
        idempotencyKey: 'source-message-missing-send',
      }),
      (error) => error.code === 'SEND_BUTTON_NOT_FOUND',
    );

    assert.equal(composer.innerHTML, '');
    assert.equal(fixture.getSendCount(), 0);
    assert.deepEqual(inputTypes, ['insertText', 'deleteContentBackward']);
  });

  it('does not overwrite a non-empty owner draft', async () => {
    const fixture = createFixture({ initialComposerText: 'owner draft' });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
    });

    await assert.rejects(
      adapter.appendMessage({
        requestId: 'request-owner-draft',
        conversationId: 'conversation-7',
        text: 'must not replace draft',
        idempotencyKey: 'source-message-owner-draft',
      }),
      (error) => error.code === 'COMPOSER_NOT_EMPTY',
    );

    assert.equal(fixture.document.querySelector('#prompt-textarea').textContent, 'owner draft');
    assert.equal(fixture.getSendCount(), 0);
  });

  it('restores the composer and reports typed no-send when the rendered button stays disabled', async () => {
    const fixture = createFixture();
    const button = fixture.document.querySelector('[data-testid="send-button"]');
    button.disabled = true;
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      sendButtonTimeoutMs: 20,
    });

    await assert.rejects(
      adapter.appendMessage({
        requestId: 'request-disabled-send',
        conversationId: 'conversation-7',
        text: 'must not remain',
        idempotencyKey: 'source-message-disabled-send',
      }),
      (error) => error.code === 'SEND_BUTTON_DISABLED',
    );

    assert.equal(fixture.document.querySelector('#prompt-textarea').innerHTML, '');
    assert.equal(fixture.getSendCount(), 0);
  });

  it('reports a restoration failure instead of claiming a clean no-send state', async () => {
    const fixture = createFixture({ sendButton: 'absent' });
    const composer = fixture.document.querySelector('#prompt-textarea');
    composer.addEventListener('input', (event) => {
      if (event.inputType === 'deleteContentBackward') composer.textContent = 'framework residue';
    });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      sendButtonTimeoutMs: 20,
    });

    await assert.rejects(
      adapter.appendMessage({
        requestId: 'request-restore-failure',
        conversationId: 'conversation-7',
        text: 'restore failure nonce',
        idempotencyKey: 'source-message-restore-failure',
      }),
      (error) => error.code === 'COMPOSER_RESTORE_FAILED',
    );
    assert.equal(fixture.getSendCount(), 0);
  });

  it('preserves intentional leading and trailing whitespace in the append text', async () => {
    const fixture = createFixture();
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
    });
    const text = '\n<thread-runtime>{"intent":"wake"}</thread-runtime>\n';

    const result = await adapter.appendMessage({
      requestId: 'request-whitespace',
      conversationId: 'conversation-7',
      text,
      idempotencyKey: 'source-message-whitespace',
    });

    assert.equal(result.hostMessageId, 'host-message-1');
    assert.equal(fixture.document.querySelector('[data-message-id="host-message-1"]').textContent, text);
  });

  it('deduplicates a repeated idempotency key without a second send action', async () => {
    const fixture = createFixture();
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
    });
    const request = {
      requestId: 'request-1',
      conversationId: 'conversation-7',
      text: 'hello cloud cat',
      idempotencyKey: 'source-message-9',
    };

    const first = await adapter.appendMessage(request);
    const retry = await adapter.appendMessage(request);

    assert.deepEqual(retry, first);
    assert.equal(fixture.getSendCount(), 1);
  });

  it('serializes distinct append operations before either can replace the shared composer', async () => {
    const fixture = createFixture();
    let announceFirstInserted;
    let releaseFirstInserted;
    const firstInserted = new Promise((resolve) => {
      announceFirstInserted = resolve;
    });
    const firstInsertedGate = new Promise((resolve) => {
      releaseFirstInserted = resolve;
    });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      // This test intentionally pauses after observation starts. Keep the
      // production timeout so unrelated full-suite load cannot win the gate.
      observationTimeoutMs: 10_000,
      async onProgress(status, request) {
        if (status === 'inserted' && request.requestId === 'request-1') {
          announceFirstInserted();
          await firstInsertedGate;
        }
      },
    });

    const first = adapter.appendMessage({
      requestId: 'request-1',
      conversationId: 'conversation-7',
      text: 'first message',
      idempotencyKey: 'source-message-1',
    });
    await firstInserted;
    const second = adapter.appendMessage({
      requestId: 'request-2',
      conversationId: 'conversation-7',
      text: 'second message',
      idempotencyKey: 'source-message-2',
    });

    let earlyError;
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fixture.document.querySelector('#prompt-textarea').textContent, 'first message');
      assert.equal(fixture.getSendCount(), 0);
    } catch (error) {
      earlyError = error;
    } finally {
      releaseFirstInserted();
    }

    const outcomes = await Promise.allSettled([first, second]);
    if (earlyError) throw earlyError;
    assert.equal(outcomes[0].status, 'fulfilled');
    assert.equal(outcomes[1].status, 'fulfilled');
    const firstReceipt = outcomes[0].value;
    const secondReceipt = outcomes[1].value;
    assert.equal(firstReceipt.hostMessageId, 'host-message-1');
    assert.equal(secondReceipt.hostMessageId, 'host-message-2');
    assert.deepEqual(fixture.sentTexts, ['first message', 'second message']);
  });

  it('fails closed when the bound conversation does not match the current tab', async () => {
    const fixture = createFixture({ conversationId: 'other-conversation' });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
    });

    await assert.rejects(
      adapter.appendMessage({
        requestId: 'request-1',
        conversationId: 'conversation-7',
        text: 'hello cloud cat',
        idempotencyKey: 'source-message-9',
      }),
      (error) => error.code === 'CONVERSATION_MISMATCH',
    );
    assert.equal(fixture.getSendCount(), 0);
  });

  it('never invents a host receipt when the submitted DOM message has no message ID', async () => {
    const fixture = createFixture({ addMessageId: false });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      observationTimeoutMs: 25,
    });

    await assert.rejects(
      adapter.appendMessage({
        requestId: 'request-1',
        conversationId: 'conversation-7',
        text: 'hello cloud cat',
        idempotencyKey: 'source-message-9',
      }),
      (error) => error.code === 'HOST_MESSAGE_NOT_OBSERVED',
    );
    assert.equal(fixture.getSendCount(), 1);
  });
});
