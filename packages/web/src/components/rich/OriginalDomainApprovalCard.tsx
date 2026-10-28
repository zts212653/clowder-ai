'use client';
import type { RichCardBlock } from '@cat-cafe/shared';
import { type ReactNode, useCallback, useRef } from 'react';
import { type ApprovalHost, ApprovalHostContext } from '@/components/ApprovalHost';
import { describeReconcile } from '@/components/shell/mailbox/approval-reconcile';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import { CardBlock } from './CardBlock';
import { DomainApprovalCard } from './DomainApprovalCard';
import { domainApprovalCopy } from './domain-approval.shell-copy';
import { ReconciledApprovalResult } from './ReconciledApprovalResult';
import { readDomainApprovalResult } from './read-domain-approval-result';
import {
  type DomainApprovalSource,
  type DomainCardCoordinate,
  domainApprovalCandidate,
  readDomainApprovalSource,
} from './read-domain-approval-source';
import { RetainedApprovalCardResult, useOriginalApprovalRead } from './use-original-approval-read';

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
  const candidate = domainApprovalCandidate(block);
  const threadId = coordinate?.threadId,
    messageId = coordinate?.messageId;
  const writing = useRef(false);
  const source = useOriginalApprovalRead(
    candidate?.feature ?? '',
    candidate?.proposalId ?? null,
    { threadId, messageId, block },
    async (_signal, fresh) => {
      const read = threadId && messageId ? await readDomainApprovalSource(block, { threadId, messageId }, fresh) : null;
      const next = read && (!expectedOwnerUserId || read.ownerUserId === expectedOwnerUserId) ? read : null;
      const outcome =
        !next && threadId && messageId
          ? await readDomainApprovalResult(block, { threadId, messageId }, expectedOwnerUserId, !fresh)
          : null;
      return { next, outcome };
    },
    expectedOwnerUserId,
  );
  const remembered = useRef<{ key: string; source: DomainApprovalSource } | null>(null);
  const binding = JSON.stringify([source.ownerUserId, candidate, threadId, messageId, block]);
  if (remembered.current?.key !== binding) remembered.current = null;
  const next = source.value?.next ?? null;
  if (next) remembered.current = { key: binding, source: next };
  const last = source.ownerUserId ? (remembered.current?.source ?? null) : null,
    result = source.value?.outcome ?? null;
  const current = !!next && !source.reading && !source.failed;
  const liveSource = useRef(last);
  liveSource.current = current ? last : null;
  const refresh = useCallback(async () => {
    const next = (await source.refresh())?.next ?? null;
    liveSource.current = next;
    return next;
  }, [source.refresh]);
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
  if (source.retained)
    return (
      <div data-testid="domain-approval-result">
        <RetainedApprovalCardResult item={source.retained} reread={() => void source.reread()} />
      </div>
    );
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
