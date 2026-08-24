import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runPersonalChromeInPlaceLiveGate } from '../scripts/f247-personal-chrome-in-place-live-gate.mjs';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function authorizedConversations(...conversationIds) {
  return {
    schemaVersion: 2,
    provider: 'chatgpt',
    conversations: conversationIds.map((conversationId) => ({
      conversationId,
      chatUrl: `https://chatgpt.com/c/${conversationId}`,
      authorizedAt: '2026-08-21T07:00:00.000Z',
      updatedAt: '2026-08-21T07:00:00.000Z',
    })),
    updatedAt: '2026-08-21T07:00:00.000Z',
  };
}

describe('F247 zero-focus Personal Chrome live gate', () => {
  it('contains no browser foreground, window, tab-selection, or navigation automation surface', async () => {
    const source = await readFile(join(apiRoot, 'scripts/f247-personal-chrome-in-place-live-gate.mjs'), 'utf8');

    for (const forbidden of [
      'osascript',
      'execFile',
      'activeTab',
      'activeTabIndex',
      'windows.update',
      'tabs.update',
      'waitForControlTab',
      'TARGET_TAB_RESELECTED',
      'CONTROL_TAB_CHANGED',
    ]) {
      assert.equal(source.includes(forbidden), false, `forbidden foreground automation surface: ${forbidden}`);
    }
  });

  it('reuses the durable exact binding from invocation start through idempotent completion', async () => {
    const calls = [];
    const browserForeground = Object.freeze({ windowId: 4, tabId: 8, url: 'https://example.com/control' });
    const before = structuredClone(browserForeground);

    const result = await runPersonalChromeInPlaceLiveGate({
      adapter: {
        append_message: async (...args) => {
          assert.deepEqual(browserForeground, before);
          calls.push(args);
          return { hostMessageId: 'chatgpt-user-message-live-1' };
        },
      },
      readConversationAuthorizations: async () => authorizedConversations('conversation-7'),
      nonce: 'F247_IN_PLACE_NONCE',
      idempotencyKey: 'f247-in-place-source',
    });

    assert.deepEqual(browserForeground, before);
    assert.deepEqual(calls, [
      ['conversation-7', 'F247_IN_PLACE_NONCE', 'f247-in-place-source'],
      ['conversation-7', 'F247_IN_PLACE_NONCE', 'f247-in-place-source'],
    ]);
    assert.deepEqual(result, {
      status: 'PASS',
      coverage: 'running-owner-chrome-native-messaging-full-seam',
      browserLifecycle: 'untouched',
      foregroundMutation: 'none-by-construction',
      conversationId: 'conversation-7',
      hostMessageId: 'chatgpt-user-message-live-1',
      retryHostMessageId: 'chatgpt-user-message-live-1',
    });
  });

  it('returns typed needs-binding without append or foreground targeting', async () => {
    let appendCalls = 0;
    await assert.rejects(
      runPersonalChromeInPlaceLiveGate({
        adapter: {
          append_message: async () => {
            appendCalls += 1;
            return { hostMessageId: 'must-not-send' };
          },
        },
        readConversationAuthorizations: async () => {
          const error = new Error('bind explicitly');
          error.code = 'NEEDS_AUTHORIZATION';
          throw error;
        },
        nonce: 'F247_IN_PLACE_NONCE',
        idempotencyKey: 'f247-in-place-source',
      }),
      (error) => error?.reason === 'NEEDS_BINDING',
    );
    assert.equal(appendCalls, 0);
  });

  it('never substitutes another conversation when the exact binding cannot receive delivery', async () => {
    const calls = [];
    await assert.rejects(
      runPersonalChromeInPlaceLiveGate({
        adapter: {
          append_message: async (...args) => {
            calls.push(args);
            const error = new Error('bound conversation is not open');
            error.code = 'BOUND_TAB_NOT_FOUND';
            throw error;
          },
        },
        readConversationAuthorizations: async () => authorizedConversations('conversation-17'),
        nonce: 'F247_IN_PLACE_NONCE',
        idempotencyKey: 'f247-in-place-source',
      }),
      (error) => error?.code === 'BOUND_TAB_NOT_FOUND',
    );
    assert.deepEqual(calls, [['conversation-17', 'F247_IN_PLACE_NONCE', 'f247-in-place-source']]);
  });

  it('requires an exact choice when multiple conversations are authorized', async () => {
    let appendCalls = 0;
    await assert.rejects(
      runPersonalChromeInPlaceLiveGate({
        adapter: {
          append_message: async () => {
            appendCalls += 1;
            return { hostMessageId: 'must-not-send' };
          },
        },
        readConversationAuthorizations: async () => authorizedConversations('conversation-17', 'conversation-18'),
        nonce: 'F247_IN_PLACE_NONCE',
        idempotencyKey: 'f247-in-place-source',
      }),
      (error) => error?.reason === 'CONVERSATION_REQUIRED',
    );
    assert.equal(appendCalls, 0);
  });

  it('selects one exact authorized conversation from a multi-conversation collection', async () => {
    const calls = [];
    await runPersonalChromeInPlaceLiveGate({
      adapter: {
        append_message: async (...args) => {
          calls.push(args);
          return { hostMessageId: 'chatgpt-user-message-live-18' };
        },
      },
      readConversationAuthorizations: async () => authorizedConversations('conversation-17', 'conversation-18'),
      conversationId: 'conversation-18',
      nonce: 'F247_IN_PLACE_NONCE',
      idempotencyKey: 'f247-in-place-source',
    });
    assert.deepEqual(calls, [
      ['conversation-18', 'F247_IN_PLACE_NONCE', 'f247-in-place-source'],
      ['conversation-18', 'F247_IN_PLACE_NONCE', 'f247-in-place-source'],
    ]);
  });
});
