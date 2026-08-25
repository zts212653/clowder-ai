import { SettingsDeleteButton } from './primitives/SettingsDeleteButton';
import { SettingsText } from './primitives/SettingsText';

export interface PersonalChromeAuthorizedConversation {
  conversationId: string;
  authorizedAt: string;
  updatedAt: string;
}

export function PersonalChromeAuthorizationList({
  conversations,
  count,
  limit,
  busy,
  onRevoke,
}: {
  conversations: PersonalChromeAuthorizedConversation[];
  count: number;
  limit: number;
  busy: boolean;
  onRevoke: (conversationId: string) => void;
}) {
  if (conversations.length === 0) {
    return (
      <div className="mt-3 rounded-lg bg-[var(--console-hover-bg)] px-3 py-2">
        <SettingsText as="p" tone="secondary" className="font-medium">
          Host 会话授权
        </SettingsText>
        <SettingsText as="p" tone="secondary">
          在目标 ChatGPT 会话点击“授权此会话”；不同 Clowder AI thread 可分别路由到不同已授权会话。
        </SettingsText>
      </div>
    );
  }

  return (
    <section className="mt-3" aria-label="已授权 ChatGPT 会话">
      <SettingsText as="p" tone="secondary" className="mb-1.5 font-medium">
        Host 会话授权 · 已授权会话（{count}/{limit}）
      </SettingsText>
      <ul className="grid max-h-48 gap-1.5 overflow-y-auto">
        {conversations.map((conversation) => (
          <li
            key={conversation.conversationId}
            className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-[var(--console-hover-bg)] px-3 py-2"
          >
            <SettingsText
              as="code"
              tone="secondary"
              className="min-w-0 break-all font-mono"
              title={conversation.conversationId}
            >
              {conversation.conversationId}
            </SettingsText>
            <SettingsDeleteButton
              disabled={busy}
              aria-label={`撤销会话 ${conversation.conversationId}`}
              onClick={() => onRevoke(conversation.conversationId)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
