'use client';

import { createContext, useContext } from 'react';
import { useShellCopy } from '../shell/shell-copy';
import { useMemberText } from './editor-presentation';
import { memberSaveCopy } from './member-save.shell-copy';

export type MemberOperation = 'accounts' | 'avatar' | 'audio' | 'restore';
export type MemberOperationIssues = Record<
  MemberOperation,
  {
    error: string | null;
    retry: () => void;
    pending: boolean;
  }
>;
export const MemberOperations = createContext<MemberOperationIssues | null>(null);

export function MemberOperationFeedback({ source }: { source: MemberOperation }) {
  const issue = useContext(MemberOperations)?.[source];
  const copy = useShellCopy(memberSaveCopy);
  const t = useMemberText();
  if (!issue?.error) return null;
  const label = {
    accounts: copy.reloadAccounts,
    avatar: copy.retryAvatar,
    audio: copy.retryAudio,
    restore: copy.retryRestore,
  }[source];
  return (
    <div
      role="alert"
      data-testid={`member-operation-${source}`}
      className="mt-2 space-y-2 text-compact text-conn-red-text"
    >
      <p>{t(issue.error)}</p>
      <button type="button" className="member-button" disabled={issue.pending} onClick={issue.retry}>
        {label}
      </button>
    </div>
  );
}
