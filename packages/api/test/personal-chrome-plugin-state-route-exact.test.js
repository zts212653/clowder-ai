import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectPersonalChromePluginState } from '../scripts/f247-personal-chrome-install.mjs';

const projectRoot = '/tmp/cat-cafe-f247-plugin-state-route-exact';
const extensionId = 'a'.repeat(32);

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
    ],
    updatedAt: '2026-08-21T07:00:00.000Z',
  };
}

test('collection inspection never guesses an authorization while exact-route inspection stays explicit', async () => {
  const observedConversationIds = [];
  const inspect = (conversationId) =>
    inspectPersonalChromePluginState({
      platform: 'darwin',
      projectRoot,
      extensionId,
      conversationId,
      inspectInstallation: async () => ({
        status: 'ready',
        socketPath: '/tmp/cat-cafe-f247.sock',
        hasPairingSecret: true,
      }),
      readAuthorizations: async () => collection(),
      probeLive: async ({ conversationId: probedConversationId }) => {
        observedConversationIds.push(probedConversationId);
        return { status: 'dormant' };
      },
    });

  await inspect(undefined);
  await inspect('conversation-17');
  const unknown = await inspect('conversation-unknown');

  assert.deepEqual(observedConversationIds, [undefined, 'conversation-17']);
  assert.deepEqual(unknown.live, { status: 'degraded', errorCode: 'AUTHORIZATION_NOT_FOUND' });
});
