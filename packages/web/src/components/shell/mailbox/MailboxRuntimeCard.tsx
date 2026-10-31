import type { UnifiedAttentionRuntimeInteraction } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { RuntimeConversationCard } from '../../rich/RuntimeConversationCard';
import { RuntimeInteractionCard } from '../../rich/RuntimeInteractionCard';
import { sameConversationCard, sameConversationPresentation } from '../../rich/runtime-conversation-model';
import { useShellCopy } from '../shell-copy';
import type { ApprovalSessions } from './approval-sessions';
import { mailboxRuntimeCopy } from './mailbox-runtime.shell-copy';

export function MailboxRuntimeCard({
  source,
  ownerUserId,
  sessions,
  readCurrent,
  secondaryActions,
  onAnswerInText,
}: {
  source: UnifiedAttentionRuntimeInteraction;
  ownerUserId: string;
  sessions: ApprovalSessions;
  readCurrent: boolean;
  secondaryActions?: ReactNode;
  onAnswerInText?: () => void;
}) {
  const copy = useShellCopy(mailboxRuntimeCopy);
  if (source.sourceKind === 'conversation_decision') {
    return (
      <RuntimeConversationCard
        onAnswerInText={onAnswerInText}
        block={source.presentation}
        binding={{
          version: 1,
          interactionId: source.interactionId,
          blockId: source.cardRef.blockId,
          requestKind: 'conversation_decision',
        }}
        messageId={source.cardRef.messageId}
        sourceThreadId={source.cardRef.threadId}
        catId={source.requesterCatId}
        host={{
          ownerUserId,
          revision: source.revision,
          cardRef: source.cardRef,
          readCurrent,
          verifyCurrentRead: () => {
            const latest = sessions.currentItem?.(
              ownerUserId,
              `f306.runtime_interaction:${source.interactionId}`,
            )?.runtimeInteraction;
            return Boolean(
              latest?.sourceKind === 'conversation_decision' &&
                latest.revision === source.revision &&
                latest.requesterCatId === source.requesterCatId &&
                sameConversationCard(latest.cardRef, source.cardRef) &&
                sameConversationPresentation(latest.presentation, source.presentation),
            );
          },
        }}
        secondaryActions={secondaryActions}
      />
    );
  }
  return (
    <RuntimeInteractionCard
      messageId={source.cardRef.messageId}
      block={{
        kind: 'card',
        v: 1,
        id: source.cardRef.blockId,
        title: source.title,
        meta: { kind: 'runtime_interaction', interactionId: source.interactionId },
      }}
      host={{
        ownerUserId,
        revision: source.revision,
        cardRef: source.cardRef,
        readCurrent,
        verifyCurrentRead: () => {
          const current = sessions.currentItem?.(ownerUserId, `f306.runtime_interaction:${source.interactionId}`);
          return Boolean(
            current?.runtimeInteraction && JSON.stringify(current.runtimeInteraction) === JSON.stringify(source),
          );
        },
      }}
      copy={copy}
      presentation="mailbox"
      secondaryActions={secondaryActions}
    />
  );
}
