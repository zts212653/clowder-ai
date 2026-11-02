import type { RichCardBlock } from '@cat-cafe/shared';
import { useContext, useEffect, useMemo, useState } from 'react';
import { ApprovalResultHistory } from '@/components/rich/approval-result-history';
import { useShellCopy } from '../shell-copy';
import { useShellLanguage } from '../shell-language';
import { ApprovalDecisionReceipt } from './ApprovalDecisionReceipt';
import { useApprovalHeading } from './approval-heading';
import { describeReconcile, type ReconcileModel, type Terminal } from './approval-reconcile';
import { approvalReconcileCopy } from './approval-reconcile.shell-copy';
import { lookupCreatedThread } from './created-thread-lookup';
import { useCreatedThreadResult } from './created-thread-result';
import { originalApprovalCopy } from './original-approval.shell-copy';
import { readSettledOriginalBlock } from './settled-original-block';
import { settledResultsCopy } from './settled-results.shell-copy';
import { type SettledResultItem, settledResultKey } from './settled-results-source';
import { useOriginalApprovalEffect } from './use-original-approval-effect';

/** Canonical history is sufficient to state a decision. Only the producer's exact receipt can state its effect. */
export function SettledApprovalReceipt({
  item,
  reread,
  authorizeOpen,
}: {
  item: SettledResultItem;
  reread: () => void;
  authorizeOpen: () => boolean;
}) {
  const language = useShellLanguage(),
    t = useShellCopy(settledResultsCopy);
  const originalCopy = useShellCopy(originalApprovalCopy);
  const phaseCopy = useShellCopy(approvalReconcileCopy);
  const history = useContext(ApprovalResultHistory);
  const created = useCreatedThreadResult(item);
  const [detailsRequested, setDetailsRequested] = useState(false);
  const approval = useMemo(() => ({ ...item, inlineApprovable: false }), [item]);
  const { title: proposalTitle } = useApprovalHeading(approval);
  const title =
    item.sourceFeatureId === 'F225' || item.sourceFeatureId === 'F231'
      ? originalCopy.kind[item.sourceFeatureId]
      : proposalTitle;
  const [context, setContext] = useState<{
    item: SettledResultItem;
    block: RichCardBlock | null;
    threadId: string | null;
  } | null>(null);
  useEffect(() => {
    if (!detailsRequested) return;
    const controller = new AbortController();
    void Promise.all([readSettledOriginalBlock(item, controller.signal), null])
      .then(([block, threadId]) => {
        if (!controller.signal.aborted) setContext({ item, block, threadId });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [item, detailsRequested]);
  const original = context?.item === item ? context : null;
  const terminal: Terminal = useMemo(
    () => ({
      resolution: item.resolution,
      ...(item.detail.closureTimeUnknown ? {} : { decidedAt: item.decidedAt }),
      decidedBy: item.decidedBy,
      ...(item.closedReason ? { closedReason: item.closedReason } : {}),
      ...(created.value ? { threadId: created.value } : {}),
      ...(item.resolution === 'accepted'
        ? { effectUnknown: item.sourceFeatureId === 'F128' ? !created.value : true }
        : {}),
    }),
    [item, created.value],
  );
  const session = useMemo(
    () => ({
      key: settledResultKey(item),
      ownerUserId: item.ownerUserId,
      approval,
      originalBlock: original?.block ?? undefined,
      model: { seenAttemptId: 0, lastWrite: null, state: { kind: 'decided', terminal } } satisfies ReconcileModel,
    }),
    [item, approval, terminal, original?.block],
  );
  const effect = useOriginalApprovalEffect(session, true);
  const view = describeReconcile(session.model.state, {
    language,
    ownerUserId: item.ownerUserId,
    sourceFeatureId: item.sourceFeatureId,
    originalEffect: effect,
    compactResult: Boolean(history),
    materialization: item.materialization,
  });
  return (
    <ApprovalDecisionReceipt
      session={session}
      terminal={terminal}
      line={history ? (view.line ?? '') : [view.line, title].filter(Boolean).join(' · ')}
      heading={title}
      authorizeOpen={authorizeOpen}
      onExpandedChange={(expanded) => {
        if (expanded) setDetailsRequested(true);
      }}
      deferProducerRead
      effectFailed={item.materialization.state === 'failed' && !effect && !created.value}
      resolveThreadId={
        item.sourceFeatureId === 'F128' && item.resolution === 'accepted' ? () => lookupCreatedThread(item) : undefined
      }
    >
      {['F225', 'F231', 'F276'].includes(item.sourceFeatureId) && !original?.block ? (
        <p>{t.sourceUnavailable}</p>
      ) : null}
      <button type="button" className="shell-focusable text-xs hover:underline" onClick={reread}>
        {item.materialization.state === 'failed' && !effect && !created.value ? phaseCopy.retry : t.reread}
      </button>
    </ApprovalDecisionReceipt>
  );
}
