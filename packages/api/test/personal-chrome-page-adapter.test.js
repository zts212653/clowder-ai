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

function appendFixtureUserMessage({
  document,
  messageIdPlacement,
  addMessageId,
  wrapRenderedMessage,
  renderedInnerText,
  renderedContentText,
  renderedContentCopies,
  renderedAffordanceText,
  sendCount,
  sentText,
}) {
  const turn = document.createElement('article');
  if (messageIdPlacement === 'turn-testid') turn.dataset.testid = `conversation-turn-${sendCount}`;
  const message = messageIdPlacement === 'message' ? turn : document.createElement('div');
  message.dataset.messageAuthorRole = 'user';
  if (addMessageId) attachFixtureMessageId({ document, messageIdPlacement, turn, message, sendCount });
  if (wrapRenderedMessage) {
    const renderedMessage = document.createElement('div');
    Object.defineProperty(message, 'innerText', {
      configurable: true,
      value: renderedInnerText ?? sentText,
    });
    for (let index = 0; index < renderedContentCopies; index += 1) {
      const renderedContent = document.createElement('div');
      renderedContent.className = 'whitespace-pre-wrap';
      renderedContent.textContent = renderedContentText ?? sentText;
      renderedMessage.append(renderedContent);
    }
    message.append(renderedMessage);
    if (renderedAffordanceText) {
      const affordance = document.createElement('button');
      affordance.textContent = renderedAffordanceText;
      message.append(affordance);
    }
  } else {
    message.textContent = sentText;
  }
  if (message !== turn) turn.append(message);
  document.querySelector('#messages').append(turn);
}

