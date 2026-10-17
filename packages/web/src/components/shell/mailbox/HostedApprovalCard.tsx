import type { ApprovalHubItem, UnifiedAttentionItemV1, UnifiedAttentionVisibleApproval } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  type ApprovalHost,
  ApprovalHostContext,
  type ApprovalRequestEvent,
  type ApprovalWriteKind,
  type AuthorizeOptions,
} from '@/components/ApprovalHost';
import { ApprovalItemCard } from '@/components/ApprovalItemCard';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { useShellCopy } from '../shell-copy';
import { useShellLanguage } from '../shell-language';
import { ApprovalResultLink } from './ApprovalResultLink';
import { type HostedApprovalMatch, matchHostedApproval } from './approval-match';
import { describeReconcile } from './approval-reconcile';
import { approvalReconcileCopy } from './approval-reconcile.shell-copy';
import { type ApprovalSessions, sessionKey } from './approval-sessions';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';
import type { OriginalPlace } from './original-place';
import { PlaceAction } from './PlaceAction';
import { ThreadProposalDecision } from './ThreadProposalDecision';

const MUTED = { color: 'var(--shell-muted)' } as const;

/**
 * F322 S3-2b-1c: the original approval card, hosted in the 待办 panel.
 *
 * Nothing here approves anything. The card is the original one: it acts through the Approval Hub store and the producer's own
 * endpoint, exactly as in the Approval Hub. This component only decides when the card may be shown, locks it while what it
 * shows may not be true, asks the sessions before each producer write, and then says what a re-read of both sources proved.
 *
 *  - Shown only when the store holds the same decision the read shows (the matcher's verdict). Until the store has been
 *    refreshed it says it is checking; if it still differs it says so and keeps the way to the original place.
 *  - Locked while a write is in flight or being confirmed, and after any result that is not "still open".
 *  - The store removes an item optimistically on a 2xx. That is not a result and must not make the card vanish while the
 *    answer is being confirmed, so the last matched copy stays on screen until the result is in.
 */
/** The store's copy is what the card acts on. Opening the row reads it afresh (a read; it changes nothing), once per approval. */
function useStoreCopies(key: string): {
  storeItems: readonly ApprovalHubItem[];
  storeChecked: boolean;
  storeWaiting: boolean;
} {
  const storeItems = useApprovalHubStore((state) => state.items);
  const unavailable = useApprovalHubStore((state) => state.isLoading || !state.pendingReadAvailable);
  const loading = useApprovalHubStore((state) => state.isLoading);
  const [storeChecked, setStoreChecked] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one refresh per opened approval
  useEffect(() => {
    let live = true;
    setStoreChecked(false);
    void useApprovalHubStore
      .getState()
      .fetchPending()
      .finally(() => {
        if (live) setStoreChecked(true);
      });
    return () => {
      live = false;
    };
  }, [key]);
  return { storeItems, storeChecked: storeChecked && !unavailable, storeWaiting: !storeChecked || loading };
}

/** What stands in the card's place when the original card may not be shown: still checking, or checked and not the same decision. */
function NoCard({ match, storeChecked }: { match: HostedApprovalMatch; storeChecked: boolean }) {
  if (!storeChecked && match.kind !== 'matched') {
    return (
      <p className="m-0 text-sm" style={MUTED} data-testid="mailbox-approval-checking">
        正在核对这条提议…
      </p>
    );
  }
  return (
    <p
      className="m-0 text-sm"
      style={MUTED}
      data-testid="mailbox-approval-unmatched"
      data-reason={match.kind === 'unmatched' ? match.reason : undefined}
    >
      {match.kind === 'unmatched' && match.reason === 'expired'
        ? '这条提议已过期，不能提交决定。'
        : '暂时无法核实这条提议，请重新读取。'}
    </p>
  );
}

/** What the session says under the card: its line, the host's refusal notice, and the re-read it offers. */
function SessionStatus({
  line,
  notice,
  canReread,
  onReread,
}: {
  line: string | null;
  notice: string | null;
  canReread: boolean;
  onReread: () => void;
}) {
  const t = useShellCopy(approvalReconcileCopy);
  return (
    <>
      {line ? (
        <output className="m-0 block text-sm font-medium" data-testid="mailbox-approval-result">
          {line}
        </output>
      ) : null}
      {notice ? (
        <output className="m-0 block text-xs" style={MUTED} data-testid="mailbox-approval-notice">
          {notice}
        </output>
      ) : null}
      {canReread ? (
        <div>
          <button
            type="button"
            data-testid="mailbox-approval-reread"
            onClick={onReread}
            className="shell-nav-row shell-focusable rounded-lg px-2 py-1 text-xs"
          >
            {t.reread}
          </button>
        </div>
      ) : null}
    </>
  );
}

