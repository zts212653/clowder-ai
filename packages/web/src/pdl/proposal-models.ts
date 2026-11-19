import type {
  ProfileUpdateProposal,
  RichCardBlock,
  ScheduleMutationProposal,
  SessionHandoffProposal,
  ThreadProposal,
} from '@cat-cafe/shared';
import { isProfileUpdateCardBlock, postProfileUpdateDecision } from '@/components/rich/profile-update-actions';
import { readableProposedFields } from '@/components/shell/mailbox/thread-proposal-read';
import { readApprovalProducerBody } from '@/lib/approval-producer-read';
import { approvalResultRead } from '@/lib/approval-result-read';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import { invalidateThreadAttentionPreferences } from '@/utils/thread-attention-invalidation';

export interface ProposalTarget {
  feature: 'F128' | 'F225' | 'F231';
  id: string;
  threadId: string;
  mid: string;
  blockId: string;
}
export interface ProposalBinding {
  target: ProposalTarget;
  record?: ThreadProposal | SessionHandoffProposal | ProfileUpdateProposal;
  current: boolean;
  refresh: () => Promise<unknown>;
  revision?: number;
  owner?: string | null;
  recovery?: { phase: '' | 'writing' | 'uncertain' | 'retryable' | 'placement'; reading: boolean };
  notify?: () => void;
}
export function proposalTarget(block: RichCardBlock, threadId: string, mid: string): ProposalTarget | null {
  if (isProfileUpdateCardBlock(block)) {
    const action = block.actions?.find(
      (item) => item.action === 'profile-update:approve' || item.action === 'profile-update:reject',
    );
    const stamp = block.meta?.approval as { canonicalProposalId?: string } | undefined;
    const id = action?.payload?.proposalId ?? stamp?.canonicalProposalId;
    return typeof id === 'string' && id ? { feature: 'F231', id, threadId, mid, blockId: block.id } : null;
  }
  const action = block.actions?.find((a) => a.action === 'propose:approve' || a.action === 'handoff:approve');
  const id = action?.payload?.proposalId;
  return typeof id === 'string' && id
    ? { feature: action!.action === 'propose:approve' ? 'F128' : 'F225', id, threadId, mid, blockId: block.id }
    : null;
}
export function proposalPath(target: ProposalTarget) {
  const base =
    target.feature === 'F128'
      ? '/api/proposals/'
      : target.feature === 'F231'
        ? '/api/profile-updates/'
        : '/api/session-handoff/';
  return `${base}${encodeURIComponent(target.id)}`;
}
/** The approval read keeps the original response body; this is the one place that turns it into the card's proposal. */
export function proposalFromBody(target: ProposalTarget, raw: unknown) {
  const owner = apiSessionIdentity.getSnapshot().ownerUserId;
  const body = raw as { proposal?: ThreadProposal | SessionHandoffProposal | ProfileUpdateProposal } | undefined;
  const proposal = body?.proposal;
  // A session handoff read answers only the proposal's owner and returns its status; the card carries the content.
  if (
    !proposal ||
    proposal.proposalId !== target.id ||
    (target.feature !== 'F225' &&
      (proposal.sourceThreadId !== target.threadId ||
        (proposal.cardMessageId !== undefined && proposal.cardMessageId !== target.mid) ||
        !('createdBy' in proposal) ||
        proposal.createdBy !== owner ||
        (target.feature === 'F128' && !readableProposedFields(proposal as unknown as Record<string, unknown>))))
  )
    throw new Error('提议来源不可用');
  const publication = proposal.publication;
  if (
    publication?.state === 'anchored' &&
    (publication.envelope.ownerUserId !== owner ||
      publication.envelope.approvalCardRef.threadId !== target.threadId ||
      publication.envelope.approvalCardRef.messageId !== target.mid)
  )
    throw new Error('提议发布坐标已变化');
  if (publication && publication.state !== 'anchored' && publication.state !== 'legacy_unanchored')
    throw new Error('提议尚未发布');
  return proposal;
}
export async function readProposal(target: ProposalTarget, signal?: AbortSignal, fresh = false) {
  const owner = apiSessionIdentity.getSnapshot().ownerUserId;
  const body = await readApprovalProducerBody(
    { owner: owner ?? '', producer: target.feature, proposalId: target.id },
    proposalPath(target),
    { signal, fresh },
  );
  return proposalFromBody(target, body);
}
// Transient attempt evidence shares the existing approval identity across inbox and chat.
export function proposalRecoveryState(target: ProposalTarget) {
  return approvalResultRead.snapshot<NonNullable<ProposalBinding['recovery']>>(
    { owner: apiSessionIdentity.getSnapshot().ownerUserId ?? '', producer: target.feature, proposalId: target.id },
    'pdl-decision',
  ).value;
}
function publishRecovery(binding: ProposalBinding) {
  const key = {
    owner: binding.owner ?? apiSessionIdentity.getSnapshot().ownerUserId ?? '',
    producer: binding.target.feature,
    proposalId: binding.target.id,
  };
  approvalResultRead.seed(key, 'pdl-decision', { ...binding.recovery });
  binding.notify?.();
}

