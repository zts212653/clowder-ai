import { useEffect, useRef } from 'react';
import { API_URL, sendMemberSaveDiagnostics } from '@/utils/api-client';
import { beginMemberSave, type MemberSaveTrace } from '@/utils/member-save-trace';

/** Capture React's committed non-saving state separately from the completed async workflow. */
export function useMemberSaveTrace(saving: boolean) {
  const pending = useRef<MemberSaveTrace | null>(null);
  useEffect(() => {
    if (!saving && pending.current) {
      pending.current.committed();
      pending.current = null;
    }
  }, [saving]);
  return () => {
    const trace = beginMemberSave(API_URL, (_path, init) => sendMemberSaveDiagnostics(init));
    pending.current = trace;
    return trace;
  };
}
