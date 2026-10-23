import { type Dispatch, type SetStateAction, useCallback } from 'react';
import type { HubCatEditorFormState } from '../../hub-cat-editor.model';
import type { MemberDraft } from './member-editor-state';
import { type MemberRuntimeContext, memberRuntimeContextScope } from './member-runtime-context';
import { type RuntimeChoice, switchMemberRuntime } from './member-runtime-draft';

export function useMemberRuntimeEditing(
  setDraft: Dispatch<SetStateAction<MemberDraft>>,
  setNotice: Dispatch<SetStateAction<string | null>>,
) {
  const patch = useCallback(
    (change: Partial<HubCatEditorFormState>) => {
      setNotice(null);
      setDraft((previous) => ({ ...previous, form: { ...previous.form, ...change } }));
    },
    [setDraft, setNotice],
  );
  const switchRuntime = useCallback(
    (next: RuntimeChoice, current?: RuntimeChoice) => {
      setNotice(null);
      setDraft((previous) => {
        const changed = switchMemberRuntime(previous, next, current);
        return changed === previous
          ? previous
          : { ...changed, runtimeContext: { scope: memberRuntimeContextScope(changed.form), runtime: next } };
      });
    },
    [setDraft, setNotice],
  );
  const observeRuntime = useCallback(
    (context: MemberRuntimeContext) =>
      setDraft((previous) => {
        const old = previous.runtimeContext;
        return old?.scope === context.scope &&
          old.runtime.id === context.runtime.id &&
          old.runtime.harnessId === context.runtime.harnessId
          ? previous
          : { ...previous, runtimeContext: context };
      }),
    [setDraft],
  );
  return { patch, switchRuntime, observeRuntime };
}
