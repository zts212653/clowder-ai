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

/** Pi uses an opaque provider/model pair on the wire; this changes its label only. */
export function nativeModelLabel(runtime: RuntimeChoice, value: string | undefined): string | undefined {
  if (!value || runtime.id !== 'pi') return value;
  try {
    const pair: unknown = JSON.parse(value);
    return Array.isArray(pair) && pair.length === 2 && pair.every((item) => typeof item === 'string')
      ? pair.join(' / ')
      : value;
  } catch {
    return value;
  }
}
