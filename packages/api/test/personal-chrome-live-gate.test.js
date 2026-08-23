import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildNotObservedLiveGateResult,
  conversationIdFromChatGptUrl,
  extensionIdFromManifestKey,
  extensionIdFromWorkerUrl,
  isolatedLiveGateProjectRoot,
  LiveGateNotObservedError,
  verifyLiveDelivery,
} from '../scripts/f247-personal-chrome-live-contract.mjs';
import {
  defaultChromeUserDataDirectory,
  inspectChromeProfileLock,
  resolveChromeProfile,
} from '../scripts/f247-personal-chrome-profile.mjs';

describe('F247 logged-in Personal Chrome live gate orchestration', () => {
  it('extracts only exact extension and bound-conversation identities', () => {
    assert.equal(extensionIdFromWorkerUrl(`chrome-extension://${'a'.repeat(32)}/service-worker.js`), 'a'.repeat(32));
    assert.equal(extensionIdFromWorkerUrl('https://chatgpt.com/c/nope'), null);
    assert.equal(conversationIdFromChatGptUrl('https://chatgpt.com/c/conversation-7'), 'conversation-7');
    assert.equal(conversationIdFromChatGptUrl('https://chatgpt.com/c/conversation-7/share'), null);
    assert.equal(conversationIdFromChatGptUrl('https://example.com/c/conversation-7'), null);
    assert.equal(
      extensionIdFromManifestKey(
        'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlgM1q4v6VL4SktWwZeydrLSVL0WW9cxZaCTbFi95GdNloO2oF3awS2yW4kYRh1cuqe9YpkGupr9/e2jmjU8wnvnxRtZRVUmsW1Fxx9KMYpGpXdWuQrc6d6wCWZ0Fa+YU3gORUBEASx47lEMYnF30sCGOHPw5brna2Vz/kfKzLTt5JX7kpshUCpYXZrrisLOJyMxBCSblXO+TP039UMHnvRifiiM5bFZPgfZFeDhiqt9Ye7omm16i8MxLhRqyirfVYtD1Cq5CYuRMqL3aFziwR4WkSN3cyI8AdTk9TYiYa3QzCSwGtENR5PZGo/cLubjOfOBRJVGo7A/75Bj0izrnGwIDAQAB',
      ),
      'mjpbglbfkbjhnamnafkodgdpgfhjoife',
    );
    assert.throws(() => extensionIdFromManifestKey('not-base64'), /manifest key/);
  });

  it('keeps live-gate Host activation inside the disposable Chrome profile', () => {
    assert.equal(
      isolatedLiveGateProjectRoot('/tmp/cat-cafe-f247-live-profile-123'),
      '/tmp/cat-cafe-f247-live-profile-123/cat-cafe-host-root',
    );
    assert.throws(() => isolatedLiveGateProjectRoot('  /tmp/profile'), /exact path/);
  });

  it('resolves a registered owner profile without reading its account or cookies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cat-cafe-f247-profile-'));
    try {
      await mkdir(join(root, 'Profile 1'));
      await writeFile(
        join(root, 'Local State'),
        JSON.stringify({ profile: { info_cache: { 'Profile 1': { name: 'Lysander', user_name: 'private' } } } }),
      );
      assert.deepEqual(await resolveChromeProfile({ userDataDirectory: root, profileDirectory: 'Profile 1' }), {
        userDataDirectory: root,
        profileDirectory: 'Profile 1',
        profileName: 'Lysander',
      });
      assert.equal(
        defaultChromeUserDataDirectory({ platform: 'darwin', homeDirectory: '/home/user' }),
        '/home/user/Library/Application Support/Google/Chrome',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed while the owner Chrome profile root is held by a live process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cat-cafe-f247-lock-'));
    try {
      await symlink('host-4242', join(root, 'SingletonLock'));
      assert.deepEqual(await inspectChromeProfileLock(root, { isProcessAlive: (pid) => pid === 4242 }), {
        inUse: true,
        lockPath: join(root, 'SingletonLock'),
        ownerPid: 4242,
      });
      assert.deepEqual(await inspectChromeProfileLock(root, { isProcessAlive: () => false }), {
        inUse: false,
        lockPath: join(root, 'SingletonLock'),
        ownerPid: 4242,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses one exact source key twice and requires one receipt with no focus change', async () => {
    const calls = [];
    const activeTabs = [41, 41, 41];
    const adapter = {
      append_message: async (...args) => {
        calls.push(args);
        return { hostMessageId: 'chatgpt-user-message-live-1' };
      },
    };

    const result = await verifyLiveDelivery({
      adapter,
      conversationId: 'conversation-7',
      text: 'F247_LIVE_NONCE',
      idempotencyKey: 'source-message-live',
      readActiveTabId: async () => activeTabs.shift(),
    });

    assert.deepEqual(calls, [
      ['conversation-7', 'F247_LIVE_NONCE', 'source-message-live'],
      ['conversation-7', 'F247_LIVE_NONCE', 'source-message-live'],
    ]);
    assert.deepEqual(result, {
      hostMessageId: 'chatgpt-user-message-live-1',
      retryHostMessageId: 'chatgpt-user-message-live-1',
      activeTabBefore: 41,
      activeTabAfter: 41,
      activeTabPreserved: true,
    });
  });

  it('fails when retry truth or active-tab truth diverges', async () => {
    let call = 0;
    await assert.rejects(
      verifyLiveDelivery({
        adapter: {
          append_message: async () => ({ hostMessageId: `host-${++call}` }),
        },
        conversationId: 'conversation-7',
        text: 'F247_LIVE_NONCE',
        idempotencyKey: 'source-message-live',
        readActiveTabId: async () => 41,
      }),
      /retry receipt/,
    );
    const activeTabs = [41, 42];
    await assert.rejects(
      verifyLiveDelivery({
        adapter: { append_message: async () => ({ hostMessageId: 'same-host' }) },
        conversationId: 'conversation-7',
        text: 'F247_LIVE_NONCE',
        idempotencyKey: 'source-message-live',
        readActiveTabId: async () => activeTabs.shift(),
      }),
      /active tab changed/,
    );
  });

  it('reports an unselected logged-in conversation as typed NOT_OBSERVED after cleanup', () => {
    const result = buildNotObservedLiveGateResult(
      new LiveGateNotObservedError('LOGIN_CONVERSATION_NOT_OBSERVED', 'one logged-in ChatGPT conversation timed out'),
      {
        extensionId: 'mjpbglbfkbjhnamnafkodgdpgfhjoife',
        installReceipt: { operation: 'installed' },
        helperStarted: true,
      },
    );

    assert.deepEqual(result, {
      status: 'NOT_OBSERVED',
      reason: 'LOGIN_CONVERSATION_NOT_OBSERVED',
      detail: 'one logged-in ChatGPT conversation timed out',
      helperStarted: true,
      extensionId: 'mjpbglbfkbjhnamnafkodgdpgfhjoife',
      cleanup: 'complete',
    });
    assert.equal(buildNotObservedLiveGateResult(new Error('product failure')), null);
  });
});
