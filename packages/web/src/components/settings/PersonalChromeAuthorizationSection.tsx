import {
  PersonalChromeAuthorizationList,
  type PersonalChromeAuthorizedConversation,
} from './PersonalChromeAuthorizationList';
import { PersonalChromeThreadBinding } from './PersonalChromeThreadBinding';

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
      {status === 'authorized' && <PersonalChromeThreadBinding conversations={conversations} disabled={busy} />}
    </>
  );
}
