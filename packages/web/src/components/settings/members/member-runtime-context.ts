import { type HubCatEditorFormState, splitCommandArgs } from '../../hub-cat-editor.model';
import type { RuntimeChoice } from './member-runtime-draft';

export interface MemberRuntimeContext {
  scope: string;
  runtime: RuntimeChoice;
}

/** Arguments may be edited within a harness; changing its executable or grant changes the authority. */
export function memberRuntimeContextScope(form: HubCatEditorFormState): string {
  const script = /(?:^|[/\\])node(?:\.exe)?$/i.test(form.acpCommand)
    ? splitCommandArgs(form.acpStartupArgs).find((arg) => /\.(?:mjs|cjs|js)$/i.test(arg))
    : undefined;
  return JSON.stringify([
    form.catId,
    form.clientId,
    form.carrier,
    form.configurationSource,
    form.acpAgentProvider ?? null,
    form.acpCommand,
    form.acpTransport,
    script,
  ]);
}
