'use client';

import type { ApprovalDecisionReceiptV1 } from '@cat-cafe/shared';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import { approvalResultRead } from '@/lib/approval-result-read';
import { type ChatMessage, useChatStore } from '@/stores/chatStore';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';
import { getUserId } from '@/utils/userId';
import { chatApprovalReceiptCopy } from './receipt.shell-copy';
import { ApprovalReceiptPresentation } from './receipt-presentation';
import {
  chatApprovalReceipt,
  deriveChatApprovalReceipt,
  readChatApprovalReceipt,
  receiptImmediatelyFollowsCard,
} from './receipt-source';

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
  const [read, setRead] = useState<{
    revision: number;
    factsVersion: number;
    source: Source | null;
    failed: boolean;
  } | null>(null);
  const identity = useSyncExternalStore(
    apiSessionIdentity.subscribe,
    apiSessionIdentity.getSnapshot,
    apiSessionIdentity.getSnapshot,
  );
  const key = useMemo(
    () => ({ owner: receipt.decidedBy, producer: receipt.producerId, proposalId: receipt.canonicalProposalId }),
    [receipt],
  );
  const subscribe = useCallback((listener: () => void) => approvalResultRead.subscribe(key, listener), [key]);
  const getVersion = useCallback(() => approvalResultRead.factsVersion(key), [key]);
  const factsVersion = useSyncExternalStore(subscribe, getVersion, getVersion);
  const forceNext = useRef(false);
  const browserOwner = getUserId();
  useEffect(() => {
    const controller = new AbortController();
    const fresh = forceNext.current;
    forceNext.current = false;
    void readChatApprovalReceipt(receipt, controller.signal, fresh).then((source) => {
      if (!controller.signal.aborted && getUserId() === browserOwner)
        setRead((previous) =>
          source
            ? { revision, factsVersion, source, failed: false }
            : previous?.factsVersion === factsVersion &&
                previous?.source?.ownerUserId === apiSessionIdentity.getSnapshot().ownerUserId
              ? { ...previous, revision, failed: true }
              : { revision, factsVersion, source: null, failed: true },
        );
    });
    return () => controller.abort();
  }, [receipt, revision, browserOwner, factsVersion]);
  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ proposalId?: string; interactionId?: string }>).detail;
      const id = detail?.proposalId ?? detail?.interactionId;
      if (id && id !== receipt.canonicalProposalId) return;
      reread((n) => n + 1);
    };
    for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.addEventListener(event, refresh);
    return () => {
      for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.removeEventListener(event, refresh);
    };
  }, [receipt.canonicalProposalId]);
  const derived = deriveChatApprovalReceipt(receipt);
  const current = derived
    ? { revision, source: derived, failed: false }
    : read && (read.factsVersion !== factsVersion || (read.source && read.source.ownerUserId !== identity.ownerUserId))
      ? null
      : read;
  const manualReread = () => {
    forceNext.current = true;
    reread((n) => n + 1);
  };
  if (!current) return <span>{t.loading}</span>;
  if (!current.source)
    return (
      <span>
        {t.unavailable} ·{' '}
        <button type="button" className="shell-focusable hover:underline" onClick={manualReread}>
          {t.reread}
        </button>{' '}
        ·{' '}
        <button
          type="button"
          className="shell-focusable hover:underline"
          onClick={() => {
            if (getUserId() === browserOwner && apiSessionIdentity.getSnapshot().ownerUserId === receipt.decidedBy)
              goToOriginalCard(receipt);
          }}
        >
          {t.origin} ↑
        </button>
      </span>
    );
  return (
    <>
      {current.failed ? (
        <span className="text-[var(--semantic-warning)]">
          {t.cachedFailure} ·{' '}
          <button type="button" onClick={manualReread} className="shell-focusable underline">
            {t.reread}
          </button>
        </span>
      ) : null}
      <VerifiedReceipt receipt={receipt} source={current.source} browserOwner={browserOwner} />
    </>
  );
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
    if (getUserId() !== browserOwner || apiSessionIdentity.getSnapshot().ownerUserId !== source.ownerUserId) return;
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
            <ApprovalMember catId={receipt.requesterCatId} />
            <span>
              {language === 'zh' ? (receipt.producerId === 'F128' ? t.thread : t.proposed) : null}
              <button
                type="button"
                title={t.origin}
                className="shell-focusable min-w-0 break-words font-medium hover:underline"
                onClick={goToCard}
              >
                「{title}」 ↑
              </button>
            </span>
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
