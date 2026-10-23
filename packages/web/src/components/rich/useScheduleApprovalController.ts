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
  const [proposal, setProposal] = useState<ScheduleMutationProposal | null>(null);
  const [checking, setChecking] = useState(true),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [unknown, setUnknown] = useState(false);
  const live = useRef<ScheduleMutationProposal | null>(null),
    generation = useRef(0),
    mounted = useRef(true),
    inFlight = useRef(false);
  const guardedWrite = useGuardedWrite(),
    blocked = useWriteBlocked(busy || checking || unknown || !proposal);
  const refresh = useCallback(async () => {
    const round = ++generation.current;
    live.current = null;
    setChecking(true);
    try {
      const next =
        proposalId && threadId && cardMessageId
          ? await readScheduleSource(proposalId, { threadId, messageId: cardMessageId }, readItem)
          : null;
      if (round !== generation.current || !mounted.current) return null;
      live.current = next;
      setProposal(next);
      setError(next ? null : t.unavailable);
      return next;
    } catch {
      if (round === generation.current && mounted.current) {
        setProposal(null);
        setError(t.unavailable);
      }
      return null;
    } finally {
      if (round === generation.current && mounted.current) setChecking(false);
    }
  }, [proposalId, threadId, cardMessageId, readItem, t.unavailable]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const invalidate = () => {
      if (!inFlight.current) void refresh();
    };
    for (const event of [...UNIFIED_ATTENTION_INVALIDATION_EVENTS, 'cat-cafe:proposal-updated'])
      window.addEventListener(event, invalidate);
    return () => {
      mounted.current = false;
      ++generation.current;
      live.current = null;
      for (const event of [...UNIFIED_ATTENTION_INVALIDATION_EVENTS, 'cat-cafe:proposal-updated'])
        window.removeEventListener(event, invalidate);
    };
  }, [refresh]);
  const decide = useCallback(
    async (decision: 'approve' | 'reject') => {
      const previous = live.current;
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
        if (!next || !sameScheduleValue(previous, next)) {
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
  return { t, language, proposal, checking, busy, error, unknown, blocked, decide, reread };
}
