'use client';

import type { ApprovalDecisionReceiptV1 } from '@cat-cafe/shared';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { ApprovalMember } from '@/components/rich/ApprovalMember';
import { decisionResultCopy } from '@/components/rich/decision-result.shell-copy';
import { ApprovalDecisionReceipt } from '@/components/shell/mailbox/ApprovalDecisionReceipt';
import { useApprovalHeading } from '@/components/shell/mailbox/approval-heading';
import { describeReconcile, type ReconcileModel } from '@/components/shell/mailbox/approval-reconcile';
import { lookupCreatedThread } from '@/components/shell/mailbox/created-thread-lookup';
import { SettledRuntimeReceipt } from '@/components/shell/mailbox/SettledRuntimeReceipt';
import { useOriginalApprovalEffect } from '@/components/shell/mailbox/use-original-approval-effect';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import { UNIFIED_ATTENTION_INVALIDATION_EVENTS } from '@/components/shell/use-unified-attention';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { type ChatMessage, useChatStore } from '@/stores/chatStore';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';
import { getUserId } from '@/utils/userId';
import { chatApprovalReceiptCopy } from './receipt.shell-copy';
import { ApprovalReceiptPresentation } from './receipt-presentation';
import { chatApprovalReceipt, readChatApprovalReceipt, receiptImmediatelyFollowsCard } from './receipt-source';

type Source = NonNullable<Awaited<ReturnType<typeof readChatApprovalReceipt>>>;

function goToOriginalCard(receipt: ApprovalDecisionReceiptV1) {
  const chat = useChatStore.getState();
  const plan = planTeleport({ ...receipt.approvalCardRef, currentThreadId: chat.currentThreadId });
  if (plan.navigateTo) pushThreadRouteWithHistory(plan.navigateTo, window);
  else if (plan.scrollNow) {
    scrollToMessage(plan.scrollNow);
    kickTeleportResolve();
  }
  chat.closeRightPanel();
}

function ReceiptBubble({ children }: { children: ReactNode }) {
  return (
    <div data-testid="chat-approval-receipt" className="flex justify-end mb-3">
      <div
        className="max-w-full px-3 py-2 text-[13px] text-cafe-secondary"
        style={{ background: 'var(--cafe-surface-sunken)', borderRadius: 10 }}
      >
        {children}
      </div>
    </div>
  );
}

export function ChatApprovalDecisionReceipt({
  message,
  threadId,
  timelineMessages = [],
}: {
  message: ChatMessage;
  threadId?: string;
  timelineMessages?: readonly ChatMessage[];
}) {
  const t = useShellCopy(chatApprovalReceiptCopy);
  const receipt = useMemo(() => chatApprovalReceipt(message), [message]);
  if (receipt && receiptImmediatelyFollowsCard(message.id, receipt, threadId, timelineMessages))
    return <div data-message-id={message.id} aria-hidden="true" className="h-0" />;
  return (
    <div data-message-id={message.id}>
      <ReceiptBubble>
        {receipt ? (
          <ReadReceipt key={JSON.stringify([receipt, threadId, getUserId()])} receipt={receipt} />
        ) : (
          t.unavailable
        )}
      </ReceiptBubble>
    </div>
  );
}

function ReadReceipt({ receipt }: { receipt: ApprovalDecisionReceiptV1 }) {
  const t = useShellCopy(chatApprovalReceiptCopy);
  const [revision, reread] = useState(0);
  const [read, setRead] = useState<{ revision: number; source: Source | null } | null>(null);
  const browserOwner = getUserId();
  useEffect(() => {
    const controller = new AbortController();
    void readChatApprovalReceipt(receipt, controller.signal).then((source) => {
      if (!controller.signal.aborted && getUserId() === browserOwner) setRead({ revision, source });
    });
    return () => controller.abort();
  }, [receipt, revision, browserOwner]);
  useEffect(() => {
    const refresh = () => reread((n) => n + 1);
    for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.addEventListener(event, refresh);
    return () => {
      for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.removeEventListener(event, refresh);
    };
  }, []);
  const current = read?.revision === revision ? read : null;
  if (!current) return <span>{t.loading}</span>;
  if (!current.source)
    return (
      <span>
        {t.unavailable} ·{' '}
        <button type="button" className="shell-focusable hover:underline" onClick={() => reread((n) => n + 1)}>
          {t.reread}
        </button>{' '}
        ·{' '}
        <button
          type="button"
          className="shell-focusable hover:underline"
          onClick={() => {
            if (getUserId() === browserOwner) goToOriginalCard(receipt);
          }}
        >
          {t.origin} ↑
        </button>
      </span>
    );
  return <VerifiedReceipt receipt={receipt} source={current.source} browserOwner={browserOwner} />;
}

