'use client';
import { useState } from 'react';
import { serializeCommandArgs } from '../../hub-cat-editor.acp';
import type { HubCatEditorFormState } from '../../hub-cat-editor.model';
import { DshProviderSetup } from './DshProviderSetup';
import { dshConnectionKey } from './member-runtime-draft';

export function MemberDshProviderSetup({
  form,
  runtimeId,
  patch,
  onPrepared,
  onVerified,
  canVerifyCurrent,
  t,
}: {
  form: HubCatEditorFormState;
  runtimeId: string;
  patch: (value: Partial<HubCatEditorFormState>) => void;
  onPrepared?: (command: string, args: string[], runtimeId: string) => void;
  onVerified?: () => void;
  canVerifyCurrent?: boolean;
  t: (zh: string, en: string) => string;
}) {
  const [prepared, setPrepared] = useState<{
    command: string;
    args: string;
    runtimeId: string;
    configurationKey: string;
  }>();
  // Only the exact generated launch retains its originating registered runtime.
  // A manual edit or tool switch must still invalidate pending requests/receipts.
  const matches = prepared?.command === form.acpCommand && prepared.args === form.acpStartupArgs;
  const source = matches ? prepared.runtimeId : runtimeId;
  const configurationKey = matches
    ? prepared.configurationKey
    : JSON.stringify([form.acpCommand, form.acpStartupArgs, prepared?.args]);
  return (
    <DshProviderSetup
      runtimeId={source}
      configurationKey={configurationKey}
      verificationKey={dshConnectionKey(form)}
      selectedModel={form.defaultModel}
      effort={form.cliEffort}
      canVerifyCurrent={canVerifyCurrent}
      onVerified={onVerified}
      t={t}
      onPrepared={(command, args) => {
        const startupArgs = serializeCommandArgs(args);
        setPrepared({ command, args: startupArgs, runtimeId: source, configurationKey });
        onPrepared?.(command, args, source);
        patch({ acpCommand: command, acpStartupArgs: startupArgs, defaultModel: '', cliEffort: '' });
      }}
    />
  );
}
