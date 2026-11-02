import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { useRef, useState, useSyncExternalStore } from 'react';
import { type ApprovalHost, ApprovalHostContext } from '@/components/ApprovalHost';
import { CardBlock } from '../../rich/CardBlock';
import { HandoffProposalCard } from '../../rich/HandoffProposalCard';
import { useShellCopy } from '../shell-copy';
import { type ApprovalSessions, sessionKey } from './approval-sessions';
import { OriginalApprovalOrigin } from './OriginalApprovalOrigin';
import { originalApprovalCopy } from './original-approval.shell-copy';
import { originalApprovalSource, sameOriginalApprovalSource } from './original-approval-card-source';

/** Render the original card and writer; the proof gates this host, not generic/batch capability. */
export function MailboxOriginalApprovalCard({
  item,
  ownerUserId,
  sessions,
  readCurrent,
  secondaryActions,
}: {
  item: UnifiedAttentionItemV1;
  ownerUserId: string;
  sessions: ApprovalSessions;
  readCurrent: boolean;
  secondaryActions?: ReactNode;
}) {
  const writing = useRef(false);
  const [refused, setRefused] = useState(false);
  const [reload, setReload] = useState(0);
  const copy = useShellCopy(originalApprovalCopy);
  useSyncExternalStore(sessions.subscribe, sessions.getVersion, sessions.getVersion);
  const source = originalApprovalSource(item);
  if (!source) return null;
  const key = sessionKey(ownerUserId, source.approval);
  const state = sessions.get(key)?.model.state;
  const host: ApprovalHost = {
    presentation: 'mailbox',
    originalPlaceAction: secondaryActions,
    writesLocked:
      !readCurrent || !sessions.currentItem || writing.current || (state !== undefined && state.kind !== 'idle'),
    authorizeWrite: () => {
      const current = sessions.currentItem?.(ownerUserId, item.decisionRef);
      if (
        !readCurrent ||
        writing.current ||
        !current ||
        !sameOriginalApprovalSource(current, item) ||
        (source.approval.expiresAt !== undefined && source.approval.expiresAt < Date.now())
      ) {
        setRefused(true);
        return false;
      }
      const model = sessions.get(key)?.model.state;
      if (model && model.kind !== 'idle') {
        setRefused(true);
        return false;
      }
      sessions.open({
        ownerUserId,
        decisionRef: item.decisionRef,
        approval: source.approval,
        originalBlock: source.proof.block,
      });
      writing.current = true;
      setRefused(false);
      return true;
    },
    reportEditing: () => {},
    reportRequest: (event) => {
      sessions.hostReport(key, event);
      if (event.phase === 'end') writing.current = false;
    },
  };
  return (
    <ApprovalHostContext.Provider value={host}>
      <article
        data-testid="original-approval-card"
        data-proposal-id={source.approval.proposalId}
        data-producer={source.approval.sourceFeatureId}
      >
        <OriginalApprovalOrigin threadId={source.proof.cardRef.threadId} />
        {source.approval.sourceFeatureId === 'F225' ? (
          <HandoffProposalCard key={reload} block={source.proof.block} messageId={source.proof.cardRef.messageId} />
        ) : (
          <CardBlock key={reload} block={source.proof.block} messageId={source.proof.cardRef.messageId} />
        )}
        {refused ? (
          <p className="mt-2 text-sm" style={{ color: 'var(--shell-muted)' }}>
            {copy.changed}
          </p>
        ) : null}
        <button
          type="button"
          className="shell-nav-row shell-focusable mt-2 rounded px-2 py-1 text-xs"
          onClick={() => {
            setReload((n) => n + 1);
            setRefused(false);
            sessions.open({
              ownerUserId,
              decisionRef: item.decisionRef,
              approval: source.approval,
              originalBlock: source.proof.block,
            });
            sessions.reread(key);
          }}
        >
          {copy.reread}
        </button>
      </article>
    </ApprovalHostContext.Provider>
  );
}