/** Explicit pending readback alone releases an uncertain write. Background reads never authorize a retry. */
export async function recheckProposal(binding: ProposalBinding, explicit = true) {
  if (binding.owner !== undefined && binding.owner !== apiSessionIdentity.getSnapshot().ownerUserId)
    throw new Error('proposalRecovery.blocked');
  binding.owner = apiSessionIdentity.getSnapshot().ownerUserId;
  const recovery = (binding.recovery = proposalRecoveryState(binding.target) ??
    binding.recovery ?? { phase: '', reading: false });
  if (recovery.reading || recovery.phase === 'writing') return;
  const identity = apiSessionIdentity.getSnapshot();
  recovery.reading = true;
  publishRecovery(binding);
  try {
    const record = await readProposal(binding.target, undefined, true);
    if (identity !== apiSessionIdentity.getSnapshot()) return;
    if (record.status === 'approved' && 'createdThreadId' in record && record.createdThreadId) {
      recovery.phase = 'placement';
      window.dispatchEvent(
        new CustomEvent('cat-cafe:proposal-updated', {
          detail: { proposalId: record.proposalId, status: 'approved', createdThreadId: record.createdThreadId },
        }),
      );
    } else if (['rejected', 'withdrawn', 'expired'].includes(record.status)) recovery.phase = '';
    else if (explicit && record.status === 'pending') recovery.phase = 'retryable';
    await binding.refresh();
    return record;
  } finally {
    recovery.reading = false;
    publishRecovery(binding);
  }
}

