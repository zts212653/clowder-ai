'use client';
import type { ApprovalHubItem } from '@cat-cafe/shared';
import { useCallback } from 'react';
import type { ApprovalWriteKind } from '@/components/ApprovalHost';
import { useApprovalHost } from '@/components/ApprovalHost';
import { ApprovalProvenanceLinks } from '@/components/ApprovalProvenanceLinks';
import { EntityConflictResolutionPanel } from '@/components/EntityConflictResolutionPanel';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import { useApprovalItemActions } from '@/components/useApprovalItemActions';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { ApprovalMember } from './ApprovalMember';
import { DispatchApprovalContent, EntityApprovalContent, TasteApprovalContent } from './DomainApprovalContent';
import { domainApprovalCopy } from './domain-approval.shell-copy';
import { useTasteApprovalStatus } from './use-taste-approval-status';

export type DomainApprovalFeature = 'F193' | 'F221' | 'F260';
export function isDomainApprovalFeature(feature: string): feature is DomainApprovalFeature {
  return feature === 'F193' || feature === 'F221' || feature === 'F260';
}
/** Shared chrome, three original domain bodies and their existing writers. No generic explanation or copied lifecycle. */
export function DomainApprovalCard({
  item,
  beforeWrite,
  afterWrite,
}: {
  item: ApprovalHubItem;
  beforeWrite?: (kind: ApprovalWriteKind) => Promise<boolean>;
  afterWrite?: () => Promise<void>;
}) {
  const t = useShellCopy(domainApprovalCopy),
    language = useShellLanguage();
  const taste = useTasteApprovalStatus(item);
  const tasteBeforeWrite = taste.beforeWrite,
    tasteRefresh = taste.refresh;
  const prepare = useCallback(
    async (kind: ApprovalWriteKind) => {
      if (beforeWrite && !(await beforeWrite(kind))) return false;
      return tasteBeforeWrite(kind);
    },
    [beforeWrite, tasteBeforeWrite],
  );
  const refresh = useCallback(async () => {
    await tasteRefresh();
    await afterWrite?.();
  }, [afterWrite, tasteRefresh]);
  const actions = useApprovalItemActions(item, prepare, refresh);
  if (!isDomainApprovalFeature(item.sourceFeatureId)) return null;
  return (
    <article
      data-testid={`approval-item-${item.proposalId}`}
      className="space-y-3 rounded-xl p-3 text-sm"
      style={{ color: 'var(--shell-ink)', background: 'var(--shell-paper)', border: '1px solid var(--shell-hairline)' }}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--shell-muted)]">
        <span data-testid="approval-feature-badge">{t.kind[item.sourceFeatureId]}</span>
        <ApprovalMember catId={item.requesterCatId} />
        <time className="ml-auto whitespace-nowrap">
          {new Date(item.createdAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}
        </time>
      </header>
      {item.sourceFeatureId === 'F193' ? (
        <DispatchApprovalContent item={item} />
      ) : item.sourceFeatureId === 'F221' ? (
        <TasteApprovalContent item={item} />
      ) : (
        <EntityApprovalContent item={item} />
      )}
      {item.resolution !== 'open' ? (
        <output data-testid="approval-lifecycle-badge">
          {item.resolution === 'accepted'
            ? t.accepted[item.materialization.state]
            : item.resolution === 'rejected'
              ? t.rejectedResult
              : t.closedResult}
        </output>
      ) : null}
      <DomainApprovalActions item={item} actions={actions} tasteStatus={taste.status} />
      {actions.feedbackDialog}
    </article>
  );
}

function DomainApprovalActions({
  item,
  actions,
  tasteStatus,
}: {
  item: ApprovalHubItem;
  actions: ReturnType<typeof useApprovalItemActions>;
  tasteStatus: ReturnType<typeof useTasteApprovalStatus>['status'];
}) {
  const t = useShellCopy(domainApprovalCopy);
  const { writesLocked } = useApprovalHost();
  const pending = item.resolution === 'open';
  const busy = Boolean(actions.decidingState) || actions.checking;
  const policy = actionPolicy(item, tasteStatus, Boolean(actions.entityConflict), actions.isStale);
  return (
    <>
      {pending && actions.entityConflict ? (
        <EntityConflictResolutionPanel
          conflict={actions.entityConflict}
          deciding={busy}
          error={typeof item.detail.conflictError === 'string' ? item.detail.conflictError : undefined}
          onResolve={actions.handleEntityResolution}
          onReject={actions.handleReject}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {policy.approve ? (
          <button
            data-testid="approve-btn"
            type="button"
            disabled={busy || writesLocked || policy.locked}
            className="shell-focusable rounded-md px-3 py-1.5 text-sm disabled:opacity-50"
            style={{ background: 'var(--shell-primary)', color: 'var(--shell-primary-on)' }}
            onClick={actions.handleApprove}
          >
            {busy ? t.submitting : policy.recovering ? t.resume : t.approve}
          </button>
        ) : null}
        {policy.reject ? (
          <button
            data-testid="reject-btn"
            type="button"
            disabled={busy || writesLocked || policy.locked}
            className="shell-focusable rounded-md border border-[var(--shell-hairline)] px-3 py-1.5 text-sm disabled:opacity-50"
            onClick={actions.handleReject}
          >
            {actions.isStale ? t.clear : t.reject}
          </button>
        ) : null}
        <DomainOriginalPlace item={item} />
      </div>
    </>
  );
}

function DomainOriginalPlace({ item }: { item: ApprovalHubItem }) {
  const { presentation, originalPlaceAction } = useApprovalHost();
  const close = useApprovalHubStore((s) => s.close);
  if (presentation !== 'mailbox')
    return <ApprovalProvenanceLinks navigation={item.navigation} onBeforeNavigate={close} />;
  if (!originalPlaceAction) return null;
  return (
    <div
      className="ml-auto flex max-w-full flex-none items-center justify-end gap-2"
      data-testid="domain-approval-place-actions"
    >
      {originalPlaceAction}
    </div>
  );
}

function actionPolicy(
  item: ApprovalHubItem,
  tasteStatus: ReturnType<typeof useTasteApprovalStatus>['status'],
  conflict: boolean,
  stale: boolean,
) {
  const pending = item.resolution === 'open';
  const recovering = item.sourceFeatureId === 'F221' && tasteStatus === 'approving';
  return {
    recovering,
    locked: item.sourceFeatureId === 'F221' && tasteStatus !== 'pending' && !recovering,
    approve: recovering || (pending && item.inlineApprovable && !conflict && !stale),
    reject: pending && !conflict && !recovering,
  };
}
