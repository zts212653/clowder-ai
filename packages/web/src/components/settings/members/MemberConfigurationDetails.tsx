'use client';
import type { HubCatEditorFormState } from '../../hub-cat-editor.model';
import { SelectField } from '../../hub-cat-editor-fields';
import { KimiLoginHelp } from './KimiLoginHelp';
import type { MemberText } from './MemberRuntimeFields';
import type { NativeLoginState } from './native-login-state';

export function MemberConfigurationDetails({
  form,
  patch,
  defaultIdentity,
  readiness,
  t,
}: {
  form: HubCatEditorFormState;
  patch: (value: Partial<HubCatEditorFormState>) => void;
  defaultIdentity: boolean;
  readiness?: NativeLoginState;
  t: MemberText;
}) {
  return (
    <details className="text-sm text-cafe-secondary">
      <summary className="min-h-10 cursor-pointer py-2">{t('配置详情', 'Configuration details')}</summary>
      {defaultIdentity && form.clientId === 'kimi' && readiness && <KimiLoginHelp readiness={readiness} t={t} />}
      <p className="mb-3">
        {t(
          '只调整这位伙伴的偏好。安装状态和模型目录不代表调用已验证。',
          'Changes apply to this teammate. Installation and model discovery do not verify an invocation.',
        )}
      </p>
      <SelectField
        label={t('默认值来源', 'Default source')}
        value={form.configurationSource ?? 'managed_account'}
        options={[
          { value: 'native_tool', label: t('工具配置', 'Tool configuration') },
          { value: 'managed_account', label: t('已有连接配置', 'Existing connection configuration') },
        ]}
        onChange={(value) => patch({ configurationSource: value as HubCatEditorFormState['configurationSource'] })}
      />
    </details>
  );
}
