import type { RuntimeInteractionRecord, SettledApprovalHubItem } from '@cat-cafe/shared';
import { useState } from 'react';
import { ApprovalResultRow, type DecisionResultStatus } from '@/components/rich/ApprovalResultRow';
import { HistoryTechnicalDetails } from '@/components/rich/approval-result-history';
import { conversationDecisionCopy } from '@/components/rich/conversation-decision.shell-copy';
import { conversationResult } from '@/components/rich/conversation-result';
import { decisionResultCopy } from '@/components/rich/decision-result.shell-copy';
import { ReadOnlyChoiceList } from '@/components/rich/ReadOnlyChoiceList';
import { RuntimeInteractionRequestDetails } from '@/components/rich/RuntimeInteractionRequestDetails';
import { runtimeDecisionResult } from '@/components/rich/runtime-decision-result';
import { useApprovalResult } from '@/lib/use-approval-result';
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
  const source = useApprovalResult<RuntimeInteractionRecord | null>(
    'F306',
    item.proposalId,
    `runtime-details:${JSON.stringify([item.detail.runtimeRevision, item.decidedAt])}`,
    (signal) => readSettledRuntime(item, signal),
    item.ownerUserId,
    expanded,
  );
  const record = source.value ?? null;
  const checked = source.value !== undefined;
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
  if (checked && !record) result = { status: 'closed', label: `${resultCopy.unknown} · ${item.summary}` };
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
      <HistoryTechnicalDetails>
        {record ? (
          <>
            <RuntimeInteractionRequestDetails request={record.request} terminal={record.terminal} />
            {record.request.kind === 'conversation_decision' ? (
              <ReadOnlyChoiceList
                options={record.request.presentation.options}
                selectedIds={
                  record.terminal?.response?.kind === 'selection' ? record.terminal.response.selectedIds : []
                }
              />
            ) : null}
          </>
        ) : (
          <p>{t.sourceUnavailable}</p>
        )}
      </HistoryTechnicalDetails>
      <button type="button" className="shell-focusable text-xs hover:underline" onClick={reread}>
        {t.reread}
      </button>
    </ApprovalResultRow>
  );
}
