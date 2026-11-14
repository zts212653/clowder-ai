'use client';
import { defaultAcpPoolMaxProcesses } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { usesAgyAcp, usesAgyNative } from '../../hub-cat-editor.agy';
import type { HubCatEditorFormState } from '../../hub-cat-editor.model';
import { AgyNativeFields } from '../../hub-cat-editor-agy';
import { MemberCarrierSelect } from '../../hub-cat-editor-carrier';
import { SelectField, TextField } from '../../hub-cat-editor-fields';
import { MemberCopyContext, MemberEditorPresentation } from '../../members/editor-presentation';
import { membersCopy } from '../../members/members.shell-copy';
import type { MemberField } from './MemberAdditionalFields';
import type { MemberText } from './MemberRuntimeFields';

export function MemberAdvancedFields({
  form,
  patch,
  t,
  fields,
}: {
  form: HubCatEditorFormState;
  patch: (change: Partial<HubCatEditorFormState>) => void;
  t: MemberText;
  fields: (items: MemberField[]) => ReactNode;
}) {
  const agy = usesAgyNative(form) || usesAgyAcp(form);
  const language = t('zh', 'en') === 'en' ? 'en' : 'zh';
  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">{t('高级接入', 'Advanced connection')}</h2>
      <p className="text-sm text-cafe-secondary">
        {t(
          '接入方式决定协议；启动程序与参数不会自动改变协议。',
          'The adapter defines the protocol. A program name does not change it.',
        )}
      </p>
      <MemberCarrierSelect
        label={t('接入方式', 'Adapter')}
        form={form}
        onChange={(change) => patch({ ...change, acpAgentProvider: null })}
        t={t}
      />
      {form.carrier === 'acp' && (
        <>
          <SelectField
            label={t('ACP 执行确认', 'ACP execution approval')}
            value={form.executionApproval ?? 'auto'}
            options={[
              { value: 'auto', label: t('自动（默认）', 'Auto (default)') },
              { value: 'ask_user', label: t('询问用户', 'Ask user') },
            ]}
            onChange={(value) => patch({ executionApproval: value as 'auto' | 'ask_user' })}
          />
          <p className="text-sm text-cafe-secondary">
            {t(
              '询问用户时，客户端的权限请求会显示为会话中的确认卡片；已有拒绝、隔离和原生权限限制仍然有效。',
              'Ask user shows client permission requests as confirmation cards in the conversation. Existing denials, isolation and native restrictions still apply.',
            )}
          </p>
        </>
      )}
      {agy && (
        <MemberEditorPresentation.Provider value>
          <MemberCopyContext.Provider value={membersCopy[language]}>
            <AgyNativeFields form={form} onChange={patch} language={language} />
          </MemberCopyContext.Provider>
        </MemberEditorPresentation.Provider>
      )}
      {form.acpAgentProvider && (
        <p className="text-sm text-cafe-secondary">
          {t(
            '启动配置由插件管理。请在插件集成中修改对应 client。',
            'The plugin owns launch settings. Edit this client in Plugin integrations.',
          )}
        </p>
      )}
      {form.carrier === 'acp' && !agy && !form.acpAgentProvider && (
        <>
          <TextField
            label={t('启动程序', 'Program')}
            value={form.acpCommand}
            onChange={(acpCommand) => patch({ acpCommand })}
          />
          <TextField
            label={t('启动参数', 'Arguments')}
            value={form.acpStartupArgs}
            onChange={(acpStartupArgs) => patch({ acpStartupArgs })}
          />
          <p className="text-sm text-cafe-secondary">
            {t(
              '含空格的参数使用引号；保留已有 profile。',
              'Quote arguments containing spaces; preserve your existing profile.',
            )}
          </p>
          <SelectField
            label={t('传输', 'Transport')}
            value={form.acpTransport}
            options={[
              { value: 'stdio', label: 'stdio' },
              { value: 'httpstream', label: 'HTTP stream' },
            ]}
            onChange={(value) => patch({ acpTransport: value as 'stdio' | 'httpstream' })}
          />
          <TextField
            label={t('最大进程数', 'Maximum processes')}
            value={form.acpMaxLiveProcesses}
            onChange={(acpMaxLiveProcesses) => patch({ acpMaxLiveProcesses })}
            inputMode="numeric"
            placeholder={String(defaultAcpPoolMaxProcesses(form.clientId))}
          />
          {fields([['acpIdleTtlMinutes', '空闲分钟数', 'Idle timeout (minutes)']])}
        </>
      )}
      {form.carrier !== 'acp' && !agy && (
        <label className="block text-sm">
          {t('额外 CLI 参数（每行一项）', 'Extra CLI arguments (one per line)')}
          <textarea
            className="mt-2 block min-h-24 w-full rounded-lg bg-[var(--console-field-bg)] p-3"
            value={form.cliConfigArgs.join('\n')}
            onChange={(event) => patch({ cliConfigArgs: event.target.value.split('\n') })}
          />
        </label>
      )}
      {form.clientId === 'opencode' && fields([['provider', '供应商标识', 'Provider ID']])}
      {form.clientId === 'antigravity' && fields([['commandArgs', '启动参数', 'Arguments']])}
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={form.mcpSupport}
          onChange={(event) => patch({ mcpSupport: event.target.checked })}
        />
        MCP
      </label>
      <p className="text-sm text-cafe-secondary">
        {agy
          ? t(
              '个人授权保存在此隔离 Profile 中；保存配置不会登录，也不会调用模型。',
              'Personal authorization stays in this isolated Profile. Saving configuration does not sign in or call a model.',
            )
          : t(
              '已有权限、沙箱和未显示的扩展配置会保留。账号凭据在“账户与密钥”管理。',
              'Existing permissions, sandbox and unlisted extensions are preserved. Manage credentials in Accounts & keys.',
            )}
      </p>
    </div>
  );
}
