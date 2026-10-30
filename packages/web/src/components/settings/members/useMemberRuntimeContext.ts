import { useEffect, useRef } from 'react';
import type { HubCatEditorFormState } from '../../hub-cat-editor.model';
import { type MemberRuntimeContext, memberRuntimeContextScope } from './member-runtime-context';
import type { RuntimeChoice } from './member-runtime-draft';

export function useMemberRuntimeContext(
  form: HubCatEditorFormState,
  selected: RuntimeChoice | undefined,
  remembered?: MemberRuntimeContext,
  observe?: (context: MemberRuntimeContext) => void,
) {
  const local = useRef<MemberRuntimeContext>();
  const scope = memberRuntimeContextScope(form);
  if (selected) local.current = { scope, runtime: selected };
  const matching =
    remembered?.scope === scope ? remembered : local.current?.scope === scope ? local.current : undefined;
  useEffect(() => {
    if (selected) observe?.({ scope, runtime: selected });
  }, [scope, selected, observe]);
  return selected ?? matching?.runtime;
}
