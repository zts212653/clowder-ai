import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createChatGptPageAdapter } from '../src/plugins/cloud-cat-personal-host/extension/chatgpt-page-adapter.mjs';

// Structure observed in the authenticated Chrome composer on 2026-09-19.
function fixture({ generating = false, duplicate = false, disabled = false, onProgress, adapterOptions = {} } = {}) {
  const dom = new JSDOM(
    `<body><form><button type="submit">Unrelated submit</button></form>
    <form data-chatgpt-composer><div id="prompt-textarea" contenteditable="true"></div>
    <button type="${generating ? 'button' : 'submit'}" aria-label="${generating ? '停止' : '发送'}" ${disabled ? 'disabled' : ''}></button>
    ${duplicate ? '<button type="submit">Another submit</button>' : ''}</form></body>`,
    { url: 'https://chatgpt.com/c/test-conversation' },
  );
  const { document } = dom.window;
  const composer = document.querySelector('#prompt-textarea');
  let mutations = 0;
  let clicks = 0;
  document.execCommand = (command, _ui, text) => {
    mutations++;
    composer.textContent = command === 'delete' ? '' : text;
    return true;
  };
  for (const button of document.querySelectorAll('button'))
    button.addEventListener('click', (event) => {
      event.preventDefault();
      clicks++;
      assert.equal(button.closest('form').hasAttribute('data-chatgpt-composer'), true);
      const turn = document.createElement('article');
      turn.dataset.messageAuthorRole = 'user';
      turn.dataset.messageId = 'host-real-id';
      turn.textContent = composer.textContent;
      document.body.append(turn);
      composer.textContent = '';
    });
  const adapter = createChatGptPageAdapter({
    document,
    location: dom.window.location,
    MutationObserver: dom.window.MutationObserver,
    onProgress: (phase) => onProgress?.(phase, document),
    sendButtonTimeoutMs: 15,
    observationTimeoutMs: 20,
    assistantObservationTimeoutMs: 10,
    ...adapterOptions,
  });
  return { dom, document, composer, adapter, clicks: () => clicks, mutations: () => mutations };
}
const request = {
  requestId: 'request-1',
  conversationId: 'test-conversation',
  text: 'exact source',
  idempotencyKey: 'source-1',
};

test('authenticated submit yields one real Host receipt and replay never clicks twice', async () => {
  const f = fixture();
  const result = await f.adapter.appendMessage(request);
  assert.equal(result.hostMessageId, 'host-real-id');
  assert.deepEqual(await f.adapter.appendMessage(request), result);
  assert.equal(f.clicks(), 1);
  f.dom.window.close();
});
test('generation is detected before any composer mutation or button click', async () => {
  const f = fixture({ generating: true });
  await assert.rejects(f.adapter.appendMessage(request), (error) => {
    assert.equal(error.code, 'CHATGPT_GENERATING');
    assert.equal(error.diagnostic?.fingerprint.phase, 'failed_before_submit');
    return true;
  });
  assert.equal(f.mutations(), 0);
  assert.equal(f.clicks(), 0);
  f.dom.window.close();
});
test('a control changing during insertion is never clicked and input is restored', async () => {
  const f = fixture({
    onProgress: (phase, document) => {
      if (phase !== 'inserted') return;
      const button = document.querySelector('[data-chatgpt-composer] button');
      button.type = 'button';
      button.setAttribute('aria-label', '停止');
    },
  });
  await assert.rejects(f.adapter.appendMessage(request), { code: 'CHATGPT_GENERATING' });
  assert.equal(f.clicks(), 0);
  assert.equal(f.composer.textContent, '');
  f.dom.window.close();
});
test('two composer submit candidates fail closed', async () => {
  const f = fixture({ duplicate: true });
  await assert.rejects(f.adapter.appendMessage(request), { code: 'SEND_BUTTON_AMBIGUOUS' });
  assert.equal(f.clicks(), 0);
  assert.equal(f.composer.textContent, '');
  f.dom.window.close();
});
test('disabled authenticated submit remains unsent and restores input', async () => {
  const f = fixture({ disabled: true });
  await assert.rejects(f.adapter.appendMessage(request), { code: 'SEND_BUTTON_DISABLED' });
  assert.equal(f.clicks(), 0);
  assert.equal(f.composer.textContent, '');
  f.dom.window.close();
});
test('an owner draft is preserved and unrelated form submit is never clicked', async () => {
  const f = fixture();
  f.composer.textContent = 'owner draft';
  await assert.rejects(f.adapter.appendMessage(request), { code: 'COMPOSER_NOT_EMPTY' });
  assert.equal(f.composer.textContent, 'owner draft');
  assert.equal(f.clicks(), 0);
  assert.equal(f.mutations(), 0);
  f.dom.window.close();
});

test('modern generating control also prevents publishing a quiet partial assistant reply', async () => {
  const finals = [];
  const f = fixture({
    adapterOptions: {
      assistantObservationTimeoutMs: 250,
      assistantQuietMs: 10,
      onAssistantFinal: (value) => finals.push(value),
    },
  });
  await f.adapter.appendMessage(request);
  const control = f.document.querySelector('[data-chatgpt-composer] button');
  control.type = 'button';
  control.setAttribute('aria-label', '停止');
  const assistant = f.document.createElement('article');
  assistant.dataset.messageAuthorRole = 'assistant';
  assistant.dataset.messageId = 'assistant-id';
  assistant.textContent = 'partial';
  f.document.body.append(assistant);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(finals, []);
  assistant.textContent = 'complete';
  control.remove();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(finals.length, 1);
  assert.equal(finals[0].content, 'complete');
  f.dom.window.close();
});
