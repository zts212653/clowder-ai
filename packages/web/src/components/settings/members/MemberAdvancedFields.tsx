'use client';
import type { ReactNode } from 'react';
import { carrierOptionsForClient, type HubCatEditorFormState } from '../../hub-cat-editor.model';
import { SelectField, TextField } from '../../hub-cat-editor-fields';
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
  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold">{t('高级接入', 'Advanced connection')}</h2>
      <p className="text-sm text-cafe-secondary">
        {t(
          '接入方式决定协议；启动程序与参数不会自动改变协议。',
          'The adapter defines the protocol. A program name does not change it.',
        )}
      </p>
      <SelectField
        label={t('接入方式', 'Adapter')}
        value={form.carrier}
        options={carrierOptionsForClient(form.clientId)}
        onChange={(value) => patch({ carrier: value as HubCatEditorFormState['carrier'] })}
      />
      {form.carrier === 'acp' && (
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
          {fields([
            ['acpMaxLiveProcesses', '最大进程数', 'Maximum processes'],
            ['acpIdleTtlMinutes', '空闲分钟数', 'Idle timeout (minutes)'],
          ])}
        </>
      )}
      {form.carrier !== 'acp' && (
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
        {t(
          '已有权限、沙箱和未显示的扩展配置会保留。账号凭据在“账户与密钥”管理。',
          'Existing permissions, sandbox and unlisted extensions are preserved. Manage credentials in Accounts & keys.',
        )}
      </p>
    </div>
  );
}
