'use client';
import { useState } from 'react';
import { serializeCommandArgs } from '../../hub-cat-editor.acp';
import type { HubCatEditorFormState } from '../../hub-cat-editor.model';
import { DshProviderSetup, type PreparedDshConnection } from './DshProviderSetup';
import { dshConnectionKey } from './member-runtime-draft';

export function MemberDshProviderSetup({
  form,
  runtimeId,
  patch,
  onPrepared,
  t,
}: {
  form: HubCatEditorFormState;
  runtimeId: string;
  patch: (value: Partial<HubCatEditorFormState>) => void;
  onPrepared?: (value: PreparedDshConnection, runtimeId: string, form: HubCatEditorFormState) => void;
  t: (zh: string, en: string) => string;
}) {
  const [prepared, setPrepared] = useState<{
    command: string;
    args: string;
    runtimeId: string;
    configurationKey: string;
    env: string;
  }>();
  // Only the exact generated launch retains its originating registered runtime.
  // A manual edit or tool switch must still invalidate pending requests/receipts.
  const matches =
    prepared?.command === form.acpCommand &&
    prepared.args === form.acpStartupArgs &&
    prepared.env === JSON.stringify(form.env);
  const source = matches
    ? prepared.runtimeId
    : runtimeId.startsWith('acp:') || runtimeId.startsWith('draft:')
      ? 'dsh'
      : runtimeId;
  const configurationKey = matches
    ? prepared.configurationKey
    : JSON.stringify([form.acpCommand, form.acpStartupArgs, form.env, prepared?.args]);
  return (
    <DshProviderSetup
      runtimeId={source}
      configurationKey={configurationKey}
      verificationKey={dshConnectionKey(form)}
      selectedModel={form.defaultModel}
      effort={form.cliEffort}
      t={t}
      onPrepared={(value) => {
        const startupArgs = serializeCommandArgs(value.startupArgs);
        const change = {
          acpCommand: value.command,
          acpStartupArgs: startupArgs,
          env: value.env,
          defaultModel: JSON.stringify([value.provider, value.model]),
        };
        setPrepared({
          command: value.command,
          args: startupArgs,
          env: JSON.stringify(value.env),
          runtimeId: source,
          configurationKey,
        });
        onPrepared?.(value, source, { ...form, ...change });
        patch(change);
        return dshConnectionKey({ ...form, ...change });
      }}
    />
  );
}
