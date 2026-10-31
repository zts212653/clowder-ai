import type { UnifiedAttentionChoiceRequest } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { RuntimeInteractionCard } from '../../rich/RuntimeInteractionCard';
import { useShellCopy } from '../shell-copy';
import { mailboxRuntimeCopy } from './mailbox-runtime.shell-copy';

/** The original F306 card and writer, with the containing read's owner and exact producer version. */
export function MailboxChoiceCard({
  choice,
  ownerUserId,
  readCurrent,
  verifyCurrentRead,
  secondaryActions,
}: {
  choice: UnifiedAttentionChoiceRequest;
  ownerUserId: string;
  readCurrent: boolean;
  verifyCurrentRead: () => boolean;
  secondaryActions?: ReactNode;
}) {
  const copy = useShellCopy(mailboxRuntimeCopy);
  return (
    <RuntimeInteractionCard
      messageId={choice.cardRef.messageId}
      block={{
        kind: 'card',
        v: 1,
        id: choice.cardRef.blockId,
        title: choice.title,
        meta: { kind: 'runtime_interaction', interactionId: choice.interactionId },
      }}
      host={{ ownerUserId, revision: choice.revision, cardRef: choice.cardRef, readCurrent, verifyCurrentRead }}
      copy={copy}
      presentation="mailbox"
      secondaryActions={secondaryActions}
    />
  );
}