function createFixture({
  conversationId = 'conversation-7',
  addMessageId = true,
  messageIdPlacement = 'message',
  initialComposerText = '',
  sendButton = 'present',
  wrapRenderedMessage = false,
  renderedInnerText,
  renderedContentText,
  renderedContentCopies = 1,
  renderedAffordanceText,
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
      appendFixtureUserMessage({
        document,
        messageIdPlacement,
        addMessageId,
        wrapRenderedMessage,
        renderedInnerText,
        renderedContentText,
        renderedContentCopies,
        renderedAffordanceText,
        sendCount,
        sentText,
      });
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

  it('accepts the unique Host-provided conversation turn ID when data-message-id is absent', async () => {
    const fixture = createFixture({ addMessageId: false, messageIdPlacement: 'turn-testid' });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      observationTimeoutMs: 25,
    });

    const result = await adapter.appendMessage({
      requestId: 'request-turn-testid',
      conversationId: 'conversation-7',
      text: 'new ChatGPT DOM exposes only the enclosing turn ID',
      idempotencyKey: 'source-message-turn-testid',
    });

    assert.equal(result.hostMessageId, 'conversation-turn-1');
    assert.equal(fixture.getSendCount(), 1);
  });

  it('observes a multiline runtime payload after ChatGPT wraps the rendered user message', async () => {
    const fixture = createFixture({
      addMessageId: false,
      messageIdPlacement: 'turn-testid',
      wrapRenderedMessage: true,
    });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      observationTimeoutMs: 25,
    });
    const text = '<thread-runtime v=1 format=json>\n{"intent":"rua 大尾巴"}\n</thread-runtime>\n\nrua 大尾巴';

    const result = await adapter.appendMessage({
      requestId: 'request-wrapped-runtime-payload',
      conversationId: 'conversation-7',
      text,
      idempotencyKey: 'source-message-wrapped-runtime-payload',
    });

    assert.equal(result.hostMessageId, 'conversation-turn-1');
    assert.equal(fixture.getSendCount(), 1);
  });

  it('observes the exact runtime payload when ChatGPT collapses only the innerText projection', async () => {
    const prefix = '<thread-runtime v=1 format=json>\n{"intent":"';
    const suffix = '"}\n</thread-runtime>';
    const text = `${prefix}${'x'.repeat(1_131 - prefix.length - suffix.length)}${suffix}`;
    const fixture = createFixture({
      addMessageId: false,
      messageIdPlacement: 'turn-testid',
      wrapRenderedMessage: true,
      renderedInnerText: 'Show full message',
    });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      observationTimeoutMs: 25,
    });

    assert.equal(text.length, 1_131);
    assert.equal('Show full message'.length, 17);
    const result = await adapter.appendMessage({
      requestId: 'request-collapsed-runtime-payload',
      conversationId: 'conversation-7',
      text,
      idempotencyKey: 'source-message-collapsed-runtime-payload',
    });

    assert.equal(result.hostMessageId, 'conversation-turn-1');
    assert.equal(fixture.getSendCount(), 1);
  });

  it('observes the exact runtime payload inside a collapsed bubble with a sibling expand control', async () => {
    const text = '<thread-runtime v=1 format=json>\n{"intent":"rua 小猫脚"}\n</thread-runtime>\n\nrua 小猫脚';
    const fixture = createFixture({
      addMessageId: false,
      messageIdPlacement: 'turn-testid',
      wrapRenderedMessage: true,
      renderedInnerText: 'Show full message',
      renderedAffordanceText: '展开',
    });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      observationTimeoutMs: 25,
    });

    const result = await adapter.appendMessage({
      requestId: 'request-collapsed-runtime-payload-with-affordance',
      conversationId: 'conversation-7',
      text,
      idempotencyKey: 'source-message-collapsed-runtime-payload-with-affordance',
    });

    assert.equal(result.hostMessageId, 'conversation-turn-1');
    assert.equal(fixture.getSendCount(), 1);
  });

  it('does not accept a collapsed bubble whose rendered content container changes the submitted payload', async () => {
    const text = '<thread-runtime v=1 format=json>\n{"intent":"exact"}\n</thread-runtime>\n\nexact';
    const fixture = createFixture({
      addMessageId: false,
      messageIdPlacement: 'turn-testid',
      wrapRenderedMessage: true,
      renderedInnerText: 'Show full message',
      renderedContentText: `${text} `,
      renderedAffordanceText: '展开',
    });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      observationTimeoutMs: 25,
    });

    await assert.rejects(
      adapter.appendMessage({
        requestId: 'request-collapsed-runtime-payload-changed',
        conversationId: 'conversation-7',
        text,
        idempotencyKey: 'source-message-collapsed-runtime-payload-changed',
      }),
      (error) => error.code === 'HOST_MESSAGE_NOT_OBSERVED',
    );
    assert.equal(fixture.getSendCount(), 1);
  });

  it('fails closed when a collapsed bubble exposes duplicate exact rendered content containers', async () => {
    const text = '<thread-runtime v=1 format=json>\n{"intent":"exact"}\n</thread-runtime>\n\nexact';
    const fixture = createFixture({
      addMessageId: false,
      messageIdPlacement: 'turn-testid',
      wrapRenderedMessage: true,
      renderedInnerText: text,
      renderedContentCopies: 2,
      renderedAffordanceText: '展开',
    });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      observationTimeoutMs: 25,
    });

    await assert.rejects(
      adapter.appendMessage({
        requestId: 'request-ambiguous-collapsed-runtime-payload',
        conversationId: 'conversation-7',
        text,
        idempotencyKey: 'source-message-ambiguous-collapsed-runtime-payload',
      }),
      (error) => error.code === 'HOST_MESSAGE_NOT_OBSERVED',
    );
    assert.equal(fixture.getSendCount(), 1);
  });

  it('fails closed when the Host-provided conversation turn ID is not globally unique', async () => {
    const fixture = createFixture({ addMessageId: false, messageIdPlacement: 'turn-testid' });
    const duplicate = fixture.document.createElement('article');
    duplicate.dataset.testid = 'conversation-turn-1';
    fixture.document.querySelector('#messages').append(duplicate);
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      observationTimeoutMs: 25,
    });

    await assert.rejects(
      adapter.appendMessage({
        requestId: 'request-duplicate-turn-testid',
        conversationId: 'conversation-7',
        text: 'duplicate Host turn identifiers must not produce a receipt',
        idempotencyKey: 'source-message-duplicate-turn-testid',
      }),
      (error) => error.code === 'HOST_MESSAGE_NOT_OBSERVED',
    );
  });

  it('captures only the first assistant final causally following the exact dispatched user turn', async () => {
    const fixture = createFixture({ addMessageId: false, messageIdPlacement: 'turn-testid' });
    const messages = fixture.document.querySelector('#messages');
    const historicTurn = fixture.document.createElement('article');
    historicTurn.dataset.testid = 'conversation-turn-historic';
    const historicAssistant = fixture.document.createElement('div');
    historicAssistant.dataset.messageAuthorRole = 'assistant';
    historicAssistant.textContent = 'historic assistant content must never be scanned';
    historicTurn.append(historicAssistant);
    messages.append(historicTurn);

    let resolveObserved;
    const observed = new Promise((resolve) => {
      resolveObserved = resolve;
    });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      observationTimeoutMs: 50,
      assistantObservationTimeoutMs: 250,
      assistantQuietMs: 15,
      onAssistantFinal: (value) => resolveObserved(value),
    });

    const receipt = await adapter.appendMessage({
      requestId: 'request-causal-assistant',
      conversationId: 'conversation-7',
      text: 'capture the exact next assistant turn',
      idempotencyKey: 'source-message-causal-assistant',
    });

    const assistantTurn = fixture.document.createElement('article');
    assistantTurn.dataset.testid = 'conversation-turn-2';
    const assistant = fixture.document.createElement('div');
    assistant.dataset.messageAuthorRole = 'assistant';
    assistant.textContent = 'partial';
    assistantTurn.append(assistant);
    messages.append(assistantTurn);
    setTimeout(() => {
      assistant.textContent = 'the exact ordinary assistant final';
    }, 5);

    assert.equal(receipt.hostMessageId, 'conversation-turn-1');
    assert.deepEqual(await observed, {
      requestId: 'request-causal-assistant',
      conversationId: 'conversation-7',
      idempotencyKey: 'source-message-causal-assistant',
      hostMessageId: 'conversation-turn-1',
      assistantMessageId: 'conversation-turn-2',
      content: 'the exact ordinary assistant final',
    });
  });

  it('re-anchors the causal assistant observer when ChatGPT remounts the source user turn', async () => {
    const fixture = createFixture({ addMessageId: false, messageIdPlacement: 'turn-testid' });
    let resolveObserved;
    const observed = new Promise((resolve) => {
      resolveObserved = resolve;
    });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      observationTimeoutMs: 50,
      assistantObservationTimeoutMs: 80,
      assistantQuietMs: 10,
      onAssistantFinal: (value) => resolveObserved(value),
    });

    await adapter.appendMessage({
      requestId: 'request-remounted-source-turn',
      conversationId: 'conversation-7',
      text: 'survive a React source-turn remount',
      idempotencyKey: 'source-message-remounted-source-turn',
    });
    const sourceTurn = fixture.document.querySelector('[data-testid="conversation-turn-1"]');
    sourceTurn.replaceWith(sourceTurn.cloneNode(true));
    const assistantTurn = fixture.document.createElement('article');
    assistantTurn.dataset.testid = 'conversation-turn-2';
    const assistant = fixture.document.createElement('div');
    assistant.dataset.messageAuthorRole = 'assistant';
    assistant.textContent = 'assistant final after source turn remount';
    assistantTurn.append(assistant);
    fixture.document.querySelector('#messages').append(assistantTurn);

    assert.equal(
      (
        await Promise.race([
          observed,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('remounted source turn was not re-anchored')), 150),
          ),
        ])
      ).content,
      'assistant final after source turn remount',
    );
  });

  it('follows the same Host assistant turn across a streaming remount instead of returning the detached partial', async () => {
    const fixture = createFixture({ addMessageId: false, messageIdPlacement: 'turn-testid' });
    let resolveObserved;
    const observed = new Promise((resolve) => {
      resolveObserved = resolve;
    });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      observationTimeoutMs: 50,
      assistantObservationTimeoutMs: 120,
      assistantQuietMs: 15,
      onAssistantFinal: (value) => resolveObserved(value),
    });
    await adapter.appendMessage({
      requestId: 'request-remounted-assistant-turn',
      conversationId: 'conversation-7',
      text: 'follow the live assistant turn across remount',
      idempotencyKey: 'source-message-remounted-assistant-turn',
    });

    const stopButton = fixture.document.createElement('button');
    stopButton.dataset.testid = 'stop-button';
    fixture.document.body.append(stopButton);
    const assistantTurn = fixture.document.createElement('article');
    assistantTurn.dataset.testid = 'conversation-turn-2';
    const assistant = fixture.document.createElement('div');
    assistant.dataset.messageAuthorRole = 'assistant';
    assistant.textContent = 'detached partial must never escape';
    assistantTurn.append(assistant);
    fixture.document.querySelector('#messages').append(assistantTurn);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const remountedTurn = assistantTurn.cloneNode(true);
    remountedTurn.querySelector('[data-message-author-role="assistant"]').textContent =
      'complete assistant final after streaming remount';
    assistantTurn.replaceWith(remountedTurn);
    stopButton.remove();

    assert.equal((await observed).content, 'complete assistant final after streaming remount');
  });

  it('reports a privacy-safe durable diagnostic when the causal assistant final cannot be identified', async () => {
    const fixture = createFixture({ addMessageId: false, messageIdPlacement: 'turn-testid' });
    let resolveFailure;
    const failed = new Promise((resolve) => {
      resolveFailure = resolve;
    });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      observationTimeoutMs: 50,
      assistantObservationTimeoutMs: 25,
      assistantQuietMs: 10,
      onAssistantObservationFailure: (value) => resolveFailure(value),
    });

    await adapter.appendMessage({
      requestId: 'request-assistant-diagnostic',
      conversationId: 'conversation-7',
      text: 'diagnose the exact assistant observation boundary',
      idempotencyKey: 'source-message-assistant-diagnostic',
    });
    const assistantTurn = fixture.document.createElement('article');
    const assistant = fixture.document.createElement('div');
    assistant.dataset.messageAuthorRole = 'assistant';
    assistant.textContent = 'content exists but the Host does not expose a stable turn identifier';
    assistantTurn.append(assistant);
    fixture.document.querySelector('#messages').append(assistantTurn);

    const failure = await Promise.race([
      failed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('assistant observation failure was swallowed')), 100),
      ),
    ]);
    assert.deepEqual(failure, {
      requestId: 'request-assistant-diagnostic',
      conversationId: 'conversation-7',
      idempotencyKey: 'source-message-assistant-diagnostic',
      hostMessageId: 'conversation-turn-1',
      errorCode: 'ASSISTANT_FINAL_NOT_OBSERVED',
      diagnostic: {
        v: 1,
        userTurnConnected: true,
        anchorTurnFound: true,
        followingTurnCount: 1,
        assistantCandidateCount: 1,
        laterUserTurnPresent: false,
        assistantHostIdStatus: 'missing_or_ambiguous',
        assistantContentStatus: 'present',
        streamingControlPresent: false,
      },
    });
    assert.equal(JSON.stringify(failure).includes('content exists'), false);
  });

  it('does not capture a quiet partial while ChatGPT still exposes the stop-generating control', async () => {
    const fixture = createFixture({ addMessageId: false, messageIdPlacement: 'turn-testid' });
    let resolveObserved;
    const observed = new Promise((resolve) => {
      resolveObserved = resolve;
    });
    const adapter = createChatGptPageAdapter({
      document: fixture.document,
      location: fixture.dom.window.location,
      MutationObserver: fixture.dom.window.MutationObserver,
      observationTimeoutMs: 50,
      assistantObservationTimeoutMs: 250,
      assistantQuietMs: 15,
      onAssistantFinal: (value) => resolveObserved(value),
    });
    await adapter.appendMessage({
      requestId: 'request-streaming-assistant',
      conversationId: 'conversation-7',
      text: 'wait for the complete assistant turn',
      idempotencyKey: 'source-message-streaming-assistant',
    });

    const stopButton = fixture.document.createElement('button');
    stopButton.dataset.testid = 'stop-button';
    fixture.document.body.append(stopButton);
    const assistantTurn = fixture.document.createElement('article');
    assistantTurn.dataset.testid = 'conversation-turn-2';
    const assistant = fixture.document.createElement('div');
    assistant.dataset.messageAuthorRole = 'assistant';
    assistant.textContent = 'quiet but partial';
    assistantTurn.append(assistant);
    fixture.document.querySelector('#messages').append(assistantTurn);
    await new Promise((resolve) => setTimeout(resolve, 35));
    assistant.textContent = 'complete assistant final';
    stopButton.remove();

    assert.equal((await observed).content, 'complete assistant final');
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