function VerifiedReceipt({
  receipt,
  source,
  browserOwner,
}: {
  receipt: ApprovalDecisionReceiptV1;
  source: Source;
  browserOwner: string;
}) {
  const t = useShellCopy(chatApprovalReceiptCopy),
    decisions = useShellCopy(decisionResultCopy),
    language = useShellLanguage();
  const approval = useMemo(() => ({ ...source.item, inlineApprovable: false }), [source.item]);
  const { title: originalTitle } = useApprovalHeading(approval);
  const title =
    approval.sourceFeatureId === 'F225' ? t.handoff : approval.sourceFeatureId === 'F231' ? t.profile : originalTitle;
  const session = useMemo(
    () => ({
      key: JSON.stringify([source.ownerUserId, approval.sourceFeatureId, approval.proposalId]),
      ownerUserId: source.ownerUserId,
      approval,
      model: {
        seenAttemptId: 0,
        lastWrite: null,
        state: { kind: 'decided', terminal: source.terminal },
      } satisfies ReconcileModel,
    }),
    [source.ownerUserId, source.terminal, approval],
  );
  const effect = useOriginalApprovalEffect(session);
  const view = describeReconcile(session.model.state, {
    language,
    ownerUserId: source.ownerUserId,
    sourceFeatureId: approval.sourceFeatureId,
    originalEffect: effect,
  });
  const time = new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(receipt.decidedAt);
  const goToCard = () => {
    if (getUserId() !== browserOwner) return;
    goToOriginalCard(receipt);
  };
  const accepted = receipt.resolution === 'accepted';
  const responseOnly = receipt.producerId === 'F306' && approval.detail.runtimeKind !== 'approval';
  return (
    <ApprovalReceiptPresentation.Provider
      value={{
        status: accepted ? 'approved' : 'rejected',
        decisionWord: accepted ? decisions.approved : decisions.declined,
        time,
        lead: (
          <>
            <span>{accepted ? (responseOnly ? t.responded : t.approved) : t.rejected}</span>
            {language === 'en' ? <span>{receipt.producerId === 'F128' ? t.thread : t.proposed}</span> : null}
            <ApprovalMember catId={receipt.requesterCatId} showModel={false} />
            {language === 'zh' ? <span>{receipt.producerId === 'F128' ? t.thread : t.proposed}</span> : null}
            <button
              type="button"
              title={t.origin}
              className="shell-focusable min-w-0 break-words font-medium hover:underline"
              onClick={goToCard}
            >
              「{title}」 ↑
            </button>
          </>
        ),
        suffix: (
          <>
            {!accepted && receipt.rejectionReason ? (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {t.reason}
                  {receipt.rejectionReason}
                </span>
              </>
            ) : null}
            <span aria-hidden="true">·</span>
            <time dateTime={new Date(receipt.decidedAt).toISOString()} className="text-cafe-muted">
              {time}
            </time>
          </>
        ),
      }}
    >
      {receipt.producerId === 'F306' ? (
        <SettledRuntimeReceipt item={source.item} reread={goToCard} />
      ) : (
        <ApprovalDecisionReceipt
          session={session}
          terminal={source.terminal}
          line={view.line ?? t.unavailable}
          authorizeOpen={() => getUserId() === browserOwner}
          resolveThreadId={
            receipt.producerId === 'F128' && accepted ? () => lookupCreatedThread(source.item) : undefined
          }
        />
      )}
    </ApprovalReceiptPresentation.Provider>
  );
}
