import { useEffect, useState } from 'react';
import { correctionEffectConfirmed } from '@/components/memory/page/read-correction-result';
import { readEvalRepairResult } from '@/components/rich/read-eval-repair';
import { readScheduleSource, scheduleEffect } from '@/components/rich/read-schedule-approval';
import { canonicalDomainEffect, type DomainApprovalEffect, domainAttemptEffect } from '@/stores/approval-domain-effect';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { apiFetch } from '@/utils/api-client';
import type { ApprovalSession } from './approval-sessions';

export type OriginalApprovalEffect =
  | 'handoff-started'
  | 'profile-written'
  | 'memory-corrected'
  | 'schedule-created'
  | 'schedule-deleted'
  | 'repair-started'
  | DomainApprovalEffect;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function confirmedEffect(
  value: unknown,
  feature: string,
  proposalId: string,
  originalSession: unknown,
): OriginalApprovalEffect | null {
  const body = asRecord(value);
  if (feature === 'F321') return correctionEffectConfirmed(value, proposalId) ? 'memory-corrected' : null;
  const record = feature === 'F225' ? asRecord(body?.proposal) : body;
  if (record?.proposalId !== proposalId || record?.status !== 'approved') return null;
  if (feature === 'F221') return 'taste-written';
  // F225 approved crosses note + seal + continuation enqueue; correlate the original session witness too.
  if (feature === 'F225') {
    return typeof originalSession === 'string' && originalSession && record.sealedSessionId === originalSession
      ? 'handoff-started'
      : null;
  }
  // F231 approved is finalized only after the original filesystem/provenance write pipeline commits.
  return feature === 'F231' ? 'profile-written' : null;
}

/** A producer's owner GET can confirm its historical effect even when the generic Hub adapter has no effect projection. */
export function useOriginalApprovalEffect(
  session: Pick<ApprovalSession, 'approval' | 'model' | 'ownerUserId' | 'key'>,
  readEnabled = true,
): OriginalApprovalEffect | null {
  const { approval, model } = session;
  const feature = approval.sourceFeatureId;
  const originalSession = approval.detail.sourceSessionId;
  const eligible =
    model.state.kind === 'decided' &&
    model.state.terminal?.resolution === 'accepted' &&
    (feature === 'F225' ||
      feature === 'F231' ||
      feature === 'F221' ||
      feature === 'F193' ||
      feature === 'F260' ||
      feature === 'F321' ||
      feature === 'F139' ||
      feature === 'F266');
  const enabled = readEnabled && eligible;
  const canonical =
    model.state.kind === 'decided'
      ? (model.state.terminal?.domainEffect ?? canonicalDomainEffect(approval))
      : undefined;
  const attempt = useApprovalHubStore((s) => s.decisionAttempts[approval.proposalId]);
  const receipt =
    approval.navigation.state === 'anchored'
      ? domainAttemptEffect(attempt, session.ownerUserId, feature, approval.navigation.approvalCardRef)
      : undefined;
  const key = `${session.key}:${typeof originalSession === 'string' ? originalSession : ''}`;
  const [confirmed, setConfirmed] = useState<{ key: string; effect: OriginalApprovalEffect } | null>(null);
  useEffect(() => {
    if (
      !enabled ||
      receipt ||
      (feature !== 'F225' &&
        feature !== 'F231' &&
        feature !== 'F221' &&
        feature !== 'F321' &&
        feature !== 'F139' &&
        feature !== 'F266')
    )
      return;
    let current = true;
    if (feature === 'F266') {
      if (approval.navigation.state === 'anchored')
        void readEvalRepairResult(approval.proposalId, approval.navigation.approvalCardRef, {
          ...approval,
          ownerUserId: session.ownerUserId,
        })
          .then((result) => {
            if (current && result?.effect) setConfirmed({ key, effect: result.effect });
          })
          .catch(() => {});
      return () => {
        current = false;
      };
    }
    if (feature === 'F139') {
      if (approval.navigation.state === 'anchored') {
        void readScheduleSource(approval.proposalId, approval.navigation.approvalCardRef, {
          ...approval,
          ownerUserId: session.ownerUserId,
        })
          .then((proposal) => {
            const effect = proposal ? scheduleEffect(proposal) : null;
            if (current && effect) setConfirmed({ key, effect });
          })
          .catch(() => {});
      }
      return () => {
        current = false;
      };
    }
    const prefix =
      feature === 'F225'
        ? 'session-handoff'
        : feature === 'F231'
          ? 'profile-updates'
          : feature === 'F321'
            ? 'event-memory-corrections'
            : 'taste-proposals';
    void apiFetch(`/api/${prefix}/${encodeURIComponent(approval.proposalId)}`, {}, { afterCurrentGet: true })
      .then(async (response) => {
        if (!response.ok) return;
        const effect = confirmedEffect(await response.json(), feature, approval.proposalId, originalSession);
        if (current && effect) setConfirmed({ key, effect });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [enabled, feature, approval, session.ownerUserId, originalSession, key, receipt]);
  return eligible ? (canonical ?? receipt ?? (enabled && confirmed?.key === key ? confirmed.effect : null)) : null;
}
