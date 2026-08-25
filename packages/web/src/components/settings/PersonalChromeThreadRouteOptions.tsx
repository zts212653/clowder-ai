import type { PersonalChromeAuthorizedConversation } from './PersonalChromeAuthorizationList';
import { SettingsSecondaryButton } from './primitives/SettingsSecondaryButton';
import { SettingsText } from './primitives/SettingsText';

export function PersonalChromeThreadRouteOptions({
  conversations,
  boundConversationId,
  hasBinding,
  disabled,
  busyConversationId,
  onSelect,
}: {
  conversations: readonly PersonalChromeAuthorizedConversation[];
  boundConversationId: string | null;
  hasBinding: boolean;
  disabled: boolean;
  busyConversationId: string | null;
  onSelect: (conversationId: string | null) => void;
}) {
  return (
    <div className="mt-2 grid gap-1.5">
      {conversations.map((conversation) => {
        const isCurrent = conversation.conversationId === boundConversationId;
        return (
          <div
            key={conversation.conversationId}
            className="flex min-w-0 items-center justify-between gap-2 rounded-md bg-[var(--console-hover-bg)] px-2.5 py-2"
          >
            <SettingsText as="code" tone="secondary" className="min-w-0 break-all font-mono">
              {conversation.conversationId}
            </SettingsText>
            <SettingsSecondaryButton
              disabled={disabled || busyConversationId !== null || isCurrent}
              onClick={() => onSelect(conversation.conversationId)}
            >
              {isCurrent
                ? '当前使用'
                : busyConversationId === conversation.conversationId
                  ? '连接中…'
                  : '用于当前 thread'}
            </SettingsSecondaryButton>
          </div>
        );
      })}
      {hasBinding && (
        <div className="flex justify-end">
          <SettingsSecondaryButton disabled={disabled || busyConversationId !== null} onClick={() => onSelect(null)}>
            {busyConversationId === 'clear' ? '解除中…' : '解除当前 thread 路由'}
          </SettingsSecondaryButton>
        </div>
      )}
    </div>
  );
}