export async function decideProposal(
  binding: ProposalBinding,
  decision: 'approve' | 'reject',
  edits?: Record<string, string>,
) {
  const { target, record } = binding;
  if (binding.owner !== undefined && binding.owner !== apiSessionIdentity.getSnapshot().ownerUserId)
    throw new Error('proposalRecovery.blocked');
  binding.owner = apiSessionIdentity.getSnapshot().ownerUserId;
  const recovery = (binding.recovery = proposalRecoveryState(binding.target) ??
    binding.recovery ?? { phase: '', reading: false });
  if (recovery.reading || ['writing', 'uncertain', 'placement'].includes(recovery.phase))
    throw new Error('proposalRecovery.blocked');
  if (!binding.current || !record) throw new Error('proposalRecovery.blocked');
  const identity = apiSessionIdentity.getSnapshot();
  const previous = recovery.phase;
  recovery.phase = 'writing';
  publishRecovery(binding);
  let sent = false;
  try {
    const current = await readProposal(target, undefined, true);
    if (identity !== apiSessionIdentity.getSnapshot()) throw new Error('proposalRecovery.blocked');
    if (
      JSON.stringify(current) !== JSON.stringify(record) ||
      (current.status !== 'pending' &&
        !(target.feature === 'F225' && decision === 'approve' && current.status === 'approving'))
    )
      throw new Error('提议已变化，请重新读取');
    if (target.feature === 'F231') {
      sent = true;
      await postProfileUpdateDecision(target.id, decision);
      recovery.phase = '';
      await binding.refresh();
      return;
    }
    const path = target.feature === 'F128' ? '/api/proposals/' : '/api/session-handoff/';
    const body =
      target.feature === 'F128' && decision === 'approve' && edits
        ? {
            title: edits.title.trim(),
            parentThreadId: edits.parentThreadId.trim(),
            preferredCats: edits.preferredCats
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            initialMessage: edits.initialMessage.trim() || null,
            projectPath: edits.projectPath.trim(),
            ...(edits.reportingMode ? { reportingMode: edits.reportingMode } : {}),
            ...(edits.declaredWorkMode ? { declaredWorkMode: edits.declaredWorkMode } : {}),
          }
        : {};
    sent = true;
    const response = await apiFetch(`${path}${encodeURIComponent(target.id)}/${decision}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'proposalRecovery.uncertain');
    if (identity !== apiSessionIdentity.getSnapshot()) throw new Error('proposalRecovery.blocked');
    recovery.phase = target.feature === 'F128' && decision === 'approve' ? 'placement' : '';
    if (target.feature === 'F128' && decision === 'approve') {
      window.dispatchEvent(
        new CustomEvent('cat-cafe:proposal-updated', {
          detail: { proposalId: target.id, status: 'approved', createdThreadId: result.threadId },
        }),
      );
    }
    await binding.refresh();
  } catch (error) {
    recovery.phase = sent ? 'uncertain' : previous;
    if (sent && target.feature === 'F128' && decision === 'approve') invalidateThreadAttentionPreferences();
    throw error;
  } finally {
    publishRecovery(binding);
  }
}

export function proposalView(
  binding: ProposalBinding,
  editing: boolean,
  asking: boolean,
  draft: Record<string, unknown>,
) {
  const p = binding.record;
  if (!p) return null;
  const thread = binding.target.feature === 'F128' ? (p as ThreadProposal) : null,
    profile = binding.target.feature === 'F231' ? (p as ProfileUpdateProposal) : null,
    terminal = ['approved', 'rejected', 'withdrawn', 'expired'].includes(p.status),
    recovery = proposalRecoveryState(binding.target) ?? binding.recovery,
    writable = binding.current && !recovery?.reading && (!recovery?.phase || recovery.phase === 'retryable');
  const fields = thread
    ? [
        { field: 'project', v: thread.projectPath },
        { field: 'members', v: thread.preferredCats },
        { field: 'parent', v: thread.parentThreadId },
        { field: 'reason', v: thread.reason },
      ]
    : profile
      ? [
          { field: 'target', v: profile.targetPath },
          { field: 'reason', v: profile.rationale },
        ]
      : [];
  const rows = thread
    ? (
        [
          'title',
          'parentThreadId',
          'preferredCats',
          'projectPath',
          'initialMessage',
          'reportingMode',
          'declaredWorkMode',
        ] as const
      ).map((key) => {
        const id = 'proposal-' + encodeURIComponent(binding.target.id) + '-' + key;
        return {
          key,
          label: key,
          id,
          value: draft[id] ?? (key === 'preferredCats' ? thread.preferredCats.join(', ') : (thread[key] ?? '')),
          first: key === 'initialMessage',
        };
      })
    : [];
  const first = thread ? thread.initialMessage : profile ? profile.afterContent : null;
  return {
    title: thread ? thread.title : '',
    titleType: profile ? 'profile' : thread ? '' : 'handoff',
    fields,
    first,
    firstKey: binding.target.id,
    firstTitle: profile ? 'profile' : 'initialMessage',
    recovery: recovery?.phase ?? '',
    recoveryReading: recovery?.reading ?? false,
    canReadback: !!recovery?.phase && recovery.phase !== 'writing',
    editing: editing && !terminal && writable,
    canEditInPlace: !!thread && writable && p.status === 'pending',
    canRequestChange: !!(thread || profile) && writable && p.status === 'pending',
    canApprove: writable && p.status === 'pending',
    asking: asking && !terminal && writable,
    askId: 'proposal-ask-' + encodeURIComponent(binding.target.id),
    rejectable: writable && p.status === 'pending',
    decided: terminal || !binding.current || p.status !== 'pending',
    okLabel: 'approve',
    editRows: rows,
    noticeState: !binding.current ? 'unavailable' : p.status,
    noticeText: '',
    result: terminal
      ? {
          key: binding.target.id,
          status: p.status,
          reason: p.status,
          fields,
          first,
          firstKey: binding.target.id,
          firstTitle: profile ? 'profile' : 'initialMessage',
        }
      : null,
    open: !!(thread && thread.createdThreadId),
    openId: thread && thread.createdThreadId,
  };
}

export async function requestProposalRevision(
  binding: ProposalBinding,
  instruction: string,
  send?: (catId: string, text: string) => Promise<unknown>,
) {
  const recovery = proposalRecoveryState(binding.target) ?? binding.recovery;
  if (recovery?.reading || (recovery?.phase && recovery.phase !== 'retryable'))
    throw new Error('proposalRecovery.blocked');
  if (!binding.current || binding.target.feature === 'F225' || !instruction.trim()) throw new Error('请填写修改要求');
  const current = await readProposal(binding.target, undefined, true);
  if (current.status !== 'pending' || JSON.stringify(current) !== JSON.stringify(binding.record))
    throw new Error('提议已变化，请重新读取');
  if (binding.target.feature === 'F231') {
    await send!((current as ProfileUpdateProposal).sourceCatId, instruction.trim());
    return;
  }
  const response = await apiFetch(`/api/proposals/${encodeURIComponent(binding.target.id)}/request-revision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction: instruction.trim() }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? '修改要求未提交');
  await binding.refresh();
}

export interface ScheduleBinding {
  mid: string;
  blockId: string;
  proposal: ScheduleMutationProposal | null;
  current: boolean;
  blocked: boolean;
  /** The task changed after the proposal: it can only be rejected. */
  drifted: boolean;
  error: string | null;
  templates?: { templateId: string; paramSchema: Record<string, { description?: string }> }[];
  templateError?: string | null;
  decide: (decision: 'approve' | 'reject') => Promise<void>;
}
