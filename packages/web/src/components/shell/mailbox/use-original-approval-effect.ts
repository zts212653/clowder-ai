import { correctionEffectConfirmed } from '@/components/memory/page/read-correction-result';
import { readEvalRepairResult } from '@/components/rich/read-eval-repair';
import { readScheduleSource, scheduleEffect } from '@/components/rich/read-schedule-approval';
import { readApprovalProducerBody } from '@/lib/approval-producer-read';
import { approvalResultRead } from '@/lib/approval-result-read';
import { producerCommittedEffect } from '@/lib/producer-result-effect';
import { useApprovalResult } from '@/lib/use-approval-result';
import { canonicalDomainEffect, type DomainApprovalEffect, domainAttemptEffect } from '@/stores/approval-domain-effect';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import type { ApprovalSession } from './approval-sessions';

export type OriginalApprovalEffect =
  | 'handoff-started'
  | 'profile-written'
  | 'memory-corrected'
  | 'schedule-created'
  | 'schedule-deleted'
  | 'repair-started'
  | DomainApprovalEffect;

/** A producer's owner GET can confirm its historical effect even when the generic Hub adapter has no effect projection. */
export function useOriginalApprovalEffect(
  session: Pick<ApprovalSession, 'approval' | 'model' | 'ownerUserId' | 'key'>,
  readEnabled = true,
): OriginalApprovalEffect | null {
  const { approval, model } = session;
  const feature = approval.sourceFeatureId;
  const eligible =
    model.state.kind === 'decided' &&
    model.state.terminal?.resolution === 'accepted' &&
    ['F225', 'F231', 'F221', 'F193', 'F260', 'F321', 'F139', 'F266'].includes(feature);
  const canonical =
    model.state.kind === 'decided'
      ? (model.state.terminal?.domainEffect ?? canonicalDomainEffect(approval))
      : undefined;
  const attempt = useApprovalHubStore((state) => state.decisionAttempts[approval.proposalId]);
  const receipt =
    approval.navigation.state === 'anchored'
      ? domainAttemptEffect(attempt, session.ownerUserId, feature, approval.navigation.approvalCardRef)
      : undefined;
  const repair =
    feature === 'F266' && approval.materialization.state === 'succeeded' ? ('repair-started' as const) : null;
  const proof =
    approval.materialization.state === 'succeeded' &&
    approval.materialization.effectProofRef === approval.detail.canonicalEffectProofRef
      ? approval.materialization.effectProofRef
      : null;
  let retained: OriginalApprovalEffect | null = null;
  if (proof && feature === 'F225' && proof.startsWith(`session-handoff:${approval.proposalId}:continuation:`))
    retained = 'handoff-started';
  if (proof && feature === 'F231' && proof.startsWith(`profile-update:${approval.proposalId}:provenance:`))
    retained = 'profile-written';
  if (
    proof &&
    feature === 'F321' &&
    proof === `event-memory:${approval.detail.eventId}:revision:${approval.detail.appliedRevision}`
  )
    retained = 'memory-corrected';
  if (
    proof &&
    feature === 'F139' &&
    proof ===
      `schedule-proposal:${approval.proposalId}:checkpoint:${approval.detail.mutationKind}:${approval.detail.taskId}`
  ) {
    if (approval.detail.mutationKind === 'create') retained = 'schedule-created';
    if (approval.detail.mutationKind === 'delete') retained = 'schedule-deleted';
  }
  const enabled = eligible && readEnabled && !canonical && !receipt && !repair && !retained;
  const result = useApprovalResult<OriginalApprovalEffect | null>(
    feature,
    enabled ? approval.proposalId : null,
    'effect',
    async (signal) => {
      if (feature === 'F266') {
        if (approval.navigation.state !== 'anchored') return null;
        return (
          (
            await readEvalRepairResult(approval.proposalId, approval.navigation.approvalCardRef, {
              ...approval,
              ownerUserId: session.ownerUserId,
            })
          )?.effect ?? null
        );
      }
      if (feature === 'F139') {
        if (approval.navigation.state !== 'anchored') return null;
        const proposal = await readScheduleSource(approval.proposalId, approval.navigation.approvalCardRef, {
          ...approval,
          ownerUserId: session.ownerUserId,
        });
        return proposal ? scheduleEffect(proposal) : null;
      }
      if (feature !== 'F225' && feature !== 'F231' && feature !== 'F221' && feature !== 'F321') return null;
      const prefixes = {
        F225: 'session-handoff',
        F231: 'profile-updates',
        F321: 'event-memory-corrections',
        F221: 'taste-proposals',
      } as const;
      const body = await readApprovalProducerBody(
        { owner: session.ownerUserId, producer: feature, proposalId: approval.proposalId },
        `/api/${prefixes[feature]}/${encodeURIComponent(approval.proposalId)}`,
        { signal },
      );
      const effect =
        feature === 'F321'
          ? correctionEffectConfirmed(body, approval.proposalId)
            ? ('memory-corrected' as const)
            : null
          : producerCommittedEffect(body, feature, approval.proposalId, approval.detail.sourceSessionId);
      if (effect) {
        const key = { owner: session.ownerUserId, producer: feature, proposalId: approval.proposalId };
        approvalResultRead.terminal(key);
      }
      return effect;
    },
    session.ownerUserId,
  );
  return eligible ? (canonical ?? receipt ?? repair ?? retained ?? result.value ?? null) : null;
}