function Hosted({
  item,
  approval,
  ownerUserId,
  sessions,
  place,
  onOpen,
  readCurrent,
  secondaryAction,
}: {
  item: UnifiedAttentionItemV1;
  approval: UnifiedAttentionVisibleApproval;
  ownerUserId: string;
  sessions: ApprovalSessions;
  place: OriginalPlace;
  onOpen: (place: OriginalPlace) => void;
  readCurrent: boolean;
  secondaryAction?: ReactNode;
}) {
  const t = useShellCopy(mailboxEntryCopy);
  const [editors, setEditors] = useState<ReadonlySet<string>>(() => new Set());
  const reportEditing = useCallback((source: string, editing: boolean) => {
    setEditors((current) => {
      if (current.has(source) === editing) return current;
      const next = new Set(current);
      if (editing) next.add(source);
      else next.delete(source);
      return next;
    });
  }, []);
  const key = sessionKey(ownerUserId, { sourceFeatureId: approval.sourceFeatureId, proposalId: approval.proposalId });

  useEffect(() => {
    sessions.open({ ownerUserId, decisionRef: item.decisionRef, approval });
  }, [sessions, ownerUserId, item.decisionRef, approval]);
  useSyncExternalStore(sessions.subscribe, sessions.getVersion, sessions.getVersion);
  const session = sessions.get(key);
  const { storeItems, storeChecked, storeWaiting } = useStoreCopies(key);

  const match = matchHostedApproval({ read: approval, readOwnerUserId: ownerUserId, storeItems, now: Date.now() });
  const state = session?.model.state ?? { kind: 'idle' as const };
  const language = useShellLanguage();
  const reconcile = describeReconcile(state, { language, ownerUserId });

  const lastMatched = useRef<ApprovalHubItem | null>(null);
  if (match.kind === 'matched') lastMatched.current = match.item;
  const shown =
    match.kind === 'matched'
      ? match.item
      : state.kind !== 'idle' || editors.size > 0
        ? (lastMatched.current ?? (session ? { ...session.approval, ownerUserId } : null))
        : null;
  const showCard = shown !== null && reconcile.actions !== 'gone';
  const writesLocked = !readCurrent || !storeChecked || reconcile.actions !== 'allowed' || match.kind !== 'matched';

  const authorizeWrite = useCallback(
    (_kind: ApprovalWriteKind, options?: AuthorizeOptions) =>
      readCurrent && storeChecked && sessions.authorize(key, options),
    [sessions, key, storeChecked, readCurrent],
  );
  const reportRequest = useCallback((event: ApprovalRequestEvent) => sessions.hostReport(key, event), [sessions, key]);
  const originalPlaceAction = useMemo(
    () => (
      <div
        className="ml-auto flex flex-wrap items-center justify-end gap-2"
        data-testid="mailbox-row-secondary-actions"
      >
        {secondaryAction}
        <PlaceAction quiet place={place} onOpen={onOpen} />
      </div>
    ),
    [place, onOpen, secondaryAction],
  );
  const host = useMemo<ApprovalHost>(
    () => ({
      presentation: 'mailbox',
      decisionWords: { approve: t.approve, reject: t.reject, clear: t.clear },
      originalPlaceAction,
      writesLocked,
      authorizeWrite,
      reportEditing,
      reportRequest,
    }),
    [originalPlaceAction, writesLocked, authorizeWrite, reportEditing, reportRequest, t],
  );

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="mailbox-hosted-approval"
      data-state={state.kind}
      data-session-key={key}
    >
      {showCard ? (
        <ApprovalHostContext.Provider value={host}>
          {shown.sourceFeatureId === 'F128' && !shown.inlineApprovable ? (
            <ThreadProposalDecision item={shown} />
          ) : (
            <ApprovalItemCard item={shown} />
          )}
        </ApprovalHostContext.Provider>
      ) : reconcile.actions === 'gone' ? null : (
        <NoCard match={match} storeChecked={storeChecked || !storeWaiting} />
      )}
      <SessionStatus
        line={
          reconcile.line ??
          (showCard && state.kind === 'idle' && !storeChecked
            ? storeWaiting
              ? '正在核对这条提议…'
              : '暂时无法读取提议，请重新读取。'
            : null)
        }
        notice={session?.notice ?? null}
        canReread={
          reconcile.canReread ||
          (state.kind === 'idle' && !storeWaiting && (!storeChecked || match.kind === 'unmatched'))
        }
        onReread={() => sessions.reread(key)}
      />
      <ApprovalResultLink state={state} />
      {showCard && (shown?.sourceFeatureId === 'F276' || shown?.decisionMode !== 'claim-select')
        ? null
        : originalPlaceAction}
    </div>
  );
}

export function HostedApprovalCard({
  item,
  ownerUserId,
  sessions,
  place,
  onOpen,
  readCurrent = true,
  secondaryAction,
}: {
  item: UnifiedAttentionItemV1;
  /** The read's verified owner: the owner this card is shown to. */
  ownerUserId: string;
  sessions: ApprovalSessions;
  place: OriginalPlace;
  onOpen: (place: OriginalPlace) => void;
  readCurrent?: boolean;
  secondaryAction?: ReactNode;
}) {
  const approval = item.approval;
  if (!approval) return null;
  return (
    <Hosted
      key={sessionKey(ownerUserId, approval)}
      item={item}
      approval={approval}
      ownerUserId={ownerUserId}
      sessions={sessions}
      place={place}
      onOpen={onOpen}
      readCurrent={readCurrent}
      secondaryAction={secondaryAction}
    />
  );
}
