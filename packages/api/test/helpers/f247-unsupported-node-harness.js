import { JSDOM } from 'jsdom';

import { createChatGptPageAdapter } from '../../src/plugins/cloud-cat-personal-host/extension/chatgpt-page-adapter.mjs';

export function createUnsupportedNodeHarness({ mutateAfterInsert } = {}) {
  const dom = new JSDOM(
    `<!doctype html><body>
      <main id="messages"></main>
      <div id="prompt-textarea" class="ProseMirror" contenteditable="true" data-virtualkeyboard="true"><p data-placeholder="redacted"></p></div>
      <button data-testid="send-button">Send</button>
    </body>`,
    { url: 'https://chatgpt.com/c/conversation-product-chain', pretendToBeVisual: true },
  );
  const document = dom.window.document;
  const composer = document.querySelector('#prompt-textarea');
  const sendButton = document.querySelector('[data-testid="send-button"]');
  let sendCount = 0;
  sendButton.addEventListener('click', () => {
    sendCount += 1;
  });
  document.execCommand = (command, _showUi, value) => {
    if (command === 'insertText') {
      const paragraph = document.createElement('p');
      paragraph.textContent = value;
      composer.replaceChildren(paragraph);
      return true;
    }
    if (command === 'delete') {
      const paragraph = document.createElement('p');
      paragraph.dataset.placeholder = 'redacted';
      composer.replaceChildren(paragraph);
      return true;
    }
    return false;
  };
  const adapter = createChatGptPageAdapter({
    document,
    location: dom.window.location,
    MutationObserver: dom.window.MutationObserver,
    adapterRevision: '2026-08-27.1',
    artifactRevision: '0.2.2',
    async onProgress(status) {
      if (status !== 'inserted') return;
      if (mutateAfterInsert) {
        mutateAfterInsert({ composer, document });
        return;
      }
      const comment = document.createComment('must never enter diagnostics');
      const heading = document.createElement('h1');
      composer.replaceChildren(comment, heading);
    },
  });
  return { adapter, composer, document, getSendCount: () => sendCount };
}
