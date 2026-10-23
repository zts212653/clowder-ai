'use client';
import type { ApprovalHubItem, RichCardBlock } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ApprovalHost, ApprovalHostContext } from '@/components/ApprovalHost';
import { matchHostedApproval } from '@/components/shell/mailbox/approval-match';
import { describeReconcile } from '@/components/shell/mailbox/approval-reconcile';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import { UNIFIED_ATTENTION_INVALIDATION_EVENTS } from '@/components/shell/use-unified-attention';
import { CardBlock } from './CardBlock';
import { EvalRepairApprovalCard } from './EvalRepairApprovalCard';
import { evalRepairCopy } from './eval-repair.shell-copy';
import { evalRepairCandidate } from './eval-repair-model';
import { ReconciledApprovalResult } from './ReconciledApprovalResult';
import { type RepairCoordinate, readEvalRepairPending, readEvalRepairResult } from './read-eval-repair';

/** The original published card uses the same canonical source/writer. Recognition and UI state confer no authority. */
export function OriginalEvalRepairCard({ block, coordinate }: { block: RichCardBlock; coordinate?: RepairCoordinate }) {
  const t = useShellCopy(evalRepairCopy),
    language = useShellLanguage();
  const [last, setLast] = useState<ApprovalHubItem | null>(null);
  const [current, setCurrent] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof readEvalRepairResult>>>(null);
  const live = useRef<ApprovalHubItem | null>(null),
    generation = useRef(0),
    writing = useRef(false);
  const proposalId = evalRepairCandidate(block),
    threadId = coordinate?.threadId,
    messageId = coordinate?.messageId;
  const refresh = useCallback(async () => {
    const round = ++generation.current;
    live.current = null;
    setCurrent(false);
    const ref = threadId && messageId ? { threadId, messageId } : null;
    const next = proposalId && ref ? await readEvalRepairPending(proposalId, ref, undefined, block) : null;
    const outcome = !next && proposalId && ref ? await readEvalRepairResult(proposalId, ref, undefined, block) : null;
    if (round !== generation.current) return null;
    live.current = next;
    setCurrent(next !== null);
    setResult(outcome);
    if (next) setLast(next);
    return next;
  }, [proposalId, threadId, messageId, block]);
  useEffect(() => {
    void refresh();
    const invalidate = () => {
      void refresh();
    };
    for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.addEventListener(event, invalidate);
    return () => {
      ++generation.current;
      live.current = null;
      for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.removeEventListener(event, invalidate);
    };
  }, [refresh]);
  const beforeWrite = useCallback(async () => {
    const previous = live.current;
    if (!previous || writing.current) return false;
    const next = await refresh();
    if (!next) return false;
    return (
      matchHostedApproval({
        read: previous,
        readOwnerUserId: previous.ownerUserId,
        storeItems: [next],
        now: Date.now(),
      }).kind === 'matched'
    );
  }, [refresh]);
  const host: ApprovalHost = {
    presentation: 'mailbox',
    writesLocked: !current || writing.current,
    authorizeWrite: () => Boolean(live.current && !writing.current),
    reportEditing: () => {},
    reportRequest: (event) => {
      writing.current = event.phase === 'start';
    },
  };
  if (result) {
    const line =
      describeReconcile(
        { kind: 'decided', terminal: result.terminal },
        {
          language,
          ownerUserId: result.ownerUserId,
          originalEffect: result.effect,
        },
      ).line ?? '';
    return (
      <ApprovalHostContext.Provider value={host}>
        <div data-testid="eval-repair-result">
          <ReconciledApprovalResult terminal={result.terminal} line={line}>
            <CardBlock block={{ ...block, actions: undefined }} />
            <button type="button" className="shell-focusable text-xs hover:underline" onClick={() => void refresh()}>
              {t.reread}
            </button>
          </ReconciledApprovalResult>
        </div>
      </ApprovalHostContext.Provider>
    );
  }
  return (
    <ApprovalHostContext.Provider value={host}>
      {last ? (
        <EvalRepairApprovalCard
          item={last}
          beforeWrite={beforeWrite}
          afterWrite={async () => {
            await refresh();
          }}
        />
      ) : (
        <details>
          <summary className="shell-focusable cursor-pointer text-sm">{t.original}</summary>
          <CardBlock block={{ ...block, actions: undefined }} />
        </details>
      )}
      {!current ? <p className="text-xs text-[var(--shell-muted)]">{t.unverified}</p> : null}
      <button
        type="button"
        className="shell-nav-row shell-focusable rounded px-2 py-1 text-xs"
        onClick={() => {
          void refresh();
        }}
      >
        {t.reread}
      </button>
    </ApprovalHostContext.Provider>
  );
}
