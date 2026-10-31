import type { ApprovalHubItem, RichCardBlock, ScheduleMutationProposal } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useGuardedWrite, useWriteBlocked } from '@/components/ApprovalHost';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import { UNIFIED_ATTENTION_INVALIDATION_EVENTS } from '@/components/shell/use-unified-attention';
import { apiFetch } from '@/utils/api-client';
import {
  readScheduleSource,
  type ScheduleCoordinate,
  sameScheduleValue,
  scheduleObject,
  schedulePublicationCandidate,
} from './read-schedule-approval';
import { scheduleApprovalCopy } from './schedule-approval.shell-copy';
import { useOriginalApprovalRead } from './use-original-approval-read';

export interface ScheduleApprovalProps {
  block?: RichCardBlock;
  item?: ApprovalHubItem;
  coordinate?: ScheduleCoordinate;
  messageId?: string;
}
/** One original card read generation and one original writer. Closing/replacing the card invalidates preparation. */
export function useScheduleApprovalController({ block, item, coordinate, messageId }: ScheduleApprovalProps) {
  const t = useShellCopy(scheduleApprovalCopy),
    language = useShellLanguage();
  // Equal host data is the same read binding; a fresh object must not cancel an in-flight preparation.
  const stableItem = useRef(item);
  if (!sameScheduleValue(stableItem.current, item)) stableItem.current = item;
  const readItem = stableItem.current;
  const proposalId =
    item?.sourceFeatureId === 'F139' ? item.proposalId : block ? schedulePublicationCandidate(block) : null;
  const ref = item?.navigation.state === 'anchored' ? item.navigation.approvalCardRef : coordinate;
  // messageId alone is not a thread coordinate and cannot authorize this card.
  const threadId = ref?.threadId,
    cardMessageId = ref?.messageId ?? messageId;
  const liveBinding = useRef({ readItem, block, proposalId, threadId, cardMessageId });
  liveBinding.current = { readItem, block, proposalId, threadId, cardMessageId };
  const original = useOriginalApprovalRead(
    'F139',
    proposalId,
    { threadId, messageId: cardMessageId, block },
    async (_signal, fresh) =>
      proposalId && threadId && cardMessageId
        ? readScheduleSource(proposalId, { threadId, messageId: cardMessageId }, readItem, fresh)
        : null,
    item?.ownerUserId,
  );
  const remembered = useRef<{ owner: string | null; value: ScheduleMutationProposal } | null>(null);
  if (remembered.current?.owner !== original.ownerUserId) remembered.current = null;
  if (original.value) remembered.current = { owner: original.ownerUserId, value: original.value };
  const proposal = original.ownerUserId ? (remembered.current?.value ?? null) : null;
  const checking = original.reading || (original.value === undefined && !original.failed && !original.retained);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [unknown, setUnknown] = useState(false);
  const live = useRef<ScheduleMutationProposal | null>(null),
    mounted = useRef(true),
    inFlight = useRef(false);
  live.current = original.value && !checking && !original.failed ? original.value : null;
  const guardedWrite = useGuardedWrite(),
    blocked = useWriteBlocked(busy || checking || unknown || !original.value || original.failed);
  const refresh = useCallback(async () => {
    const next = (await original.refresh()) ?? null;
    live.current = next;
    if (mounted.current) setError(next ? null : t.unavailable);
    return next;
  }, [original.refresh, t.unavailable]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      live.current = null;
    };
  }, []);
  const decide = useCallback(
    async (decision: 'approve' | 'reject') => {
      const previous = live.current;
      const expectedBinding = liveBinding.current;
      if (
        !previous ||
        blocked ||
        inFlight.current ||
        (decision === 'reject'
          ? previous.status !== 'pending'
          : previous.status !== 'pending' && previous.status !== 'applying')
      )
        return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        const next = await refresh();
        if (!mounted.current) return;
        if (!next || !sameScheduleValue(previous, next) || !sameScheduleValue(expectedBinding, liveBinding.current)) {
          setError(t.changed);
          return;
        }
        const result = await guardedWrite('producer-card', async (report) => {
          const response = await apiFetch(
            `/api/schedule-proposals/${encodeURIComponent(previous.proposalId)}/${decision}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
          );
          report(
            response.ok
              ? { outcome: 'settled', status: response.status }
              : { outcome: 'http-error', status: response.status },
          );
          const body: unknown = await response.json().catch(() => null);
          return (
            response.ok &&
            scheduleObject(body) &&
            body.proposalId === previous.proposalId &&
            body.status === (decision === 'approve' ? 'approved' : 'rejected')
          );
        });
        if (!mounted.current || !result.sent) return;
        const current = await refresh();
        if (!mounted.current) return;
        const terminal = current?.status === 'approved' || current?.status === 'rejected';
        setUnknown(!terminal && !result.value && current?.status !== 'applying');
        if (!terminal) setError(result.value ? t.unknown : current?.status === 'applying' ? t.failed : t.unknown);
        for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.dispatchEvent(new Event(event));
      } catch {
        if (mounted.current) {
          await refresh();
          setUnknown(true);
          setError(t.unknown);
        }
      } finally {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [blocked, refresh, guardedWrite, t.changed, t.failed, t.unknown],
  );
  const reread = () => {
    setUnknown(false);
    setError(null);
    void refresh();
  };
  return {
    t,
    language,
    proposal,
    checking,
    busy,
    error,
    unknown,
    blocked,
    decide,
    reread,
    retained: original.retained,
  };
}
