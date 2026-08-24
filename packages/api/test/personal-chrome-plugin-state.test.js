import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createPersonalChromePluginPort,
  inspectPersonalChromePluginState,
} from '../scripts/f247-personal-chrome-install.mjs';

const projectRoot = '/tmp/cat-cafe-f247-plugin-state';
const extensionId = 'a'.repeat(32);
const listingUrl = `https://chromewebstore.google.com/detail/personal-chatgpt-pro/${extensionId}`;

function readyReceipt() {
  return {
    status: 'ready',
    socketPath: '/tmp/cat-cafe-f247.sock',
    hasPairingSecret: true,
  };
}

function collection() {
  return {
    schemaVersion: 2,
    provider: 'chatgpt',
    conversations: [
      {
        conversationId: 'conversation-17',
        chatUrl: 'https://chatgpt.com/c/conversation-17',
        authorizedAt: '2026-08-21T07:00:00.000Z',
        updatedAt: '2026-08-21T07:00:00.000Z',
      },
      {
        conversationId: 'conversation-18',
        chatUrl: 'https://chatgpt.com/c/conversation-18',
        authorizedAt: '2026-08-21T07:01:00.000Z',
        updatedAt: '2026-08-21T07:01:00.000Z',
      },
    ],
    updatedAt: '2026-08-21T07:01:00.000Z',
  };
}

test('helper-ready reports a publication blocker and an empty authorization collection independently', async () => {
  const state = await inspectPersonalChromePluginState({
    platform: 'darwin',
    projectRoot,
    extensionId,
    inspectInstallation: async () => readyReceipt(),
    readAuthorizations: async () => {
      const error = new Error('authorize one ChatGPT conversation explicitly');
      error.code = 'NEEDS_AUTHORIZATION';
      throw error;
    },
    probeLive: async () => false,
  });

  assert.deepEqual(state, {
    pluginId: 'personal-chrome-host',
    channel: 'developer_preview',
    platform: 'darwin',
    platformSupport: 'supported',
    artifact: { helper: 'ready', extension: 'chrome_web_store' },
    distribution: {
      channel: 'chrome_web_store',
      integration: 'ready',
      publication: 'unavailable',
      blockerCode: 'CHROME_WEB_STORE_LISTING_NOT_CONFIGURED',
    },
    config: { status: 'ready' },
    authorization: { status: 'empty', count: 0, limit: 32, conversations: [] },
    intent: { status: 'developer_preview' },
    live: { status: 'dormant' },
  });
  assert.equal(JSON.stringify(state).includes('/repo/'), false);
});

test('valid Web Store publication and multiple authorizations project only bounded owner-safe metadata', async () => {
  const state = await inspectPersonalChromePluginState({
    platform: 'linux',
    projectRoot,
    extensionId,
    webStoreListingUrl: listingUrl,
    inspectInstallation: async () => readyReceipt(),
    readAuthorizations: async () => collection(),
    probeLive: async () => true,
  });

  assert.deepEqual(state.distribution, {
    channel: 'chrome_web_store',
    integration: 'ready',
    publication: 'published',
    listingUrl,
  });
  assert.deepEqual(state.authorization, {
    status: 'authorized',
    count: 2,
    limit: 32,
    conversations: [
      {
        conversationId: 'conversation-17',
        authorizedAt: '2026-08-21T07:00:00.000Z',
        updatedAt: '2026-08-21T07:00:00.000Z',
      },
      {
        conversationId: 'conversation-18',
        authorizedAt: '2026-08-21T07:01:00.000Z',
        updatedAt: '2026-08-21T07:01:00.000Z',
      },
    ],
  });
  assert.equal(JSON.stringify(state).includes('chatUrl'), false);
  assert.equal(state.live.status, 'connected');
});

test('invalid install, listing, and authorization state are separated without leaking exception detail', async () => {
  let liveProbes = 0;
  const state = await inspectPersonalChromePluginState({
    platform: 'linux',
    projectRoot,
    extensionId,
    webStoreListingUrl: 'https://attacker.example/extension',
    inspectInstallation: async () => {
      throw new Error('pairingSecret=private and manifest corrupt');
    },
    readAuthorizations: async () => {
      throw new Error('conversation authorization collection has mode 0644');
    },
    probeLive: async () => {
      liveProbes += 1;
      return true;
    },
  });

  assert.equal(state.artifact.helper, 'invalid');
  assert.equal(state.config.status, 'invalid');
  assert.equal(state.distribution.publication, 'invalid');
  assert.equal(state.distribution.blockerCode, 'CHROME_WEB_STORE_LISTING_INVALID');
  assert.equal(state.authorization.status, 'invalid');
  assert.deepEqual(state.authorization.conversations, []);
  assert.equal(state.live.status, 'degraded');
  assert.equal(liveProbes, 0);
  assert.equal(JSON.stringify(state).includes('private'), false);
});

