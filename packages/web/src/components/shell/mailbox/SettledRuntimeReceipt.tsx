import type { RuntimeInteractionRecord, SettledApprovalHubItem } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { ApprovalResultRow, type DecisionResultStatus } from '@/components/rich/ApprovalResultRow';
import { conversationDecisionCopy } from '@/components/rich/conversation-decision.shell-copy';
import { conversationResult } from '@/components/rich/conversation-result';
import { decisionResultCopy } from '@/components/rich/decision-result.shell-copy';
import { ReadOnlyChoiceList } from '@/components/rich/ReadOnlyChoiceList';
import { RuntimeInteractionRequestDetails } from '@/components/rich/RuntimeInteractionRequestDetails';
import { runtimeDecisionResult } from '@/components/rich/runtime-decision-result';
import { useShellCopy } from '../shell-copy';
import { mailboxRuntimeCopy } from './mailbox-runtime.shell-copy';
import { settledResultsCopy } from './settled-results.shell-copy';
import { readSettledRuntime } from './settled-runtime-source';

/** Read-only terminal consumer. It never mounts a responder, including when a newer record is open. */
export function SettledRuntimeReceipt({ item, reread }: { item: SettledApprovalHubItem; reread: () => void }) {
  const resultCopy = useShellCopy(decisionResultCopy),
    copy = useShellCopy(mailboxRuntimeCopy),
    conversationCopy = useShellCopy(conversationDecisionCopy);
  const t = useShellCopy(settledResultsCopy);
  const [expanded, setExpanded] = useState(false);
  const [read, setRead] = useState<{ item: SettledApprovalHubItem; record: RuntimeInteractionRecord | null } | null>(
    null,
  );
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    void readSettledRuntime(item, controller.signal)
      .then((record) => {
        if (!controller.signal.aborted) setRead({ item, record });
      })
      .catch(() => {
        if (!controller.signal.aborted) setRead({ item, record: null });
      });
    return () => controller.abort();
  }, [item, expanded]);
  const record = read?.item === item ? read.record : null;
  const labels = Array.isArray(item.detail.runtimeSelectedLabels)
    ? item.detail.runtimeSelectedLabels.filter((value): value is string => typeof value === 'string')
    : [];
  const reason = typeof item.detail.runtimeReason === 'string' ? item.detail.runtimeReason : undefined;
  const status =
    item.resolution === 'accepted'
      ? 'approved'
      : item.resolution === 'rejected'
        ? 'rejected'
        : (item.closedReason ?? 'closed');
  let result: { status: DecisionResultStatus; label: string } =
    item.detail.runtimeKind === 'conversation_decision'
      ? conversationResult(reason, labels, conversationCopy, resultCopy)
      : {
          status,
          label: labels.length
            ? resultCopy.selected(labels.join(' / '))
            : `${status === 'approved' ? resultCopy.approved : status === 'rejected' ? resultCopy.declined : resultCopy[status]} · ${item.summary}`,
        };
  if (read?.item === item && !record) result = { status: 'closed', label: `${resultCopy.unknown} · ${item.summary}` };
  if (record?.request.kind === 'conversation_decision') {
    const reason = record.terminal?.reasonCode;
    const selected = record.terminal?.response?.kind === 'selection' ? record.terminal.response.selectedIds : [];
    const choices = record.request.presentation.options
      .filter((option) => selected.includes(option.id))
      .map((option) => option.label);
    result = conversationResult(reason, choices, conversationCopy, resultCopy);
  } else if (record) result = runtimeDecisionResult(record, resultCopy, copy);
  return (
    <ApprovalResultRow {...result} onExpandedChange={setExpanded}>
      {record ? (
        <>
          <RuntimeInteractionRequestDetails request={record.request} terminal={record.terminal} />
          {record.request.kind === 'conversation_decision' ? (
            <ReadOnlyChoiceList
              options={record.request.presentation.options}
              selectedIds={record.terminal?.response?.kind === 'selection' ? record.terminal.response.selectedIds : []}
            />
          ) : null}
        </>
      ) : (
        <p>{t.sourceUnavailable}</p>
      )}
      <button type="button" className="shell-focusable text-xs hover:underline" onClick={reread}>
        {t.reread}
      </button>
    </ApprovalResultRow>
  );
}
