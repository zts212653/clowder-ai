import type { HubCatEditorFormState } from '../hub-cat-editor.model';
import { matchesRuntime, type RuntimeChoice } from '../settings/members/member-runtime-draft';

/** Model metadata describes the discovered launch configuration, independently of login evidence. */
export function usesDetectedRuntimeConfiguration(form: HubCatEditorFormState, runtime: RuntimeChoice): boolean {
  return (
    form.configurationSource === 'native_tool' &&
    !form.accountRef.trim() &&
    !form.commandArgs.trim() &&
    !form.cliConfigArgs.length &&
    matchesRuntime(form, runtime)
  );
}

/** DSH and Pi use opaque provider/model pairs; this changes their labels only. */
export function nativeModelLabel(runtime: RuntimeChoice, value: string | undefined): string | undefined {
  if (!value || !['pi', 'dsh'].includes(runtime.id)) return value;
  try {
    const pair: unknown = JSON.parse(value);
    return Array.isArray(pair) && pair.length === 2 && pair.every((item) => typeof item === 'string')
      ? pair.join(' / ')
      : value;
  } catch {
    return value;
  }
}
