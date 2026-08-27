import { isPersonalChromeConversationId } from '../src/plugins/cloud-cat-personal-host/native-host/conversation-binding.mjs';

export function parsePersonalChromeInstallArguments(argv) {
  const conversationIdIndex = argv.indexOf('--conversation-id');
  return {
    action: argv[0] ?? 'install',
    conversationId: conversationIdIndex === -1 ? undefined : argv[conversationIdIndex + 1],
    conversationIdOptionPresent: conversationIdIndex !== -1,
  };
}

export function assertPersonalChromeConversationOption({ conversationId, optionPresent }) {
  if (!optionPresent) return;
  if (typeof conversationId !== 'string' || !conversationId || conversationId.startsWith('--')) {
    throw new Error('--conversation-id requires a value');
  }
  if (!isPersonalChromeConversationId(conversationId)) {
    throw new Error('--conversation-id has an invalid format');
  }
}
