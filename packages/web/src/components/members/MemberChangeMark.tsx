'use client';
import { createContext, type ReactNode, useContext } from 'react';
import { useShellCopy } from '../shell/shell-copy';
import type { MemberChange } from './member-editor-changes';
import { memberSaveCopy } from './member-save.shell-copy';
export const MemberChanges = createContext<readonly MemberChange[]>([]);
export function useMemberChanged(label: string) {
  return useContext(MemberChanges).some((change) => change.label === label || change.fieldLabels.includes(label));
}
export function MemberChangeMark({ label }: { label: string }) {
  const changed = useMemberChanged(label);
  const copy = useShellCopy(memberSaveCopy);
  return changed ? <small className="member-change-mark">{copy.changed}</small> : null;
}
export function MemberChangedField({ label, children }: { label: string; children: ReactNode }) {
  const changed = useMemberChanged(label);
  return (
    <div data-member-changed={changed || undefined}>
      {children}
      <MemberChangeMark label={label} />
    </div>
  );
}
