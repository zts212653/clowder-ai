'use client';
import { useEffect, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import type { QueueEntry } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { SteerQueuedEntryModal, type SteerSubmission } from './SteerQueuedEntryModal';
import {
  parseSteerSourceRecordId,
  parseSteerSourceTargetStates,
  parseSteerThreadCatProjection,
  type SteerSourceTargetState,
  type SteerThreadCatProjection,
} from './steer-target-selection';

/** Both chat shells use the same server-fenced selection and delivery commands. */
export function QueueSteerDialog({
  threadId,
  entry,
  queue,
  onCancel,
  onConfirm,
}: {
  threadId: string;
  entry: QueueEntry;
  queue: readonly QueueEntry[];
  onCancel: () => void;
  onConfirm: (submission: SteerSubmission) => void;
}) {
  const { cats } = useCatData();
  const resolveCatName = useCatNameResolver();
  const steerEntryId = entry.id;
  const selectedSteerEntry = entry;
  const [steerContext, setSteerContext] = useState<
    SteerThreadCatProjection & {
      threadId: string | null;
      entryId: string | null;
      sourceTargets: SteerSourceTargetState[];
      sourceRecordId: string | null;
      state: 'loading' | 'ready' | 'unavailable';
    }
  >({
    threadId: null,
    entryId: null,
    participantActivity: [],
    fallbackTargetCatId: null,
    sourceTargets: [],
    sourceRecordId: null,
    state: 'loading',
  });

  useEffect(() => {
    if (!steerEntryId) {
      setSteerContext({
        threadId: null,
        entryId: null,
        participantActivity: [],
        fallbackTargetCatId: null,
        sourceTargets: [],
        sourceRecordId: null,
        state: 'loading',
      });
      return;
    }
    let current = true;
    setSteerContext({
      threadId,
      entryId: steerEntryId,
      participantActivity: [],
      fallbackTargetCatId: null,
      sourceTargets: [],
      sourceRecordId: null,
      state: 'loading',
    });
    void Promise.all([
      apiFetch(`/api/threads/${encodeURIComponent(threadId)}/cats`),
      apiFetch(`/api/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(steerEntryId)}/targets`),
    ])
      .then(async ([catsResponse, targetsResponse]) => {
        if (!catsResponse.ok || !targetsResponse.ok) throw new Error('Steer context unavailable');
        return Promise.all([catsResponse.json(), targetsResponse.json()]);
      })
      .then(([catsBody, targetsBody]) => {
        if (!current) return;
        setSteerContext({
          threadId,
          entryId: steerEntryId,
          ...parseSteerThreadCatProjection(catsBody),
          sourceTargets: parseSteerSourceTargetStates(targetsBody),
          sourceRecordId: parseSteerSourceRecordId(targetsBody),
          state: 'ready',
        });
      })
      .catch(() => {
        if (current) {
          setSteerContext({
            threadId,
            entryId: steerEntryId,
            participantActivity: [],
            fallbackTargetCatId: null,
            sourceTargets: [],
            sourceRecordId: null,
            state: 'unavailable',
          });
        }
      });
    return () => {
      current = false;
    };
  }, [steerEntryId, threadId]);

  const selectedSteerTargets = (() => {
    if (!selectedSteerEntry) return [];
    const currentContext =
      steerContext.threadId === threadId &&
      steerContext.entryId === selectedSteerEntry.id &&
      steerContext.state === 'ready'
        ? steerContext
        : null;
    if (!currentContext) return [];
    const catById = new Map(cats.map((cat) => [cat.id, cat]));
    const siblingEntries = queue.filter(
      (candidate) =>
        candidate.status === 'queued' &&
        selectedSteerEntry.messageId &&
        candidate.messageId === selectedSteerEntry.messageId,
    );
    const rowByTarget = new Map(
      siblingEntries.flatMap((entry) => entry.targetCats.map((targetCatId) => [targetCatId, entry] as const)),
    );
    const participantActivity = currentContext.participantActivity;
    const participantIds = new Set(participantActivity.map((participant) => participant.catId));
    const candidateIds = new Set<string>();
    for (const participant of participantActivity) candidateIds.add(participant.catId);
    for (const target of currentContext.sourceTargets) candidateIds.add(target.targetCatId);
    for (const targetId of Object.keys(selectedSteerEntry.authorIntentByTarget ?? {})) candidateIds.add(targetId);
    for (const targetCatId of selectedSteerEntry.targetCats) candidateIds.add(targetCatId);
    const fallbackId = currentContext.fallbackTargetCatId ?? undefined;
    if (fallbackId) candidateIds.add(fallbackId);
    const pendingTargetIds = new Set(siblingEntries.flatMap((entry) => entry.targetCats));
    if (selectedSteerEntry.targetCats.length === 0 && fallbackId) pendingTargetIds.add(fallbackId);
    return [...candidateIds].flatMap((targetId) => {
      const cat = catById.get(targetId);
      if (!cat) return [];
      const sourceTarget = currentContext.sourceTargets.find((target) => target.targetCatId === targetId);
      const delivered = sourceTarget ? sourceTarget.state !== 'pending' : false;
      const row = rowByTarget.get(targetId);
      return [
        {
          id: targetId,
          label: resolveCatName(targetId),
          ...(cat.avatar ? { avatar: cat.avatar } : {}),
          canGuideReply: cat.messageDeliveryCapabilities?.guideReply === true,
          defaultSelected: pendingTargetIds.has(targetId) && !delivered,
          pending: sourceTarget?.state === 'pending' && sourceTarget.actionable,
          delivered,
          unavailable: cat.roster?.available === false,
          disposition: row?.authorIntentByTarget?.[targetId]?.requested ?? 'next_work',
          membershipAtOpen: participantIds.has(targetId) ? ('member' as const) : ('admit' as const),
        },
      ];
    });
  })();

  return (
    <SteerQueuedEntryModal
      sourceRecordId={steerContext.sourceRecordId ?? entry.messageId ?? ''}
      targets={selectedSteerTargets}
      contextState={
        steerContext.threadId === threadId && steerContext.entryId === entry.id ? steerContext.state : 'loading'
      }
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
