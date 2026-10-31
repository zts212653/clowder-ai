'use client';

import { suggestedReportingModeForWorkMode, type ThreadProposal } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  useAuthorizeWrite,
  useGuardedWrite,
  useReportEditing,
  useWriteBlocked,
  type WriteEvidence,
} from '@/components/ApprovalHost';
import type { PublishedMessageCoordinate } from '@/components/content-review/usePublishedContent';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { recordThreadProposalDemoUse } from '@/lib/feature-demo-telemetry';
import type { RichCardBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { formatDeclaredWorkMode, formatReportingMode, type ReportingModeEditValue } from './ProposalCardFields';
import {
  extractProposalId,
  isDefaultProjectOwnership,
  type ProposalCardStatus,
  type ProposalFieldEdits,
  type ProposalSnapshot,
  parsePreferredCats,
  readDeclaredWorkModeEdit,
  readField,
  readProjectPathEdit,
  readReportingModeEdit,
} from './ProposalCardUtils';
import { proposalCardCopy } from './proposal-card.shell-copy';
import { useApprovalStatus } from './use-approval-status';

export type ProposalCardInput =
  | { block: RichCardBlock; proposal?: never; messageId?: string; coordinate?: PublishedMessageCoordinate }
  | { proposal: ThreadProposal; block?: never; messageId?: string };

function selectExistingProjectPaths(state: ReturnType<typeof useChatStore.getState>): string[] {
  const threads = state.threads ?? [];
  return [...new Set(threads.map((t) => t.projectPath).filter((p): p is string => !!p && p !== 'default'))].sort();
}

export function useProposalCardState({ block, proposal }: ProposalCardInput) {
  const isV2 = useShellPresentation() === 'v2';
  const t = useShellCopy(proposalCardCopy);
  const proposalId = useMemo(
    () => proposal?.proposalId ?? (block ? extractProposalId(block) : null),
    [block, proposal?.proposalId],
  );
  const native = useApprovalStatus(
    'F128',
    proposalId,
    `/api/proposals/${encodeURIComponent(proposalId ?? '')}`,
    !proposal,
  );
  const [status, setStatus] = useState<ProposalCardStatus>(
    proposal?.status ?? (native.status as ProposalCardStatus | null) ?? 'pending',
  );
  const [resultThreadId, setResultThreadId] = useState<string | null>(
    proposal?.createdThreadId ??
      (typeof native.terminal?.detail.createdThreadId === 'string' ? native.terminal.detail.createdThreadId : null),
  );
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinOnApprove, setPinOnApprove] = useState(proposal?.suggestedPinned ?? false);
  const [attentionGroupId, setAttentionGroupId] = useState(
    proposal?.attentionGroupId !== undefined ? (proposal.attentionGroupId ?? '') : (proposal?.suggestedGroupId ?? ''),
  );
  const guardedWrite = useGuardedWrite();
  const authorizeContinuation = useAuthorizeWrite();
  const writeBlocked = useWriteBlocked(loading);
  useReportEditing('thread-proposal', editing);
  const [effectiveReportingMode, setEffectiveReportingMode] = useState<ReportingModeEditValue>(() =>
    proposal
      ? (proposal.reportingMode ?? suggestedReportingModeForWorkMode(proposal.declaredWorkMode))
      : readReportingModeEdit(block),
  );
  const [effectiveDeclaredWorkMode, setEffectiveDeclaredWorkMode] = useState(() =>
    proposal ? (proposal.declaredWorkMode ?? '') : readDeclaredWorkModeEdit(block),
  );
  const [edits, setEdits] = useState<ProposalFieldEdits>(() =>
    proposal
      ? {
          title: proposal.title,
          parentThreadId: proposal.parentThreadId,
          preferredCats: proposal.preferredCats.join(', '),
          initialMessage: proposal.initialMessage ?? '',
          projectPath: proposal.projectPath === 'default' ? '' : proposal.projectPath,
          reportingMode: proposal.reportingMode ?? suggestedReportingModeForWorkMode(proposal.declaredWorkMode),
          declaredWorkMode: proposal.declaredWorkMode ?? '',
        }
      : {
          title: block.title.replace(/^(?:📥 )?提议新建 thread：/, ''),
          parentThreadId: readField(block, '父 Thread'),
          preferredCats: readField(block, '建议成员'),
          initialMessage: readField(block, '首条消息'),
          projectPath: readProjectPathEdit(block),
          reportingMode: readReportingModeEdit(block),
          declaredWorkMode: readDeclaredWorkModeEdit(block),
        },
  );
  const projectOwnership = proposal ? proposal.projectPath : readField(block, '项目归属');
  const reportingMode = formatReportingMode(effectiveReportingMode);
  const declaredWorkMode = formatDeclaredWorkMode(effectiveDeclaredWorkMode);
  const needsProjectChoice = isDefaultProjectOwnership(projectOwnership);
  const existingProjects = useChatStore(useShallow(selectExistingProjectPaths));

  // A fresh producer read (including a socket invalidation) updates the outcome without replacing an open editor.
  useEffect(() => {
    if (!proposal) return;
    setStatus(proposal.status);
    setResultThreadId(proposal.createdThreadId ?? null);
  }, [proposal]);

  useEffect(() => {
    if (proposal || !native.status) return;
    setStatus(native.status as ProposalCardStatus);
    if (typeof native.terminal?.detail.createdThreadId === 'string')
      setResultThreadId(native.terminal.detail.createdThreadId);
    const data = native.record as ProposalSnapshot | null;
    if (!data) return;
    if (data.createdThreadId) setResultThreadId(data.createdThreadId);
    if (data.reportingMode) {
      setEffectiveReportingMode(data.reportingMode);
      setEdits((previous) => ({ ...previous, reportingMode: data.reportingMode ?? previous.reportingMode }));
    }
    if (data.declaredWorkMode) {
      setEffectiveDeclaredWorkMode(data.declaredWorkMode);
      setEdits((previous) => ({ ...previous, declaredWorkMode: data.declaredWorkMode ?? previous.declaredWorkMode }));
    }
  }, [proposal, native.record, native.status, native.terminal]);

  // Subscribe to socket-driven updates so other tabs / async approves reflect immediately.
  useEffect(() => {
    if (!proposalId || proposal || typeof window === 'undefined') return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<ProposalSnapshot>).detail;
      if (!detail || detail.proposalId !== proposalId) return;
      setStatus(detail.status);
      if (detail.createdThreadId) setResultThreadId(detail.createdThreadId);
      if (detail.reportingMode) {
        setEffectiveReportingMode(detail.reportingMode);
        setEdits((prev) => ({ ...prev, reportingMode: detail.reportingMode ?? prev.reportingMode }));
      }
      if (detail.declaredWorkMode) {
        setEffectiveDeclaredWorkMode(detail.declaredWorkMode);
        setEdits((prev) => ({ ...prev, declaredWorkMode: detail.declaredWorkMode ?? prev.declaredWorkMode }));
      }
    };
    window.addEventListener('cat-cafe:proposal-updated', handler);
    return () => {
      window.removeEventListener('cat-cafe:proposal-updated', handler);
    };
  }, [proposalId, proposal]);

  const approveOriginal = useCallback(
    async (reportEvidence: (evidence: WriteEvidence) => void) => {
      if (!proposalId) return;
      setLoading(true);
      setError(null);
      const body: Record<string, unknown> =
        editing && !isV2
          ? {
              title: edits.title.trim() || undefined,
              parentThreadId: edits.parentThreadId.trim() || undefined,
              preferredCats: parsePreferredCats(edits.preferredCats),
              initialMessage: edits.initialMessage.trim() ? edits.initialMessage.trim() : null,
              // F128: empty box = no override (keep the proposal's projectPath); a path re-homes the
              // child thread. Backend validates + fail-loud rejects an invalid path (400).
              projectPath: edits.projectPath.trim() || undefined,
              reportingMode: edits.reportingMode,
              declaredWorkMode: edits.declaredWorkMode || undefined,
            }
          : isV2 && proposal
            ? { projectPath: edits.projectPath.trim() || undefined, attentionGroupId: attentionGroupId || null }
            : {};
      if (pinOnApprove) body.pinned = true;
      let receivedResponse = false;
      try {
        const res = await apiFetch(`/api/proposals/${proposalId}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        receivedResponse = true;
        reportEvidence({ outcome: res.ok ? 'settled' : 'http-error', status: res.status });
        const data = (await res.json()) as { threadId?: string; error?: string; warnings?: string[] };
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        recordThreadProposalDemoUse(data);
        const newThreadId = data.threadId ?? null;
        setEffectiveReportingMode(editing ? edits.reportingMode : effectiveReportingMode);
        setEffectiveDeclaredWorkMode(editing ? edits.declaredWorkMode : effectiveDeclaredWorkMode);
        setResultThreadId(newThreadId);
        setStatus('approved');
        window.dispatchEvent(new CustomEvent('cat-cafe:proposal-updated', { detail: { proposalId } }));
        setEditing(false);
        if (data.warnings?.length) setError(data.warnings.join(' · '));
        if (newThreadId) {
          if (!authorizeContinuation('producer-card')) {
            setError(t.continuationRefused);
            return;
          }
          pushThreadRouteWithHistory(newThreadId, typeof window !== 'undefined' ? window : undefined);
        }
      } catch (err) {
        if (!receivedResponse) reportEvidence({ outcome: 'network-error' });
        setError(err instanceof Error ? err.message : '批准失败');
      } finally {
        setLoading(false);
      }
    },
    [
      proposalId,
      editing,
      edits,
      effectiveReportingMode,
      effectiveDeclaredWorkMode,
      pinOnApprove,
      authorizeContinuation,
      t.continuationRefused,
      isV2,
      proposal,
      attentionGroupId,
    ],
  );

  const rejectOriginal = useCallback(
    async (reportEvidence: (evidence: WriteEvidence) => void) => {
      if (!proposalId) return;
      setLoading(true);
      setError(null);
      let receivedResponse = false;
      try {
        const res = await apiFetch(`/api/proposals/${proposalId}/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        receivedResponse = true;
        reportEvidence({ outcome: res.ok ? 'settled' : 'http-error', status: res.status });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        setStatus('rejected');
        window.dispatchEvent(new CustomEvent('cat-cafe:proposal-updated', { detail: { proposalId } }));
      } catch (err) {
        if (!receivedResponse) reportEvidence({ outcome: 'network-error' });
        setError(err instanceof Error ? err.message : '驳回失败');
      } finally {
        setLoading(false);
      }
    },
    [proposalId],
  );

  const approve = useCallback(() => guardedWrite('producer-card', approveOriginal), [guardedWrite, approveOriginal]);
  const reject = useCallback(() => guardedWrite('producer-card', rejectOriginal), [guardedWrite, rejectOriginal]);

  return {
    proposalId,
    status,
    resultThreadId,
    editing,
    setEditing,
    loading,
    error,
    pinOnApprove,
    setPinOnApprove,
    attentionGroupId,
    setAttentionGroupId,
    writeBlocked,
    edits,
    setEdits,
    projectOwnership,
    reportingMode,
    declaredWorkMode,
    effectiveReportingMode,
    effectiveDeclaredWorkMode,
    needsProjectChoice,
    existingProjects,
    approve,
    reject,
  };
}

export type ProposalCardState = ReturnType<typeof useProposalCardState>;
