import { type Dispatch, type SetStateAction, useEffect } from 'react';
import type { RichCardBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

type ProfileUpdateDecision = 'approve' | 'reject';
type ProfileUpdateTerminalStatus = 'approved' | 'rejected';

interface ProfileUpdateDecisionArgs {
  action: string;
  block: RichCardBlock;
  copiedAction: string | null;
  messageId?: string;
  payload?: Record<string, unknown>;
  setCopiedAction: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
}

export function isProfileUpdateDecisionAction(action: string): boolean {
  return action === 'profile-update:approve' || action === 'profile-update:reject';
}

export function useProfileUpdateTerminalSync({ block, messageId }: { block: RichCardBlock; messageId?: string }): void {
  const proposalId = getProfileUpdateProposalId(block);
  useEffect(() => {
    if (!messageId || !proposalId || typeof window === 'undefined') return;
    let cancelled = false;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ proposalId?: unknown; status?: unknown }>).detail;
      if (!detail || detail.proposalId !== proposalId) return;
      collapseProfileUpdateCardForStatus(detail.status, block, messageId);
    };
    window.addEventListener('cat-cafe:proposal-updated', handler);
    void hydrateProfileUpdateStatus(proposalId).then((status) => {
      if (!cancelled) collapseProfileUpdateCardForStatus(status, block, messageId);
    });
    return () => {
      cancelled = true;
      window.removeEventListener('cat-cafe:proposal-updated', handler);
    };
  }, [block, messageId, proposalId]);
}

export async function handleProfileUpdateDecisionAction({
  action,
  block,
  copiedAction,
  messageId,
  payload,
  setCopiedAction,
  setError,
  setLoading,
}: ProfileUpdateDecisionArgs): Promise<void> {
  const proposalId = typeof payload?.proposalId === 'string' ? payload.proposalId : '';
  if (!proposalId) {
    setError('proposalId 缺失，无法处理该提议（卡片可能过期 — 硬刷新 Cmd+Shift+R）');
    return;
  }

  const decision = resolveProfileUpdateDecision(action);
  if (copiedAction === `profile-update:${decision}`) return;

  setLoading(true);
  setError(null);
  try {
    const terminalStatus = await postProfileUpdateDecision(proposalId, decision);
    setCopiedAction(`profile-update:${decision}`);
    collapseProfileUpdateCardForStatus(terminalStatus ?? statusForDecision(decision), block, messageId);
  } catch (err) {
    setError(err instanceof Error ? err.message : '操作失败');
  } finally {
    setLoading(false);
  }
}

function resolveProfileUpdateDecision(action: string): ProfileUpdateDecision {
  if (action === 'profile-update:approve') return 'approve';
  if (action === 'profile-update:reject') return 'reject';
  throw new Error(`unknown profile-update action: ${action}`);
}

function getProfileUpdateProposalId(block: RichCardBlock): string {
  for (const action of block.actions ?? []) {
    if (!isProfileUpdateDecisionAction(action.action)) continue;
    const proposalId = action.payload?.proposalId;
    if (typeof proposalId === 'string') return proposalId;
  }
  return '';
}

async function hydrateProfileUpdateStatus(proposalId: string): Promise<unknown> {
  try {
    const res = await apiFetch(`/api/profile-updates/${encodeURIComponent(proposalId)}`);
    if (!res.ok) return undefined;
    const body = (await res.json()) as { proposalId?: unknown; status?: unknown };
    return body.proposalId === proposalId ? body.status : undefined;
  } catch {
    return undefined;
  }
}

async function postProfileUpdateDecision(
  proposalId: string,
  decision: ProfileUpdateDecision,
): Promise<ProfileUpdateTerminalStatus | undefined> {
  const res = await apiFetch(`/api/profile-updates/${encodeURIComponent(proposalId)}/${decision}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; status?: unknown };
  if (res.ok) {
    return isTerminalStatus(body.status) ? body.status : undefined;
  }
  if (!res.ok) {
    if (res.status === 409 && isTerminalStatus(body.status)) return body.status;
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

function isTerminalStatus(status: unknown): status is ProfileUpdateTerminalStatus {
  return status === 'approved' || status === 'rejected';
}

function statusForDecision(decision: ProfileUpdateDecision): ProfileUpdateTerminalStatus {
  return decision === 'approve' ? 'approved' : 'rejected';
}

function collapseProfileUpdateCardForStatus(status: unknown, block: RichCardBlock, messageId?: string): void {
  if (!isTerminalStatus(status)) return;
  collapseProfileUpdateCard({ approved: status === 'approved', block, messageId });
}

function collapseProfileUpdateCard({
  approved,
  block,
  messageId,
}: {
  approved: boolean;
  block: RichCardBlock;
  messageId?: string;
}): void {
  if (!messageId) return;
  useChatStore.getState().updateRichBlock(messageId, block.id, {
    ...block,
    tone: approved ? 'success' : 'info',
    bodyMarkdown: approved ? '✓ 已批准并写入 primer' : '已驳回该提议',
    actions: undefined,
  });
}
