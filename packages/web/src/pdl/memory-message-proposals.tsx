'use client';
import { memoryOwnerRevisionSchema, type RichCardBlock, type TasteProposal } from '@cat-cafe/shared';
import { useEffect, useLayoutEffect } from 'react';
import { readCorrectionMemory, readPublishedCorrection } from '@/components/memory/page/read-correction-approval';
import { readCorrectionResult } from '@/components/memory/page/read-correction-result';
import { readPersonMemorySource } from '@/components/rich/person-memory-proposal-source';
import { readDomainApprovalResult } from '@/components/rich/read-domain-approval-result';
import { readDomainApprovalSource } from '@/components/rich/read-domain-approval-source';
import { readEvalRepairPending, readEvalRepairResult } from '@/components/rich/read-eval-repair';
import { readApprovalProducerBody } from '@/lib/approval-producer-read';
import { useApprovalResult } from '@/lib/use-approval-result';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { write } from './owner-api';

export interface MemoryMessageTarget {
  feature: 'F193' | 'F221' | 'F260' | 'F266' | 'F321' | 'F276';
  id: string;
  threadId: string;
  mid: string;
  block: RichCardBlock;
}
export async function readMemoryMessage(target: MemoryMessageTarget, signal: AbortSignal, fresh = false) {
  const coordinate = { threadId: target.threadId, messageId: target.mid };
  if (target.feature === 'F266') {
    const item = await readEvalRepairPending(target.id, coordinate, undefined, target.block, fresh);
    if (item) return { item, status: 'pending', evidence: item, effect: false };
    const result = await readEvalRepairResult(target.id, coordinate, undefined, target.block, fresh);
    return result
      ? {
          item: null,
          status:
            result.terminal.resolution === 'accepted'
              ? 'approved'
              : result.terminal.resolution === 'rejected'
                ? 'rejected'
                : 'withdrawn',
          evidence: result.terminal,
          effect: !!result.effect,
        }
      : null;
  }
  if (target.feature === 'F276') {
    const source = await readPersonMemorySource(target.id, coordinate, target.block, undefined, undefined, fresh);
    return source
      ? {
          item: source.item,
          status: source.snapshot.status,
          evidence: source.snapshot,
          effect: source.snapshot.status === 'materialized' || source.snapshot.status === 'partially_materialized',
        }
      : null;
  }
  if (target.feature === 'F321') {
    const item = await readPublishedCorrection(target.block, coordinate);
    const memory = item && (await readCorrectionMemory(item, signal));
    if (item && memory) return { item, status: memory.proposal.status, evidence: memory, effect: false };
    const result = await readCorrectionResult(target.id, coordinate, undefined, !fresh);
    return result
      ? {
          item: null,
          status:
            result.terminal.resolution === 'accepted'
              ? 'approved'
              : result.terminal.resolution === 'rejected'
                ? 'rejected'
                : 'withdrawn',
          evidence: result.terminal,
          effect: result.effect,
        }
      : null;
  }
  const source = await readDomainApprovalSource(target.block, coordinate, fresh);
  if (source) {
    if (target.feature !== 'F221')
      return {
        item: source.item,
        status:
          source.item.resolution === 'open'
            ? 'pending'
            : source.item.resolution === 'accepted'
              ? 'approved'
              : 'rejected',
        evidence: source.row,
        effect: false,
      };
    const body = (await readApprovalProducerBody(
      { owner: source.ownerUserId, producer: target.feature, proposalId: target.id },
      '/api/taste-proposals/' + encodeURIComponent(target.id),
      { signal, fresh },
    )) as { proposal: TasteProposal };
    const proposal = body.proposal;
    if (proposal.id !== target.id || proposal.threadId !== target.threadId || proposal.userId !== source.ownerUserId)
      throw new Error('提议来源已变化');
    return { item: source.item, status: proposal.status, evidence: proposal, effect: false };
  }
  const result = await readDomainApprovalResult(target.block, coordinate, undefined, !fresh);
  return result
    ? {
        item: null,
        status:
          result.terminal.resolution === 'accepted'
            ? 'approved'
            : result.terminal.resolution === 'rejected'
              ? 'rejected'
              : 'withdrawn',
        evidence: result.terminal,
        effect: !!result.effect,
      }
    : null;
}
export type MemoryMessageRead = NonNullable<Awaited<ReturnType<typeof readMemoryMessage>>>;
export interface MemoryMessageBinding {
  target: MemoryMessageTarget;
  read?: MemoryMessageRead | null;
  current: boolean;
  refresh: () => Promise<unknown>;
  busy?: boolean;
}
export async function decideMemoryMessage(binding: MemoryMessageBinding, decision: 'approve' | 'reject') {
  if (!binding.current || !binding.read?.item || binding.target.feature === 'F276') throw new Error('请重新读取提议');
  const next = await readMemoryMessage(binding.target, new AbortController().signal, true);
  if (!next?.item || next.status !== 'pending' || JSON.stringify(next) !== JSON.stringify(binding.read))
    throw new Error('提议已变化，请重新读取');
  if (binding.target.feature !== 'F321') {
    const store = useApprovalHubStore.getState();
    if (decision === 'approve') await store.approveProposal(binding.target.id);
    else await store.rejectProposal(binding.target.id);
    await binding.refresh();
    const attempt = useApprovalHubStore.getState().decisionAttempts[binding.target.id]?.state;
    if (attempt?.phase !== 'response_received' || !attempt.ok)
      throw new Error(useApprovalHubStore.getState().error ?? '尚未确认提议处理结果，请重新读取');
    return;
  }
  const receipt = await write<{ proposalId: string; status: string; appliedRevision?: string }>(
    '/api/event-memory-corrections/' + encodeURIComponent(binding.target.id) + '/' + decision,
    {},
  );
  await binding.refresh();
  if (
    receipt.proposalId !== binding.target.id ||
    receipt.status !== (decision === 'approve' ? 'approved' : 'rejected') ||
    (decision === 'approve' && !memoryOwnerRevisionSchema.safeParse(receipt.appliedRevision).success)
  )
    throw new Error('尚未确认提议处理结果，请重新读取');
}
export function memoryMessageView(binding: MemoryMessageBinding, draft: Record<string, unknown> = {}) {
  const read = binding.read,
    person = binding.target.feature === 'F276';
  const settled =
    read &&
    ['approved', 'rejected', 'materialized', 'partially_materialized', 'withdrawn', 'not_now'].includes(read.status);
  const fields = binding.target.block.fields?.map((field) => ({ k: field.label, v: field.value }));

  const conflict =
    binding.target.feature === 'F260'
      ? (read?.item?.detail.conflict as import('@cat-cafe/shared').EntityConflictContext | undefined)
      : undefined;
  const mid = binding.target.mid,
    selected = String(draft['entity-action-' + mid] ?? '');
  return {
    title: binding.target.block.title,
    conflict: conflict
      ? {
          fingerprint: conflict.fingerprint,
          selected,
          group: 'entity-action-' + mid,
          options: conflict.allowedActions
            .filter((v) => v !== 'reject')
            .map((v) => ({
              v,
              needsNames: v === 'correct' || v === 'transfer',
            })),
          comparison: [
            { field: 'incoming', ...conflict.incoming },
            ...conflict.candidates.map((c) => ({
              field: 'candidate',
              ...c,
            })),
          ],
          replacements: ['correct', 'transfer'].includes(selected)
            ? conflict.canonicalReplacementRequiredFor.map((key) => {
                const id = 'entity-name-' + mid + '-' + key;
                return {
                  key,
                  id,
                  mid,
                  label: conflict.candidates.find((c) => c.entityId === key)!.canonicalName,
                  value: String(draft[id] ?? ''),
                };
              })
            : [],
          busy: !!binding.busy,
          error: draft['entity-error-' + mid] ?? '',
        }
      : null,
    fields,
    first: binding.target.block.bodyMarkdown,
    firstKey: binding.target.id,
    decided: person || !!conflict || !read?.item?.inlineApprovable || !binding.current || read?.status !== 'pending',
    canEditInPlace: false,
    canRequestChange: false,
    canApprove: !person && !conflict && !!read?.item?.inlineApprovable && binding.current && read?.status === 'pending',
    editing: false,
    asking: false,
    rejectable:
      !person &&
      binding.current &&
      read?.status === 'pending' &&
      (!conflict || conflict.allowedActions.includes('reject')),
    okLabel: 'approve',
    memoryOwner: binding.target.feature,
    noticeState: !binding.current || !read ? 'unavailable' : read.status,
    noticeText: '',
    result: settled
      ? {
          key: binding.target.id,
          status: read.status === 'rejected' ? 'rejected' : read.effect ? 'approved' : 'closed',
          reason: read.status === 'approved' && !read.effect ? 'unconfirmed' : read.status,
          fields,
        }
      : null,
  };
}
export function MemoryMessageOwnerBinding({
  target,
  generation = 1,
  changed,
}: {
  target: MemoryMessageTarget;
  generation?: number;
  changed: (binding: MemoryMessageBinding) => void;
}) {
  const busy = useApprovalHubStore((s) => !!s.deciding[target.id]);
  const source = useApprovalResult(
    target.feature,
    target.id,
    'message-native',
    (signal, fresh) => readMemoryMessage(target, signal, fresh),
    undefined,
    false,
  );
  useEffect(() => {
    void source.refresh();
  }, [generation, source.refresh]);
  useLayoutEffect(() => {
    changed({
      target,
      busy,
      read: source.value,
      current: source.value !== undefined && !source.failed && !source.stale && !source.reading,
      refresh: source.refresh,
    });
  }, [target, changed, busy, source.value, source.failed, source.stale, source.reading, source.refresh]);
  return null;
}

export async function resolveMemoryEntity(
  binding: MemoryMessageBinding,
  args: { fingerprint: string; action: string; replacementCanonicalNames?: Record<string, string> },
) {
  const current = await readMemoryMessage(binding.target, new AbortController().signal, true);
  const conflict = current?.item?.detail.conflict as import('@cat-cafe/shared').EntityConflictContext | undefined;
  if (!binding.current || !conflict || current?.status !== 'pending' || conflict.fingerprint !== args.fingerprint)
    throw new Error('提议已变化，请重新读取');
  const action = args.action as import('@cat-cafe/shared').EntityConflictResolutionAction;
  if (!conflict.allowedActions.includes(action)) throw new Error('冲突动作不可用');
  await useApprovalHubStore.getState().resolveEntityConflict(binding.target.id, {
    ...args,
    action,
  });
  await binding.refresh();
  const attempt = useApprovalHubStore.getState().decisionAttempts[binding.target.id]?.state;
  if (attempt?.phase !== 'response_received' || !attempt.ok)
    throw new Error(useApprovalHubStore.getState().error ?? '尚未确认提议处理结果，请重新读取');
}
