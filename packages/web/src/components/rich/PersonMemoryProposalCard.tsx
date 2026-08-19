'use client';

import { isPersonMemoryProposalCardBlock } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { PersonMemoryProposalCardView } from './PersonMemoryProposalCardView';

type PersonMemoryCardStatus =
  | 'pending_approval'
  | 'not_now'
  | 'partially_materialized'
  | 'materialized'
  | 'rejected'
  | 'withdrawn';

interface PersonMemoryProposalSnapshot {
  proposalId: string;
  status: PersonMemoryCardStatus;
  remainingDraftIds?: string[];
  publicationState: 'anchored';
  approvalCardMessageId: string;
  decisionReceipt?: PersonMemoryDecisionReceiptView;
  undoReceipt?: { requestId: string; verdict: 'undone' };
}

interface PersonMemoryDecisionReceiptView {
  decisionId: string;
  materializedClaimIds: string[];
  materializedRelationshipIds: string[];
  materializedEventIds: string[];
}

type HydrationResult = { status: 'ok'; snapshot: PersonMemoryProposalSnapshot } | { status: 'error'; message: string };

const NON_TERMINAL_RANK: Partial<Record<PersonMemoryCardStatus, number>> = {
  pending_approval: 0,
  not_now: 1,
  partially_materialized: 2,
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isDecisionReceiptView(value: unknown): value is PersonMemoryDecisionReceiptView {
  if (typeof value !== 'object' || value === null) return false;
  const receipt = value as Partial<PersonMemoryDecisionReceiptView>;
  return (
    typeof receipt.decisionId === 'string' &&
    isStringArray(receipt.materializedClaimIds) &&
    isStringArray(receipt.materializedRelationshipIds) &&
    isStringArray(receipt.materializedEventIds)
  );
}

function isUndoReceiptView(value: unknown): value is PersonMemoryProposalSnapshot['undoReceipt'] {
  if (typeof value !== 'object' || value === null) return false;
  const receipt = value as { requestId?: unknown; verdict?: unknown };
  return typeof receipt.requestId === 'string' && receipt.verdict === 'undone';
}

function isTerminal(status: PersonMemoryCardStatus): boolean {
  return status === 'materialized' || status === 'rejected' || status === 'withdrawn';
}

function advanceStatus(
  current: PersonMemoryCardStatus,
  next: PersonMemoryCardStatus,
  forcedByUndo = false,
): PersonMemoryCardStatus {
  if (forcedByUndo) return next;
  if (isTerminal(current)) return current;
  if (isTerminal(next)) return next;
  return (NON_TERMINAL_RANK[next] ?? -1) >= (NON_TERMINAL_RANK[current] ?? -1) ? next : current;
}

function stableUndoRequestId(proposalId: string, decisionId: string): string {
  const input = `${proposalId}\0${decisionId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `f276_undo_${(hash >>> 0).toString(16)}`;
}

function receiptSummary(receipt: PersonMemoryDecisionReceiptView): string {
  return [
    `${receipt.materializedClaimIds.length} 条事实`,
    `${receipt.materializedRelationshipIds.length} 条关系`,
    `${receipt.materializedEventIds.length} 个事件`,
  ].join(' · ');
}

function isAnchoredSnapshot(
  value: unknown,
  proposalId: string,
  messageId: string | undefined,
): value is PersonMemoryProposalSnapshot {
  if (typeof value !== 'object' || value === null || typeof messageId !== 'string') return false;
  const snapshot = value as Partial<PersonMemoryProposalSnapshot>;
  if (snapshot.decisionReceipt !== undefined && !isDecisionReceiptView(snapshot.decisionReceipt)) return false;
  if (snapshot.undoReceipt !== undefined && !isUndoReceiptView(snapshot.undoReceipt)) return false;
  return (
    snapshot.proposalId === proposalId &&
    snapshot.publicationState === 'anchored' &&
    snapshot.approvalCardMessageId === messageId &&
    typeof snapshot.status === 'string' &&
    ['pending_approval', 'not_now', 'partially_materialized', 'materialized', 'rejected', 'withdrawn'].includes(
      snapshot.status,
    )
  );
}

function statusLabel(status: PersonMemoryCardStatus): string | null {
  if (status === 'materialized') return '已写入';
  if (status === 'rejected') return '已拒绝';
  if (status === 'withdrawn') return '已撤回';
  if (status === 'not_now') return '已留待稍后';
  if (status === 'partially_materialized') return '部分已写入，可继续审批';
  return null;
}

async function loadAnchoredSnapshot(proposalId: string, messageId: string | undefined): Promise<HydrationResult> {
  try {
    const response = await apiFetch(`/api/person-memory-proposals/${proposalId}`);
    if (!response.ok) return { status: 'error', message: `提案状态同步失败（HTTP ${response.status}）` };
    const snapshot = (await response.json()) as unknown;
    if (!isAnchoredSnapshot(snapshot, proposalId, messageId)) {
      return { status: 'error', message: '审批卡来源验证失败' };
    }
    return { status: 'ok', snapshot };
  } catch {
    return { status: 'error', message: '提案状态同步失败，请刷新后重试' };
  }
}

export function PersonMemoryProposalCard({ block, messageId }: { block: RichCardBlock; messageId?: string }) {
  const typedBlock = isPersonMemoryProposalCardBlock(block) ? block : null;
  const proposalId = typedBlock?.meta.candidateId ?? null;
  const initialStatus = typedBlock?.meta.status ?? 'pending_approval';
  const [status, setStatus] = useState<PersonMemoryCardStatus>(initialStatus);
  const statusRef = useRef<PersonMemoryCardStatus>(initialStatus);
  const [hydrated, setHydrated] = useState(false);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  const [decisionReceipt, setDecisionReceipt] = useState<PersonMemoryDecisionReceiptView | null>(null);
  const [undoing, setUndoing] = useState(false);
  const openApprovalHub = useApprovalHubStore((state) => state.open);

  const navigateLabel = useMemo(
    () => typedBlock?.actions?.find((action) => action.action === 'person-memory:open-approval-hub')?.label ?? '去审批',
    [typedBlock],
  );

  useEffect(() => {
    if (!proposalId || typeof window === 'undefined') return;
    let cancelled = false;
    let receivedValidLiveUpdate = false;
    statusRef.current = initialStatus;
    setStatus(initialStatus);
    setDecisionReceipt(null);
    setUndoing(false);
    setHydrated(false);
    setHydrationError(null);

    const advance = (next: PersonMemoryCardStatus, forcedByUndo = false) => {
      const resolved = advanceStatus(statusRef.current, next, forcedByUndo);
      statusRef.current = resolved;
      setStatus(resolved);
    };
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isAnchoredSnapshot(detail, proposalId, messageId)) return;
      receivedValidLiveUpdate = true;
      if (detail.undoReceipt) {
        setDecisionReceipt(null);
        advance(detail.status, true);
      } else {
        if (detail.decisionReceipt) setDecisionReceipt(detail.decisionReceipt);
        advance(detail.status);
      }
      setHydrationError(null);
      setHydrated(true);
    };
    window.addEventListener('cat-cafe:proposal-updated', handler);

    void loadAnchoredSnapshot(proposalId, messageId).then((result) => {
      if (cancelled || receivedValidLiveUpdate) return;
      if (result.status === 'ok') {
        setDecisionReceipt(result.snapshot.undoReceipt ? null : (result.snapshot.decisionReceipt ?? null));
        advance(result.snapshot.status, Boolean(result.snapshot.undoReceipt));
      } else setHydrationError(result.message);
      setHydrated(true);
    });

    return () => {
      cancelled = true;
      window.removeEventListener('cat-cafe:proposal-updated', handler);
    };
  }, [initialStatus, messageId, proposalId]);

  if (!typedBlock || !proposalId) {
    return (
      <div className="rounded-lg border border-conn-red-ring bg-[var(--semantic-critical-surface)] p-3 text-xs text-conn-red-text">
        人物记忆审批卡格式无效
      </div>
    );
  }

  const label = statusLabel(status);
  const canNavigate = !isTerminal(status);
  const canUndo = decisionReceipt !== null && (status === 'materialized' || status === 'partially_materialized');
  const undo = async () => {
    if (!decisionReceipt || !proposalId || undoing) return;
    setUndoing(true);
    setHydrationError(null);
    try {
      const response = await apiFetch(`/api/person-memory-proposals/${proposalId}/undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decisionId: decisionReceipt.decisionId,
          requestId: stableUndoRequestId(proposalId, decisionReceipt.decisionId),
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = (await response.json()) as { status?: PersonMemoryCardStatus; verdict?: string };
      if (result.verdict !== 'undone' || !result.status) throw new Error('invalid undo receipt');
      setDecisionReceipt(null);
      const resolved = advanceStatus(statusRef.current, result.status, true);
      statusRef.current = resolved;
      setStatus(resolved);
    } catch {
      setHydrationError('撤销失败；原记忆未改变，请重试');
    } finally {
      setUndoing(false);
    }
  };
  return (
    <PersonMemoryProposalCardView
      title={typedBlock.title}
      bodyMarkdown={typedBlock.bodyMarkdown}
      fields={typedBlock.fields}
      hydrated={hydrated}
      hydrationError={hydrationError}
      statusLabel={label}
      receiptSummary={decisionReceipt ? receiptSummary(decisionReceipt) : null}
      canNavigate={canNavigate}
      navigateLabel={navigateLabel}
      onNavigate={openApprovalHub}
      canUndo={canUndo}
      undoing={undoing}
      onUndo={() => void undo()}
    />
  );
}
