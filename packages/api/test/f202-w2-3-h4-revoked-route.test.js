/**
 * F202 W2-3 h4 — a thread routed to a ChatGPT conversation the owner has since revoked asks for a
 * binding again instead of failing (ledger「W2-3 细则」③ and slice h4).
 *
 * Revoke removes the conversation from the package's authorization list; the thread's Host route
 * (`cloudBinding:<catId>`) still points at it. The native host refuses the append before ledger
 * admission or any Chrome dispatch and answers BOUND_CONVERSATION_MISMATCH. The Host dispatch mapped
 * only NEEDS_BINDING to needs-binding, so this case surfaced as host-append-failed and the owner never
 * got the recovery card that lets them pick an authorized conversation.
 *
 * The chain here is real end to end on the Host side: authorization file → native host bridge →
 * PersonalChromeHostAdapter → CloudInvokeBridge. Only Chrome itself is absent; the bridge's
 * `sendNative` records every frame that would reach it.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { CloudInvokeBridge } from '../dist/domains/cats/services/cloud-bridge/cloud-invoke-bridge.js';
import { PersonalChromeHostAdapter } from '../dist/domains/cats/services/cloud-bridge/personal-chrome-host/personal-chrome-host-adapter.js';
import {
  authorizePersonalChromeConversation,
  readPersonalChromeConversationAuthorizations,
  revokePersonalChromeConversation,
} from '../src/plugins/cloud-cat-personal-host/native-host/conversation-binding.mjs';
import { createNativeHostBridge } from '../src/plugins/cloud-cat-personal-host/native-host/native-host.mjs';
import { loadLedger } from '../src/plugins/cloud-cat-personal-host/native-host/native-ledger.mjs';

const helperArtifactRevision = `sha512:${'0'.repeat(128)}`;
const pairingSecret = 'b'.repeat(64);
const CONVERSATION = 'conversation-9';
const ROUTE = `https://chatgpt.com/c/${CONVERSATION}`;

const params = {
  catId: 'gpt-pro',
  threadId: 'thread_t1',
  userId: 'alice',
  threadTitle: 'demo',
  participants: [
    { catId: 'opus-47', handle: '@opus47' },
    { catId: 'gpt-pro', handle: '@gpt-pro' },
  ],
  calledBy: 'opus-47',
  intent: 'help me',
  sourceMessageId: 'source-message-h4',
};

describe('F202 W2-3 h4 — a revoked route asks for a binding', () => {
  const roots = [];
  after(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  it('routes T→A, revokes A, and @gpt-pro gets needs-binding with nothing sent to Chrome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'f202-h4-'));
    roots.push(root);
    const paths = {
      socketPath: join(root, 'host.sock'),
      ledgerPath: join(root, 'ledger.json'),
      conversationBindingPath: join(root, 'conversation-binding.json'),
    };
    await authorizePersonalChromeConversation(paths.conversationBindingPath, {
      conversationId: CONVERSATION,
      chatUrl: ROUTE,
      authorizedAt: '2026-09-25T12:00:00.000Z',
      updatedAt: '2026-09-25T12:00:00.000Z',
    });
    await revokePersonalChromeConversation(paths.conversationBindingPath, CONVERSATION, '2026-09-25T12:01:00.000Z');
    const remaining = await readPersonalChromeConversationAuthorizations(paths.conversationBindingPath, {
      migrateLegacy: false,
    }).catch(() => ({ conversations: [] }));
    assert.deepEqual(
      remaining.conversations.map(({ conversationId }) => conversationId),
      [],
      'A is no longer authorized',
    );

    const forwarded = [];
    const host = await createNativeHostBridge({
      ...paths,
      helperArtifactRevision,
      pairingSecret,
      sendNative: (message) => forwarded.push(message),
    });
    try {
      const routes = { 'gpt-pro': ROUTE };
      const fallbacks = [];
      const bridge = new CloudInvokeBridge({
        hostAdapter: new PersonalChromeHostAdapter({
          socketPath: paths.socketPath,
          pairingSecret,
          helperArtifactRevision,
          requestId: () => 'h4-request-1',
        }),
        emitFallback: async (fallback) => {
          fallbacks.push(fallback);
        },
        threadStore: {
          get: async () => ({ id: 'thread_t1', title: 'demo', participants: ['opus-47', 'gpt-pro'] }),
          getCloudCatBindings: async () => ({ ...routes }),
          updateCloudCatBinding: async (_threadId, catId, chatUrl) => {
            routes[catId] = chatUrl;
          },
        },
      });

      const outcome = await bridge.dispatchInternal(params);

      assert.equal(outcome.kind, 'fallback', `outcome was ${outcome.kind}/${outcome.reason}`);
      assert.equal(outcome.reason, 'needs-binding');
      assert.deepEqual(
        fallbacks.map(({ reason }) => reason),
        ['needs-binding'],
        'exactly one needs-binding fallback: the recovery card',
      );
      assert.deepEqual(forwarded, [], 'nothing reached Chrome');
      assert.equal((await loadLedger(paths.ledgerPath)).size, 0, 'nothing was admitted to the delivery ledger');
    } finally {
      await host.stop();
    }
  });
});
