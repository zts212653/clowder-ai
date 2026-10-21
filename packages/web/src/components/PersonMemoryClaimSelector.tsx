'use client';
import type { ApprovalHubItem } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCoCreatorDisplay } from '@/hooks/useCoCreatorConfig';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { type ApprovalWriteKind, useApprovalHost, useGuardedWrite, useReportEditing } from './ApprovalHost';
import { EventDraftDetails, kindLabel, readDrafts, sourceLabel } from './PersonMemoryDraftDetails';
import { personMemorySelectionCopy } from './person-memory-selection.shell-copy';
import { useShellCopy } from './shell/shell-copy';
import { useShellLanguage } from './shell/shell-language';

export function PersonMemoryClaimSelector({
  item,
  onReject,
  beforeWrite,
  afterWrite,
  blocked = false,
  undoReceiptRequestId,
}: {
  item: ApprovalHubItem;
  onReject: () => void;
  beforeWrite?: () => Promise<boolean>;
  afterWrite?: () => Promise<void>;
  blocked?: boolean;
  undoReceiptRequestId?: string;
}) {
  const t = useShellCopy(personMemorySelectionCopy),
    language = useShellLanguage();
  const ownerName = useCoCreatorDisplay().name;
  const drafts = useMemo(() => readDrafts(item), [item]);
  const displayName = typeof item.detail.displayName === 'string' ? item.detail.displayName : t.unnamed;
  const replacesProposalId =
    typeof item.detail.replacesProposalId === 'string' ? item.detail.replacesProposalId : undefined;
  const draftIds = useMemo(() => drafts.map((draft) => draft.draftId), [drafts]);
  const [selectedDraftIds, setSelectedDraftIds] = useState<Set<string>>(() => new Set(draftIds));
  const approvePersonMemory = useApprovalHubStore((state) => state.approvePersonMemory);
  const notNowPersonMemory = useApprovalHubStore((state) => state.notNowPersonMemory);
  const withdrawPersonMemory = useApprovalHubStore((state) => state.withdrawPersonMemory);
  const deciding = useApprovalHubStore((state) => state.deciding[item.proposalId]);
  const guardedWrite = useGuardedWrite();
  // A host that has locked writes keeps the picking available (it is the user's work) and holds the four producer buttons.
  const { writesLocked } = useApprovalHost();
  const [checking, setChecking] = useState(false);
  const preparing = useRef(false);
  const writeBlocked = Boolean(deciding) || writesLocked || blocked || checking;
  const submit = async (kind: ApprovalWriteKind, write: () => Promise<void>) => {
    if (writeBlocked || preparing.current) return;
    preparing.current = true;
    setChecking(true);
    try {
      if (beforeWrite && !(await beforeWrite())) return;
      await guardedWrite(kind, write);
      await afterWrite?.();
    } finally {
      preparing.current = false;
      setChecking(false);
    }
  };

  // Start over only when the drafts that remain are not the ones that were shown. A refreshed copy of the same proposal
  // (a new object with the same drafts) must keep what the user already picked.
  const draftSignature = draftIds.join('\u0000');
  // biome-ignore lint/correctness/useExhaustiveDependencies: draftSignature stands for draftIds
  useEffect(() => {
    setSelectedDraftIds(new Set(draftIds));
  }, [draftSignature]);

  // A pick that differs from "everything" is work in progress.
  useReportEditing(
    'person-memory-selection',
    selectedDraftIds.size !== draftIds.length || draftIds.some((draftId) => !selectedDraftIds.has(draftId)),
  );

  const toggleDraft = (draftId: string) => {
    setSelectedDraftIds((current) => {
      const next = new Set(current);
      if (next.has(draftId)) next.delete(draftId);
      else next.add(draftId);
      return next;
    });
  };

  const approveSelected = () => {
    const selected = drafts.filter((draft) => selectedDraftIds.has(draft.draftId)).map((draft) => draft.draftId);
    if (selected.length > 0)
      void submit('person-memory-approve', () =>
        undoReceiptRequestId
          ? approvePersonMemory(item.proposalId, selected, undoReceiptRequestId)
          : approvePersonMemory(item.proposalId, selected),
      );
  };

  return (
    <div className="space-y-2" data-testid="person-memory-claim-selector">
      <p className="text-micro opacity-70">{t.notice}</p>
      {replacesProposalId ? (
        <p
          className="rounded-md border border-[var(--cafe-border)] p-2 text-micro"
          data-testid="person-memory-replacement"
        >
          {t.replacement}
        </p>
      ) : null}
      <div className="space-y-2">
        {drafts.map((draft) => (
          <div key={draft.draftId} className="flex items-start gap-2 rounded-md border border-[var(--cafe-border)] p-2">
            <input
              type="checkbox"
              aria-label={t.select(kindLabel(draft.claimKind, language, ownerName), draft.normalizedDraft)}
              checked={selectedDraftIds.has(draft.draftId)}
              onChange={() => toggleDraft(draft.draftId)}
              disabled={Boolean(deciding)}
              className="mt-0.5"
            />
            <span className="min-w-0 space-y-1">
              <span className="block text-sm">{draft.normalizedDraft}</span>
              <span className="block text-micro opacity-65">
                {kindLabel(draft.claimKind, language, ownerName)} · {sourceLabel(draft.sourceRole, language, ownerName)}
              </span>
              <details>
                <summary className="shell-focusable cursor-pointer text-xs">{t.original}</summary>
                {draft.event ? (
                  <EventDraftDetails
                    displayName={displayName}
                    event={draft.event}
                    informedEvidence={draft.informedEvidence}
                    sourceRole={draft.sourceRole}
                  />
                ) : (
                  <span className="block text-xs">{t.excerpt(draft.evidenceExcerpt)}</span>
                )}
              </details>
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={approveSelected}
          disabled={writeBlocked || selectedDraftIds.size === 0}
          className="px-3 py-1 text-micro font-medium rounded-md text-[var(--cafe-accent-foreground)] disabled:opacity-50"
          style={{ backgroundColor: 'var(--semantic-success, #22c55e)' }}
          data-testid="person-memory-approve-selected"
        >
          {deciding === 'approving' ? t.writing : t.selected(selectedDraftIds.size)}
        </button>
        <button
          type="button"
          onClick={() => void submit('person-memory-defer', () => notNowPersonMemory(item.proposalId))}
          disabled={writeBlocked}
          className="px-3 py-1 text-micro font-medium rounded-md border border-[var(--cafe-border)] disabled:opacity-50"
          data-testid="person-memory-not-now"
        >
          {deciding === 'deferring' ? t.waiting : t.later}
        </button>
        <button
          type="button"
          onClick={() => void submit('person-memory-withdraw', () => withdrawPersonMemory(item.proposalId))}
          disabled={writeBlocked}
          className="px-3 py-1 text-micro font-medium rounded-md border border-[var(--cafe-border)] disabled:opacity-50"
          data-testid="person-memory-withdraw"
        >
          {deciding === 'withdrawing' ? t.cancelling : t.cancel}
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={writeBlocked}
          className="px-3 py-1 text-micro font-medium rounded-md border border-[var(--cafe-border)] hover:bg-[var(--semantic-error,#ef4444)] hover:text-[var(--cafe-accent-foreground)] disabled:opacity-50"
          data-testid="person-memory-reject"
        >
          {deciding === 'rejecting' ? t.rejecting : t.reject}
        </button>
      </div>
    </div>
  );
}
