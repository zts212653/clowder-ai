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
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity } from '@/utils/api-session-identity';

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
  if (
    !proposal ||
    proposal.proposalId !== target.id ||
    proposal.sourceThreadId !== target.threadId ||
    (proposal.cardMessageId !== undefined && proposal.cardMessageId !== target.mid) ||
    (target.feature !== 'F225'
      ? !('createdBy' in proposal) ||
        proposal.createdBy !== owner ||
        (target.feature === 'F128' && !readableProposedFields(proposal as unknown as Record<string, unknown>))
      : !('userId' in proposal) || proposal.userId !== owner || proposal.kind !== 'session_handoff')
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
export async function decideProposal(
  binding: ProposalBinding,
  decision: 'approve' | 'reject',
  edits?: Record<string, string>,
) {
  const { target, record } = binding;
  if (!binding.current || !record) throw new Error('请重新读取提议');
  const current = await readProposal(target, undefined, true);
  if (
    JSON.stringify(current) !== JSON.stringify(record) ||
    (current.status !== 'pending' &&
      !(target.feature === 'F225' && decision === 'approve' && current.status === 'approving'))
  )
    throw new Error('提议已变化，请重新读取');
  if (target.feature === 'F231') {
    await postProfileUpdateDecision(target.id, decision);
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
  const response = await apiFetch(`${path}${encodeURIComponent(target.id)}/${decision}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '提议未提交');
  await binding.refresh();
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
    terminal = ['approved', 'rejected', 'withdrawn', 'expired'].includes(p.status);
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
      : Object.entries((p as SessionHandoffProposal).note)
          .filter(([, v]) => typeof v === 'string')
          .map(([field, v]) => ({ field, v }));
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
    editing: editing && !terminal,
    canEditInPlace: !!thread && binding.current && p.status === 'pending',
    canRequestChange: !!(thread || profile) && binding.current && p.status === 'pending',
    canApprove: binding.current && p.status === 'pending',
    asking: asking && !terminal,
    askId: 'proposal-ask-' + encodeURIComponent(binding.target.id),
    rejectable: binding.current && p.status === 'pending',
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
