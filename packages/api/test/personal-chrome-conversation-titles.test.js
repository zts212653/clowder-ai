import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  createPersonalChromePluginPort,
  inspectPersonalChromePluginState,
} from '../scripts/f247-personal-chrome-install.mjs';
import {
  authorizePersonalChromeConversation,
  readPersonalChromeConversationAuthorizations,
} from '../src/plugins/cloud-cat-personal-host/native-host/conversation-binding.mjs';
import { createNativeHostBridge } from '../src/plugins/cloud-cat-personal-host/native-host/native-host.mjs';
import {
  resolvePersonalChromeHostPaths,
  writePersonalChromePairingRecordAtomic,
} from '../src/plugins/cloud-cat-personal-host/native-host/pairing-record.mjs';

test('real worker backfills authorized open-tab titles through Native persistence and production plugin projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f247-readable-titles-'));
  const paths = resolvePersonalChromeHostPaths(root, { platform: 'darwin' });
  const stamp = '2026-09-05T10:00:00.000Z';
  await authorizePersonalChromeConversation(paths.conversationBindingPath, {
    conversationId: 'conversation-7',
    chatUrl: 'https://chatgpt.com/c/conversation-7',
    authorizedAt: stamp,
    updatedAt: stamp,
  });
  const before = await readFile(paths.conversationBindingPath, 'utf8');
  let inbound;
  const pending = [];
  const queries = [];
  let currentTitle = '云端小星星接回家';
  const bridge = await createNativeHostBridge({
    socketPath: join(root, 'host.sock'),
    ledgerPath: join(root, 'ledger.json'),
    conversationBindingPath: paths.conversationBindingPath,
    pairingSecret: 'a'.repeat(64),
    helperArtifactRevision: `sha512:${'0'.repeat(128)}`,
    sendNative: async (message) => inbound?.(structuredClone(message)),
  });
  const chrome = {
    runtime: {
      connectNative: () => ({
        onMessage: {
          addListener: (listener) => {
            inbound = listener;
          },
        },
        onDisconnect: { addListener() {} },
        postMessage: (message) => {
          pending.push(bridge.acceptNativeMessage(structuredClone(message)));
        },
      }),
      onMessage: { addListener() {} },
      getManifest: () => ({ version: '0.2.11' }),
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    action: { onClicked: { addListener() {} }, setBadgeText() {}, setTitle() {} },
    tabs: {
      async query(query) {
        queries.push(query);
        return [
          { id: 7, url: 'https://chatgpt.com/c/conversation-7', title: currentTitle },
          { id: 8, url: 'https://chatgpt.com/c/conversation-70', title: 'private unrelated conversation' },
        ];
      },
    },
  };
  try {
    await writePersonalChromePairingRecordAtomic(paths.pairingRecordPath, {
      schemaVersion: 1,
      extensionId: 'a'.repeat(32),
      socketPath: bridge.socketPath,
      ledgerPath: bridge.ledgerPath,
      pairingSecret: 'a'.repeat(64),
      artifactDigest: `sha512:${'0'.repeat(128)}`,
      installedAt: stamp,
      updatedAt: stamp,
    });
    const worker = await readFile(
      new URL('../src/plugins/cloud-cat-personal-host/extension/service-worker.js', import.meta.url),
      'utf8',
    );
    runInNewContext(worker, { chrome, URL, TextEncoder, setTimeout, clearTimeout });
    for (let turn = 0; turn < 10; turn++) {
      await Promise.all(pending.splice(0));
      await new Promise((done) => setTimeout(done, 5));
    }
    const state = await inspectPersonalChromePluginState({
      platform: 'darwin',
      projectRoot: root,
      extensionId: 'a'.repeat(32),
      inspectInstallation: async () => ({ status: 'ready' }),
      probeLive: async () => ({ status: 'dormant' }),
    });
    assert.equal(state.authorization.conversations[0].displayTitle, '云端小星星接回家');
    assert.equal(JSON.stringify(state).includes('private unrelated'), false);
    assert.equal(await readFile(paths.conversationBindingPath, 'utf8'), before, 'presentation cannot mutate authority');
    assert.equal((await readPersonalChromeConversationAuthorizations(paths.conversationBindingPath)).schemaVersion, 2);
    assert.ok(queries.every(({ url }) => url === 'https://chatgpt.com/c/conversation-7*'));
    currentTitle = '现在继续的真实对话';
    const port = createPersonalChromePluginPort({
      platform: 'darwin',
      projectRoot: root,
      extensionId: 'a'.repeat(32),
      inspectInstallation: async () => ({
        status: 'ready',
        artifactDigest: `sha512:${'0'.repeat(128)}`,
        socketPath: bridge.socketPath,
      }),
    });
    const refreshed = await port.refreshTitles();
    assert.equal(
      refreshed.titleSync.status,
      'synced',
      'an explicit refresh must wait for a new Native title observation',
    );
    assert.equal(refreshed.titleSync.updatedCount, 1);
    assert.equal(refreshed.authorization.conversations[0].displayTitle, currentTitle);
    assert.equal(await readFile(paths.conversationBindingPath, 'utf8'), before);
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});
