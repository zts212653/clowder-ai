'use client';
import type { HubCatEditorFormState } from './hub-cat-editor.model';
import { agyNativeCopy } from './hub-cat-editor-agy.shell-copy';
import { SelectField, TextAreaField, TextField } from './hub-cat-editor-fields';
import { useEditorText, useMemberEditorPresentation } from './members/editor-presentation';
import { useShellCopy } from './shell/shell-copy';

export function AgyNativeFields({
  form,
  onChange,
  language,
}: {
  form: HubCatEditorFormState;
  onChange: (patch: Partial<HubCatEditorFormState>) => void;
  language?: 'zh' | 'en';
}) {
  const t = useEditorText();
  const translated = useShellCopy(agyNativeCopy);
  const page = useMemberEditorPresentation();
  const copy = language ? agyNativeCopy[language] : page ? translated : agyNativeCopy.zh;
  return (
    <div className="space-y-2" data-testid="agy-native-settings">
      <SelectField
        label={form.agyAcpEnabled ? copy.acpEnabled : t('启用 Native')}
        value={form.agyProfileEnabled === false ? 'false' : 'true'}
        options={[
          { value: 'true', label: t('开启') },
          { value: 'false', label: t('暂停') },
        ]}
        onChange={(value) => onChange({ agyProfileEnabled: value === 'true' })}
      />
      <SelectField
        label={copy.permission}
        value={form.agyAutoApprove ? 'auto' : 'restricted'}
        options={[
          { value: 'restricted', label: copy.restricted },
          { value: 'auto', label: copy.automatic },
        ]}
        onChange={(value) => onChange({ agyAutoApprove: value === 'auto' })}
      />
      <TextField
        label={t('隔离 Profile ID')}
        value={form.agyProfileId ?? form.catId}
        onChange={(value) => onChange({ agyProfileId: value })}
        required
        placeholder="gemini38"
      />
      <TextField
        label={t('Profile 根目录')}
        value={form.agyHomeRoot ?? ''}
        onChange={(value) => onChange({ agyHomeRoot: value })}
        placeholder={t('留空使用 ~/.cat-cafe/agy-profiles')}
      />
      {!form.agyAutoApprove && (
        <TextAreaField
          label={t('批准工作区')}
          value={form.agyTrustedWorkspaces ?? ''}
          onChange={(value) => onChange({ agyTrustedWorkspaces: value })}
          placeholder={t('每行一个完整的工作区绝对路径')}
        />
      )}
      <p className="text-xs leading-5 text-cafe-secondary">
        {form.agyAcpEnabled
          ? copy.acpLogin
          : t(
              '使用此隔离 Profile 中已登录的个人 OAuth。Model 填实际 ID（如 gemini-3.8-flash-high）。首次使用前需完成该 Profile 的登录；保存设置不会启动模型。',
            )}
      </p>
      <p className="text-xs leading-5 text-cafe-muted">
        {form.agyAutoApprove
          ? copy.automaticDescription
          : form.agyAcpEnabled
            ? copy.acpRestricted
            : copy.restrictedDescription}{' '}
        {form.agyAcpEnabled ? copy.acpBinding : copy.bindingChange}
      </p>
      {form.agyAcpEnabled ? (
        <>
          <p className="text-xs leading-5 text-cafe-muted">{copy.acpQueue}</p>
          <details className="text-xs leading-5 text-cafe-secondary">
            <summary>{copy.acpSetup}</summary>
            <code className="break-all">pnpm agy:acp:login --cat {form.catId}</code>
          </details>
        </>
      ) : null}
    </div>
  );
}
