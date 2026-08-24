import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { PersonalChromeHostAdapter } from '../dist/domains/cats/services/cloud-bridge/personal-chrome-host/personal-chrome-host-adapter.js';
import { readPersonalChromeConversationAuthorizations } from '../src/plugins/cloud-cat-personal-host/native-host/conversation-binding.mjs';
import {
  encodeNativeMessage,
  NativeMessageDecoder,
} from '../src/plugins/cloud-cat-personal-host/native-host/native-framing.mjs';
import { createNativeHostBridge } from '../src/plugins/cloud-cat-personal-host/native-host/native-host.mjs';
import { loadLedger } from '../src/plugins/cloud-cat-personal-host/native-host/native-ledger.mjs';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const serviceWorkerPath = join(apiRoot, 'src/plugins/cloud-cat-personal-host/extension/service-worker.js');
const nativeHostName = 'ai.catcafe.personal_cloud_cat_host';

function roundTripNativeFrame(message) {
  const decoder = new NativeMessageDecoder();
  const decoded = decoder.push(encodeNativeMessage(message));
  decoder.finish();
  assert.equal(decoded.length, 1);
  return decoded[0];
}

describe('Personal Chrome Native Messaging full seam', () => {
  it('reports a bounded native host discovery failure without leaking browser error details', async () => {
    const serviceWorkerSource = await readFile(serviceWorkerPath, 'utf8');
    const disconnectListeners = [];
    const warnings = [];
    const chrome = {
      runtime: {
        connectNative() {
          return {
            onMessage: { addListener() {} },
            onDisconnect: {
              addListener(listener) {
                disconnectListeners.push(listener);
              },
            },
          };
        },
        lastError: null,
        onMessage: { addListener() {} },
      },
      action: {
        onClicked: { addListener() {} },
        setBadgeText() {},
        setTitle() {},
      },
      tabs: {},
    };
    const sandbox = {
      chrome,
      URL,
      TextEncoder,
      clearTimeout() {},
      console: {
        warn(...args) {
          warnings.push(args);
        },
      },
      setTimeout() {},
    };

    runInNewContext(serviceWorkerSource, sandbox);
    assert.equal(disconnectListeners.length, 1);
    chrome.runtime.lastError = { message: 'Specified native messaging host not found.' };
    disconnectListeners[0]();

    assert.deepEqual(warnings, [['F247_NATIVE_HOST_DISCONNECTED', 'HOST_NOT_FOUND']]);
    assert.equal(sandbox.__f247NativeHealth.lastErrorCode, 'HOST_NOT_FOUND');
  });

  it('consumes a stale startup binding status after an explicit click instead of treating it as an append', async () => {
    const serviceWorkerSource = await readFile(serviceWorkerPath, 'utf8');
    const inboundListeners = [];
    const actionClickListeners = [];
    const outbound = [];
    const chrome = {
      runtime: {
        connectNative() {
          return {
            onMessage: { addListener: (listener) => inboundListeners.push(listener) },
            onDisconnect: { addListener() {} },
            postMessage: (message) => outbound.push(message),
          };
        },
        onMessage: { addListener() {} },
      },
      action: {
        onClicked: { addListener: (listener) => actionClickListeners.push(listener) },
        setBadgeText() {},
        setTitle() {},
      },
      tabs: {},
    };

    runInNewContext(serviceWorkerSource, { chrome, URL, TextEncoder, setTimeout() {}, clearTimeout() {} });
    const query = outbound[0];
    await actionClickListeners[0]({ id: 73, url: 'https://chatgpt.com/c/conversation-7' });
    inboundListeners[0]({
      v: 1,
      kind: 'binding_status',
      requestId: query.requestId,
      status: 'unbound',
      errorCode: 'NEEDS_BINDING',
    });
    await Promise.resolve();

    assert.deepEqual(
      outbound.map((message) => message.kind),
      ['query_binding', 'bind_conversation'],
    );
  });

  it('round-trips two thread-routed conversations independently and retry-idempotently', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f247-native-seam-'));
    const socketPath = join(testRoot, 'personal-host.sock');
    const ledgerPath = join(testRoot, 'receipts.json');
    const conversationBindingPath = join(testRoot, 'conversation-binding.json');
    const pairingSecret = 's'.repeat(64);
    const serviceWorkerSource = await readFile(serviceWorkerPath, 'utf8');
    const nativeInboundListeners = [];
    const nativeReturnWrites = [];
    const connectedHostNames = [];
    const actionClickListeners = [];
    let bridge;
    let tabSendCount = 0;

    const nativePort = {
      onMessage: {
        addListener(listener) {
          nativeInboundListeners.push(listener);
        },
      },
      onDisconnect: {
        addListener() {
          // The integration keeps the port connected for the test lifetime.
        },
      },
      postMessage(message) {
        nativeReturnWrites.push(bridge.acceptNativeMessage(roundTripNativeFrame(message)));
      },
    };
    const chrome = {
      runtime: {
        connectNative(name) {
          connectedHostNames.push(name);
          return nativePort;
        },
        onMessage: {
          addListener() {
            // Content-script progress uses this channel in Chrome; the host result
            // in this fixture is returned by the tab message itself.
          },
        },
      },
      action: {
        onClicked: {
          addListener(listener) {
            actionClickListeners.push(listener);
          },
        },
        setBadgeText() {},
        setTitle() {},
      },
      tabs: {
        async query({ url }) {
          const conversationId = url.includes('conversation-8') ? 'conversation-8' : 'conversation-7';
          return [
            { id: conversationId === 'conversation-8' ? 74 : 73, url: `https://chatgpt.com/c/${conversationId}` },
          ];
        },
        async sendMessage(tabId, request) {
          assert.equal(tabId, request.conversationId === 'conversation-8' ? 74 : 73);
          tabSendCount += 1;
          return {
            v: 1,
            kind: 'append_result',
            requestId: request.requestId,
            idempotencyKey: request.idempotencyKey,
            status: 'host_observed',
            hostMessageId: `chatgpt-user-message-${request.conversationId}`,
          };
        },
      },
    };

    try {
      bridge = await createNativeHostBridge({
        socketPath,
        ledgerPath,
        conversationBindingPath,
        pairingSecret,
        sendNative: async (message) => {
          assert.ok(nativeInboundListeners.length >= 1, 'service worker must connect its Native Messaging listener');
          nativeInboundListeners.at(-1)(roundTripNativeFrame(message));
        },
      });
      const sandbox = { chrome, URL, TextEncoder, setTimeout, clearTimeout };
      runInNewContext(serviceWorkerSource, sandbox);
      assert.deepEqual(connectedHostNames, [nativeHostName]);
      assert.equal(typeof chrome.tabs.sendMessage, 'function');
      assert.equal(actionClickListeners.length, 1, 'the extension must expose one explicit binding action');

      await actionClickListeners[0]({ id: 73, url: 'https://chatgpt.com/c/conversation-7?model=auto' });
      await actionClickListeners[0]({ id: 74, url: 'https://chatgpt.com/c/conversation-8' });
      await Promise.all(nativeReturnWrites);
      const storedAuthorizations = await readPersonalChromeConversationAuthorizations(conversationBindingPath);
      assert.deepEqual(storedAuthorizations.conversations.map((entry) => entry.conversationId).sort(), [
        'conversation-7',
        'conversation-8',
      ]);
      const authorizationById = new Map(
        storedAuthorizations.conversations.map((entry) => [entry.conversationId, entry]),
      );
      assert.match(authorizationById.get('conversation-7').authorizedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(sandbox.__f247ConversationBinding.status, 'bound');
      assert.equal(sandbox.__f247ConversationBinding.conversationId, 'conversation-8');
      assert.equal(sandbox.__f247ConversationBinding.boundAt, authorizationById.get('conversation-8').authorizedAt);
      assert.equal(sandbox.__f247ConversationBinding.errorCode, null);

      const restartedSandbox = { chrome, URL, TextEncoder, setTimeout, clearTimeout };
      runInNewContext(serviceWorkerSource, restartedSandbox);
      await Promise.all(nativeReturnWrites);
      assert.equal(restartedSandbox.__f247ConversationBinding.status, 'bound');
      const restartedConversationId = restartedSandbox.__f247ConversationBinding.conversationId;
      assert.ok(authorizationById.has(restartedConversationId));
      assert.equal(
        restartedSandbox.__f247ConversationBinding.boundAt,
        authorizationById.get(restartedConversationId).authorizedAt,
      );
      assert.equal(restartedSandbox.__f247ConversationBinding.errorCode, null);

      let requestIndex = 0;
      const adapter = new PersonalChromeHostAdapter({
        socketPath,
        pairingSecret,
        requestId: () => `full-seam-request-${++requestIndex}`,
      });
      const firstA = await adapter.append_message(
        'conversation-7',
        'F247_NATIVE_MESSAGING_FULL_SEAM_NONCE_A',
        'source-thread-a',
      );
      const firstB = await adapter.append_message(
        'conversation-8',
        'F247_NATIVE_MESSAGING_FULL_SEAM_NONCE_B',
        'source-thread-b',
      );
      const retryA = await adapter.append_message(
        'conversation-7',
        'F247_NATIVE_MESSAGING_FULL_SEAM_NONCE_A',
        'source-thread-a',
      );
      const retryB = await adapter.append_message(
        'conversation-8',
        'F247_NATIVE_MESSAGING_FULL_SEAM_NONCE_B',
        'source-thread-b',
      );
      await Promise.all(nativeReturnWrites);

      assert.deepEqual(firstA, { hostMessageId: 'chatgpt-user-message-conversation-7' });
      assert.deepEqual(firstB, { hostMessageId: 'chatgpt-user-message-conversation-8' });
      assert.deepEqual(retryA, firstA);
      assert.deepEqual(retryB, firstB);
      assert.equal(tabSendCount, 2, 'durable idempotency must dispatch each conversation only once');
      assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
      const ledger = await loadLedger(ledgerPath);
      assert.equal(ledger.size, 2);
      assert.deepEqual(
        [...ledger.values()].map((entry) => [entry.conversationId, entry.state]),
        [
          ['conversation-7', 'host_observed'],
          ['conversation-8', 'host_observed'],
        ],
      );
    } finally {
      await bridge?.stop();
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});
