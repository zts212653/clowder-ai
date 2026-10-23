'use client';
import type { RichCardBlock } from '@cat-cafe/shared';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { type ApprovalHost, ApprovalHostContext } from '@/components/ApprovalHost';
import { describeReconcile } from '@/components/shell/mailbox/approval-reconcile';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import { UNIFIED_ATTENTION_INVALIDATION_EVENTS } from '@/components/shell/use-unified-attention';
import { CardBlock } from './CardBlock';
import { DomainApprovalCard } from './DomainApprovalCard';
import { domainApprovalCopy } from './domain-approval.shell-copy';
import { ReconciledApprovalResult } from './ReconciledApprovalResult';
import { readDomainApprovalResult } from './read-domain-approval-result';
import {
  type DomainApprovalSource,
  type DomainCardCoordinate,
  readDomainApprovalSource,
} from './read-domain-approval-source';

/** Chat and Inbox share the verified original card and the original domain writer. Absence is never a terminal result. */
export function OriginalDomainApprovalCard({
  block,
  coordinate,
  verifyCurrentRead,
  expectedOwnerUserId,
  secondaryActions,
  onWriteStart,
  onWriteSettled,
}: {
  block: RichCardBlock;
  coordinate?: DomainCardCoordinate;
  verifyCurrentRead?: () => boolean;
  expectedOwnerUserId?: string;
  secondaryActions?: ReactNode;
  onWriteStart?: () => void;
  onWriteSettled?: () => void;
}) {
  const t = useShellCopy(domainApprovalCopy);
  const language = useShellLanguage();
  const [result, setResult] = useState<Awaited<ReturnType<typeof readDomainApprovalResult>>>(null);
  const [last, setLast] = useState<DomainApprovalSource | null>(null),
    [current, setCurrent] = useState(false);
  const liveSource = useRef<DomainApprovalSource | null>(null),
    writing = useRef(false),
    generation = useRef(0);
  const threadId = coordinate?.threadId,
    messageId = coordinate?.messageId;
  const refresh = useCallback(async () => {
    const round = ++generation.current;
    liveSource.current = null;
    setCurrent(false);
    setResult(null);
    const read = threadId && messageId ? await readDomainApprovalSource(block, { threadId, messageId }) : null;
    const next = read && (!expectedOwnerUserId || read.ownerUserId === expectedOwnerUserId) ? read : null;
    const outcome =
      !next && threadId && messageId
        ? await readDomainApprovalResult(block, { threadId, messageId }, expectedOwnerUserId)
        : null;
    if (round !== generation.current) return null;
    liveSource.current = next;
    setCurrent(next !== null);
    setResult(outcome);
    if (next) setLast(next);
    return next;
  }, [block, threadId, messageId, expectedOwnerUserId]);
  const cancelReads = useCallback(() => {
    ++generation.current;
    liveSource.current = null;
  }, []);
  useEffect(() => {
    void refresh();
    const invalidate = () => {
      void refresh();
    };
    for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.addEventListener(event, invalidate);
    return () => {
      cancelReads();
      for (const event of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.removeEventListener(event, invalidate);
    };
  }, [refresh, cancelReads]);
  const beforeWrite = useCallback(async () => {
    const previous = liveSource.current;
    if (!previous || writing.current || (verifyCurrentRead && !verifyCurrentRead())) return false;
    const next = await refresh();
    return Boolean(next && JSON.stringify(next.row) === JSON.stringify(previous.row));
  }, [refresh, verifyCurrentRead]);
  const host: ApprovalHost = {
    presentation: 'mailbox',
    originalPlaceAction: secondaryActions,
    writesLocked: !current || writing.current || Boolean(verifyCurrentRead && !verifyCurrentRead()),
    authorizeWrite: () =>
      Boolean(liveSource.current && !writing.current && (!verifyCurrentRead || verifyCurrentRead())),
    reportEditing: () => {},
    reportRequest: (event) => {
      writing.current = event.phase === 'start';
      if (event.phase === 'start') onWriteStart?.();
      if (event.phase === 'end') onWriteSettled?.();
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
        <div data-testid="domain-approval-result">
          <ReconciledApprovalResult terminal={result.terminal} line={line}>
            <CardBlock block={{ ...block, actions: undefined }} />
            {secondaryActions}
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
        <DomainApprovalCard
          item={last.item}
          beforeWrite={beforeWrite}
          afterWrite={async () => {
            await refresh();
          }}
        />
      ) : (
        <details>
          <summary className="shell-focusable cursor-pointer text-sm">{t.originalCard}</summary>
          <CardBlock block={{ ...block, actions: undefined }} />
        </details>
      )}
      {!current ? (
        <p className="text-xs text-[var(--shell-muted)]" data-testid="domain-approval-unverified">
          {t.unverified}
        </p>
      ) : null}
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
