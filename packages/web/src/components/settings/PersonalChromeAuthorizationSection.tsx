import {
  PersonalChromeAuthorizationList,
  type PersonalChromeAuthorizedConversation,
} from './PersonalChromeAuthorizationList';
import { SettingsText } from './primitives/SettingsText';

export function PersonalChromeAuthorizationSection({
  status,
  conversations,
  count,
  limit,
  busy,
  onRevoke,
}: {
  status: 'empty' | 'authorized' | 'unsupported';
  conversations: PersonalChromeAuthorizedConversation[];
  count: number;
  limit: number;
  busy: boolean;
  onRevoke: (conversationId: string) => void;
}) {
  return (
    <>
      <PersonalChromeAuthorizationList
        conversations={conversations}
        count={count}
        limit={limit}
        busy={busy}
        onRevoke={onRevoke}
      />
      {/* F202 h3c-1: which conversation a thread uses is chosen in the thread itself, not here. */}
      {status === 'authorized' && (
        <SettingsText as="p" tone="secondary" className="mt-3">
          扩展里的授权决定可以用哪些会话；每个对话具体连哪一个，在对话右栏的「ChatGPT 会话」里选择。
        </SettingsText>
      )}
    </>
  );
}
