'use client';
import { useEffect, useRef, useState } from 'react';
import { serializeCommandArgs } from '../../hub-cat-editor.acp';
import type { HubCatEditorFormState } from '../../hub-cat-editor.model';
import { DshProviderSetup } from './DshProviderSetup';
import type { MemberText } from './MemberRuntimeFields';
import type { RuntimeChoice } from './member-runtime-draft';

function bindingKey(form: HubCatEditorFormState): string {
  return JSON.stringify([
    form.catId,
    form.clientId,
    form.carrier,
    form.configurationSource,
    form.accountRef,
    form.acpAgentProvider,
    form.acpCommand,
    form.acpStartupArgs,
    form.acpTransport,
    form.cliConfigArgs,
    form.commandArgs,
    form.defaultModel,
    form.cliEffort,
  ]);
}

/** Keep only this helper's exact prepared draft alive; classification alone cannot validate a draft command. */
export function MemberDshProviderSetup({
  form,
  selected,
  patch,
  t,
  autoInspect = Boolean(selected?.dshSetupRequired),
}: {
  form: HubCatEditorFormState;
  selected?: RuntimeChoice;
  patch: (value: Partial<HubCatEditorFormState>) => void;
  t: MemberText;
  autoInspect?: boolean;
}) {
  const binding = bindingKey(form);
  const live = useRef({ binding, active: true });
  live.current.binding = binding;
  useEffect(() => {
    const liveness = live.current;
    liveness.active = true;
    return () => {
      liveness.active = false;
    };
  }, []);
  const [prepared, setPrepared] = useState<{ binding: string; key: string; runtimeId: string }>();
  const eligible =
    form.configurationSource === 'native_tool' &&
    form.clientId === 'acp' &&
    form.carrier === 'acp' &&
    !form.accountRef &&
    !form.acpAgentProvider &&
    form.acpTransport === 'stdio';
  const detected =
    selected?.harnessId === 'dsh' &&
    selected.installed &&
    !selected.acp?.agentProvider &&
    (selected.id === 'dsh' || selected.id.startsWith('acp:'));
  const session =
    prepared?.binding === binding
      ? prepared
      : detected && selected
        ? { binding, key: `${selected.id}:${binding}`, runtimeId: selected.id }
        : undefined;
  if (!eligible || !session) return null;
  return (
    <DshProviderSetup
      key={session.key}
      runtimeId={session.runtimeId}
      configurationKey={session.key}
      t={t}
      autoInspect={autoInspect}
      onPrepared={(command, args) => {
        if (!live.current.active || live.current.binding !== binding) return;
        const change = {
          acpCommand: command,
          acpStartupArgs: serializeCommandArgs(args),
          defaultModel: '',
          cliEffort: '',
        };
        setPrepared({ binding: bindingKey({ ...form, ...change }), key: session.key, runtimeId: session.runtimeId });
        patch(change);
      }}
    />
  );
}
