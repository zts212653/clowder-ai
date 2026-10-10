'use client';
import { supportsCodexFastModel } from '@cat-cafe/shared';
import {
  CODEX_APPROVAL_OPTIONS,
  CODEX_AUTH_MODE_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  type CodexRuntimeSettings,
  type HubCatEditorFormState,
} from '../../hub-cat-editor.model';
import { SelectField } from '../../hub-cat-editor-fields';
import type { MemberText } from './MemberRuntimeFields';

export function MemberCodexOptions({
  form,
  authType,
  settings,
  error,
  patch,
  patchSettings,
  retry,
  t,
}: {
  form: HubCatEditorFormState;
  authType?: string;
  settings?: CodexRuntimeSettings;
  error: string | null;
  patch: (change: Partial<HubCatEditorFormState>) => void;
  patchSettings: (change: Partial<CodexRuntimeSettings>) => void;
  retry: () => void;
  t: MemberText;
}) {
  if (form.clientId !== 'openai' || form.acpEnabled) return null;
  return (
    <div className="mt-6 space-y-5">
      {(authType === 'oauth' || form.codexSpeed) && (
        <div className="space-y-2">
          <SelectField
            label={t('速度档位', 'Speed tier')}
            value={form.codexSpeed ?? ''}
            disabled={authType !== 'oauth'}
            options={[
              { value: '', label: t('跟随 Codex 设置', 'Inherit Codex settings') },
              { value: 'standard', label: 'Standard' },
              {
                value: 'fast',
                label: supportsCodexFastModel(form.defaultModel)
                  ? 'Fast'
                  : t('Fast（当前模型未确认支持）', 'Fast (model support unconfirmed)'),
                disabled: !supportsCodexFastModel(form.defaultModel),
              },
            ]}
            onChange={(value) => patch({ codexSpeed: value as HubCatEditorFormState['codexSpeed'] })}
          />
          <p className="text-sm text-cafe-secondary">
            {t(
              '仅当前成员的 OAuth 请求档位；与思考强度独立，不代表上游实际服务档位。未确认身份时保留已有值。',
              'OAuth request tier for this teammate, separate from effort. Actual upstream service may differ. Existing values stay unchanged when identity is unconfirmed.',
            )}
          </p>
        </div>
      )}
      <details className="rounded-xl border border-[var(--console-border-soft)] p-4">
        <summary className="cursor-pointer text-sm">{t('Codex 全局运行参数', 'Global Codex runtime settings')}</summary>
        <p className="my-4 text-sm text-cafe-secondary">
          {t(
            '影响本实例全部 Codex 成员。仅明确修改的项随底部“保存”提交，不修改工具原始配置文件。',
            'Affects all Codex teammates in this instance. Only edited fields are committed with Save. Original tool configuration files are unchanged.',
          )}
        </p>
        {error ? (
          <div role="alert" className="text-sm">
            <p>{error}</p>
            <button type="button" onClick={retry} className="mt-2 min-h-11 text-cafe-accent">
              {t('重新读取运行参数', 'Reload runtime settings')}
            </button>
          </div>
        ) : !settings ? (
          <p className="text-sm">{t('加载中…', 'Loading…')}</p>
        ) : (
          <div className="space-y-3">
            <SelectField
              label={t('沙箱范围', 'Sandbox')}
              ariaLabel="Codex Sandbox"
              value={settings.sandboxMode}
              options={CODEX_SANDBOX_OPTIONS}
              onChange={(value) => patchSettings({ sandboxMode: value as CodexRuntimeSettings['sandboxMode'] })}
            />
            <SelectField
              label={t('审批策略', 'Approval policy')}
              ariaLabel="Codex Approval"
              value={settings.approvalPolicy}
              options={CODEX_APPROVAL_OPTIONS}
              onChange={(value) => patchSettings({ approvalPolicy: value as CodexRuntimeSettings['approvalPolicy'] })}
            />
            <SelectField
              label={t('认证兼容模式', 'Authentication compatibility mode')}
              ariaLabel="Codex Auth Mode"
              value={settings.authMode}
              options={CODEX_AUTH_MODE_OPTIONS}
              onChange={(value) => patchSettings({ authMode: value as CodexRuntimeSettings['authMode'] })}
            />
          </div>
        )}
      </details>
    </div>
  );
}