test('Windows is a stable unsupported state and performs no installation or authorization reads', async () => {
  let calls = 0;
  const state = await inspectPersonalChromePluginState({
    platform: 'win32',
    projectRoot,
    extensionId,
    webStoreListingUrl: listingUrl,
    inspectInstallation: async () => {
      calls += 1;
      return readyReceipt();
    },
    readAuthorizations: async () => {
      calls += 1;
      return collection();
    },
    probeLive: async () => {
      calls += 1;
      return true;
    },
  });

  assert.equal(calls, 0);
  assert.equal(state.platformSupport, 'unsupported');
  assert.equal(state.artifact.helper, 'unsupported');
  assert.equal(state.config.status, 'unsupported');
  assert.equal(state.authorization.status, 'unsupported');
  assert.equal(state.live.status, 'unsupported');
});

test('install and repair block before Host mutation when the listing is absent or invalid, while cleanup stays available', async () => {
  const blockedActions = [];
  const blockedPort = createPersonalChromePluginPort({
    platform: 'darwin',
    projectRoot,
    extensionId,
    installHost: async () => blockedActions.push('install'),
    uninstallHost: async () => blockedActions.push('uninstall'),
    revokeAuthorization: async (_path, conversationId) => {
      blockedActions.push(`revoke:${conversationId}`);
      return { revoked: true };
    },
    inspectInstallation: async () => null,
    readAuthorizations: async () => {
      const error = new Error('no remaining authorizations');
      error.code = 'NEEDS_AUTHORIZATION';
      throw error;
    },
  });
  await assert.rejects(blockedPort.install(), (error) => error.code === 'CHROME_WEB_STORE_LISTING_NOT_CONFIGURED');
  await assert.rejects(blockedPort.repair(), (error) => error.code === 'CHROME_WEB_STORE_LISTING_NOT_CONFIGURED');
  assert.deepEqual(blockedActions, []);

  const invalidListingPort = createPersonalChromePluginPort({
    platform: 'darwin',
    projectRoot,
    extensionId,
    webStoreListingUrl: 'https://attacker.example/extension',
    installHost: async () => blockedActions.push('install'),
  });
  await assert.rejects(invalidListingPort.repair(), (error) => error.code === 'CHROME_WEB_STORE_LISTING_INVALID');
  assert.deepEqual(blockedActions, []);

  await blockedPort.revoke('conversation-cleanup');
  await blockedPort.uninstall();
  assert.deepEqual(blockedActions, ['revoke:conversation-cleanup', 'uninstall']);
});

test('published install, repair, exact revoke, and uninstall refresh state', async () => {
  const actions = [];
  const port = createPersonalChromePluginPort({
    platform: 'darwin',
    projectRoot,
    extensionId,
    webStoreListingUrl: listingUrl,
    installHost: async () => actions.push('install'),
    uninstallHost: async () => actions.push('uninstall'),
    revokeAuthorization: async (_path, conversationId) => {
      actions.push(`revoke:${conversationId}`);
      return { revoked: true };
    },
    inspectInstallation: async () => readyReceipt(),
    readAuthorizations: async () => collection(),
    probeLive: async () => true,
  });

  const installed = await port.install();
  assert.equal(installed.distribution.listingUrl, listingUrl);
  assert.equal(installed.authorization.count, 2);
  await port.repair();
  await port.revoke('conversation-17');
  await port.uninstall();
  assert.deepEqual(actions, ['install', 'install', 'revoke:conversation-17', 'uninstall']);
});

test('plugin port maps active-helper uninstall to a typed code', async () => {
  const port = createPersonalChromePluginPort({
    platform: 'darwin',
    projectRoot,
    extensionId,
    webStoreListingUrl: listingUrl,
    uninstallHost: async () => {
      throw new Error('personal Chrome helper is active; stop Chrome before uninstall');
    },
  });

  await assert.rejects(port.uninstall(), (error) => error.code === 'HELPER_ACTIVE');
});
