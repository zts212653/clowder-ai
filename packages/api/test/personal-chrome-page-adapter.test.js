import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

import { createChatGptPageAdapter } from '../src/plugins/cloud-cat-personal-host/extension/chatgpt-page-adapter.mjs';

function createFixture({ conversationId = 'conversation-7', addMessageId = true } = {}) {
  const dom = new JSDOM(
    `<!doctype html><body>
      <main id="messages"></main>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">Send</button>
    </body>`,
    { url: `https://chatgpt.com/c/${conversationId}`, pretendToBeVisual: true },
  );
  const document = dom.window.document;
  let sendCount = 0;
  const sentTexts = [];
  document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
    sendCount += 1;
    sentTexts.push(document.querySelector('#prompt-textarea').textContent);
    const message = document.createElement('article');
    message.dataset.messageAuthorRole = 'user';
    if (addMessageId) message.dataset.messageId = `host-message-${sendCount}`;
    message.textContent = document.querySelector('#prompt-textarea').textContent;
    document.querySelector('#messages').append(message);
  });
  return { dom, document, getSendCount: () => sendCount, sentTexts };
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
