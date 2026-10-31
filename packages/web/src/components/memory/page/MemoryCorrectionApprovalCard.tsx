'use client';
import type { ApprovalHubItem, EventMemoryCorrectionPatch } from '@cat-cafe/shared';
import { memoryOwnerRevisionSchema } from '@cat-cafe/shared';
import { useCallback, useRef } from 'react';
import { ApprovalMember } from '@/components/rich/ApprovalMember';
import { RetainedApprovalCardResult, useOriginalApprovalRead } from '@/components/rich/use-original-approval-read';
import { describeReconcile } from '@/components/shell/mailbox/approval-reconcile';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import { UNIFIED_ATTENTION_INVALIDATION_EVENTS } from '@/components/shell/use-unified-attention';
import { MemoryCorrectionCard, type MemoryCorrectionDecision } from './MemoryCorrectionCard';
import { memoryCorrectionCopy } from './memory-correction.shell-copy';
import { memoryObject } from './owner-memory-read';
import {
  type CorrectionMemory,
  correctionApprovalStillCurrent,
  readCorrectionMemory,
} from './read-correction-approval';
import { readCorrectionResult } from './read-correction-result';

/** The original F321 card and endpoint, with complete owner memory and a fresh publication/version barrier. */
export function MemoryCorrectionApprovalCard({ item }: { item: ApprovalHubItem }) {
  const t = useShellCopy(memoryCorrectionCopy),
    language = useShellLanguage();
  const coordinate = item.navigation.state === 'anchored' ? item.navigation.approvalCardRef : undefined;
  const original = useOriginalApprovalRead(
    'F321',
    item.proposalId,
    { ...coordinate },
    async (signal, fresh) => {
      const next = await readCorrectionMemory(item, signal);
      const outcome =
        next && ['approved', 'rejected'].includes(next.proposal.status) && coordinate
          ? await readCorrectionResult(item.proposalId, coordinate, item.ownerUserId, !fresh)
          : null;
      return { next, outcome };
    },
    item.ownerUserId,
  );
  const memory = original.value?.next ?? null,
    result = original.value?.outcome ?? null;
  const unavailable = original.failed || (original.value !== undefined && !memory);
  const live = useRef<CorrectionMemory | null>(null);
  live.current = original.reading || original.failed ? null : memory;
  const refresh = useCallback(async () => {
    const next = (await original.refresh())?.next ?? null;
    live.current = next;
    return next;
  }, [original.refresh]);
  const beforeWrite = useCallback(
    async (decision: MemoryCorrectionDecision) => {
      const previous = live.current;
      if (!previous || !(await correctionApprovalStillCurrent(item))) return false;
      const next = await refresh();
      return Boolean(
        next &&
          JSON.stringify(next) === JSON.stringify(previous) &&
          (decision === 'approve'
            ? next.proposal.status === 'pending' || next.proposal.status === 'approving'
            : next.proposal.status === 'pending'),
      );
    },
    [item, refresh],
  );
  const afterWrite = useCallback(async () => {
    await refresh();
    for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.dispatchEvent(new Event(event));
  }, [refresh]);
  if (original.retained)
    return <RetainedApprovalCardResult item={original.retained} reread={() => void original.reread()} />;
  if (result)
    return (
      <div className="space-y-2 text-sm">
        <p>{t.kind}</p>
        <output>
          {
            describeReconcile(
              { kind: 'decided', terminal: result.terminal },
              {
                language,
                ownerUserId: result.ownerUserId,
                originalEffect: result.effect ? 'memory-corrected' : undefined,
              },
            ).line
          }
        </output>
        <button
          type="button"
          className="shell-focusable block rounded px-2 py-1 text-xs"
          onClick={() => {
            void refresh();
          }}
        >
          {t.reread.事件}
        </button>
      </div>
    );
  if (!memory)
    return (
      <div className="space-y-2">
        <p role={unavailable ? 'alert' : 'status'} className="text-sm text-cafe-muted">
          {unavailable ? t.unavailable : t.checking}
        </p>
        {unavailable ? (
          <button
            type="button"
            className="shell-focusable rounded px-2 py-1 text-xs"
            onClick={() => {
              void refresh();
            }}
          >
            {t.reread.事件}
          </button>
        ) : null}
      </div>
    );
  const proposal = memory.proposal;
  return (
    <MemoryCorrectionCard
      localized
      proposal={proposal}
      revision={memory.event.revision}
      noun="事件"
      endpoint="/api/event-memory-corrections"
      beforeWrite={beforeWrite}
      afterWrite={afterWrite}
      reread={() => {
        void refresh();
      }}
      matchesReceipt={(body, id, decision) =>
        memoryObject(body) &&
        body.proposalId === id &&
        body.status === (decision === 'approve' ? 'approved' : 'rejected') &&
        (decision === 'reject' || memoryOwnerRevisionSchema.safeParse(body.appliedRevision).success)
      }
      heading={
        <header className="flex flex-wrap items-center gap-2 text-xs text-cafe-muted">
          <span>{t.kind}</span>
          <ApprovalMember catId={proposal.sourceCatId} />
          <time className="ml-auto whitespace-nowrap">
            {new Date(proposal.createdAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}
          </time>
        </header>
      }
    >
      <p className="text-sm">
        <span className="text-cafe-muted">{t.event}: </span>
        {memory.event.summary.split('\n')[0]}
      </p>
      <p className="text-xs text-cafe-muted">
        {t.revision}: {proposal.expectedRevision === memory.event.revision ? t.currentVersion : t.olderVersion}
      </p>
      <details className="rounded-lg border border-cafe-subtle p-2">
        <summary className="shell-focusable cursor-pointer text-sm">{t.changes}</summary>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: bounded before/after content supports keyboard scrolling */}
        <section aria-label={t.changes} className="mt-2 max-h-64 overflow-auto" tabIndex={0}>
          <div className="space-y-3 break-words text-sm">
            <p className="font-medium">
              {proposal.expectedRevision === memory.event.revision ? t.before : t.currentRecord}
            </p>
            <p className="whitespace-pre-wrap">{memory.event.summary}</p>
            <p className="font-medium">{t.after}</p>
            <CorrectionPatch patch={proposal.suggestedPatch} />
          </div>
        </section>
      </details>
    </MemoryCorrectionCard>
  );
}

function CorrectionPatch({ patch }: { patch: EventMemoryCorrectionPatch }) {
  const t = useShellCopy(memoryCorrectionCopy);
  return (
    <>
      {patch.summary !== undefined ? <p className="whitespace-pre-wrap">{patch.summary}</p> : null}
      {patch.cognitiveTransition !== undefined ? (
        <p>
          {t.transition}: {patch.cognitiveTransition ? t.transitionLabels[patch.cognitiveTransition] : t.none}
        </p>
      ) : null}
      {patch.relatedHarness !== undefined ? (
        <p>
          {t.harness}: {patch.relatedHarness?.join('、') || t.none}
        </p>
      ) : null}
      {patch.confidence !== undefined ? (
        <p>
          {t.confidence}: {t.confidenceLabels[patch.confidence]}
        </p>
      ) : null}
    </>
  );
}
