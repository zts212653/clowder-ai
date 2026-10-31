'use client';

import { usesAgyAcp, usesAgyNative } from './hub-cat-editor.agy';
import {
  carrierOptionsForClient,
  defaultAcpCommandForClient,
  defaultAcpStartupArgsForClient,
  type HubCatEditorFormState,
} from './hub-cat-editor.model';
import { SelectField } from './hub-cat-editor-fields';
import { useEditorText } from './members/editor-presentation';

/** Both member editors select the actual provider binding, not just its wire protocol. */
export function MemberCarrierSelect({
  form,
  onChange,
  label = '接入方式',
  ariaLabel,
  t,
}: {
  form: HubCatEditorFormState;
  onChange: (patch: Partial<HubCatEditorFormState>) => void;
  label?: string;
  ariaLabel?: string;
  t?: (zh: string, en: string) => string;
}) {
  const editorText = useEditorText();
  const text = t ?? editorText;
  const agy = form.clientId === 'google';
  const native = usesAgyNative(form);
  const acp = usesAgyAcp(form);
  return (
    <SelectField
      label={label}
      ariaLabel={ariaLabel}
      value={agy ? (native ? 'agy-native' : acp ? 'agy-acp' : 'retired') : form.carrier}
      options={
        agy
          ? [
              ...(!native && !acp
                ? [
                    {
                      value: 'retired',
                      label: text('旧入口已退役，请配置 Native', 'Legacy adapter retired; configure Native'),
                    },
                  ]
                : []),
              { value: 'agy-native', label: 'AGY Native' },
              { value: 'agy-acp', label: text('AGY 官方 ACP', 'AGY official ACP') },
            ]
          : carrierOptionsForClient(form.clientId)
      }
      onChange={(value) => {
        if (agy) {
          if (value !== 'agy-native' && value !== 'agy-acp') return;
          onChange({
            carrier: value === 'agy-acp' ? 'acp' : 'cli',
            agyNativeEnabled: value === 'agy-native',
            agyAcpEnabled: value === 'agy-acp',
            agyProfileId: form.agyProfileId || form.catId,
            ...(value === 'agy-acp'
              ? { acpCommand: 'agy_acp_server.par', acpStartupArgs: '', acpTransport: 'stdio' }
              : {}),
          });
          return;
        }
        const carrier = value as HubCatEditorFormState['carrier'];
        onChange({
          carrier,
          agyNativeEnabled: false,
          agyAcpEnabled: false,
          ...(carrier === 'acp' && !form.acpCommand.trim()
            ? { acpCommand: defaultAcpCommandForClient(form.clientId) }
            : {}),
          ...(carrier === 'acp' && !form.acpStartupArgs.trim()
            ? { acpStartupArgs: defaultAcpStartupArgsForClient(form.clientId) }
            : {}),
        });
      }}
      required
    />
  );
}
