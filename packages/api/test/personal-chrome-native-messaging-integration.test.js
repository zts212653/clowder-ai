import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { PersonalChromeHostAdapter } from '../dist/domains/cats/services/cloud-bridge/personal-chrome-host/personal-chrome-host-adapter.js';
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
  it('round-trips adapter → socket bridge → framed native port → service worker → tab receipt', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f247-native-seam-'));
    const socketPath = join(testRoot, 'personal-host.sock');
    const ledgerPath = join(testRoot, 'receipts.json');
    const pairingSecret = 's'.repeat(64);
    const serviceWorkerSource = await readFile(serviceWorkerPath, 'utf8');
    const nativeInboundListeners = [];
    const nativeReturnWrites = [];
    const connectedHostNames = [];
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
      tabs: {
        async query() {
          return [{ id: 73, url: 'https://chatgpt.com/c/conversation-7' }];
        },
        async sendMessage(tabId, request) {
          assert.equal(tabId, 73);
          tabSendCount += 1;
          return {
            v: 1,
            kind: 'append_result',
            requestId: request.requestId,
            idempotencyKey: request.idempotencyKey,
            status: 'host_observed',
            hostMessageId: 'chatgpt-user-message-full-seam-42',
          };
        },
      },
    };

    try {
      bridge = await createNativeHostBridge({
        socketPath,
        ledgerPath,
        pairingSecret,
        sendNative: async (message) => {
          assert.equal(nativeInboundListeners.length, 1, 'service worker must connect its Native Messaging listener');
          nativeInboundListeners[0](roundTripNativeFrame(message));
        },
      });
      runInNewContext(serviceWorkerSource, { chrome, URL, TextEncoder, setTimeout, clearTimeout });
      assert.deepEqual(connectedHostNames, [nativeHostName]);
      assert.equal(typeof chrome.tabs.sendMessage, 'function');

      let requestIndex = 0;
      const adapter = new PersonalChromeHostAdapter({
        socketPath,
        pairingSecret,
        requestId: () => `full-seam-request-${++requestIndex}`,
      });
      const first = await adapter.append_message(
        'conversation-7',
        'F247_NATIVE_MESSAGING_FULL_SEAM_NONCE',
        'source-message-full-seam',
      );
      const retry = await adapter.append_message(
        'conversation-7',
        'F247_NATIVE_MESSAGING_FULL_SEAM_NONCE',
        'source-message-full-seam',
      );
      await Promise.all(nativeReturnWrites);

      assert.deepEqual(first, { hostMessageId: 'chatgpt-user-message-full-seam-42' });
      assert.deepEqual(retry, first);
      assert.equal(tabSendCount, 1, 'durable idempotency must prevent a second tab dispatch');
      assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
      const ledger = await loadLedger(ledgerPath);
      assert.equal(ledger.size, 1);
      assert.equal([...ledger.values()][0].state, 'host_observed');
    } finally {
      await bridge?.stop();
      await rm(testRoot, { recursive: true, force: true });
    }
  });
});
