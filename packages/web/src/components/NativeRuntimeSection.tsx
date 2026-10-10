'use client';
import { getCliEffortOptionsForProvider } from '@cat-cafe/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { serializeCommandArgs } from './hub-cat-editor.acp';
import type { ClientId, HubCatEditorFormState } from './hub-cat-editor.model';
import { splitCommandArgs } from './hub-cat-editor.model';
import { SectionCard, SelectField, TextField } from './hub-cat-editor-fields';

interface NativeRuntime {
  id: string;
  label: string;
  clientId: ClientId;
  installed: boolean;
  configuredModel?: string;
  configuredEffort?: string;
  command?: string;
  startupArgs?: string[];
  models: string[];
  acp?: { command: string; startupArgs: string[]; transport?: 'stdio' | 'httpstream' };
}
export function NativeRuntimeSection({
  form,
  onChange,
  children,
}: {
  form: HubCatEditorFormState;
  onChange: (patch: Partial<HubCatEditorFormState>) => void;
  children: ReactNode;
}) {
  const [runtimes, setRuntimes] = useState<NativeRuntime[]>([]);
  const [status, setStatus] = useState('正在探测本机工具…');
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => apiFetch('/api/cats/native-runtimes'))
      .then(async (response) => {
        if (!response.ok) throw new Error('探测失败');
        const result = (await response.json()) as { runtimes: NativeRuntime[] };
        if (!cancelled) {
          setRuntimes(Array.isArray(result.runtimes) ? result.runtimes : []);
          setStatus('');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('暂时无法探测工具。已保存的启动配置仍然保留，可稍后重试。');
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const nativeTool = form.configurationSource === 'native_tool';
  const selected = runtimes.find((runtime) =>
    form.acpEnabled
      ? runtime.acp &&
        runtime.command === form.acpCommand &&
        JSON.stringify(runtime.startupArgs) === JSON.stringify(splitCommandArgs(form.acpStartupArgs))
      : runtime.clientId === form.clientId && runtime.clientId !== 'acp',
  );
  const options = runtimes.map((runtime) => ({
    value: runtime.id,
    disabled: runtime.clientId === 'acp' && !runtime.acp,
    label: `${runtime.label} · ${runtime.installed ? '已发现' : '未发现'}`,
  }));
  if (!selected)
    options.unshift({
      value: 'current',
      disabled: false,
      label: `${form.acpEnabled ? '当前 ACP 工具' : form.clientId === 'openai' ? 'Codex' : form.clientId === 'anthropic' ? 'Claude Code' : '当前 ACP 工具'} · 保留当前配置`,
    });
  const choose = (id: string) => {
    const runtime = runtimes.find((item) => item.id === id);
    if (!runtime) return;
    onChange({
      clientId: runtime.clientId,
      accountRef: '',
      defaultModel: '',
      cliEffort: '',
      cliConfigArgs: [],
      codexCarrier: runtime.clientId === 'openai' ? 'app_server' : '',
      acpEnabled: runtime.clientId === 'acp',
      ...(runtime.acp
        ? {
            acpCommand: runtime.acp.command,
            acpStartupArgs: serializeCommandArgs(runtime.acp.startupArgs),
            acpTransport: runtime.acp.transport ?? 'stdio',
          }
        : {}),
    });
  };
  return (
    <>
      <SectionCard title="运行工具" description="选择本机已安装的工具；登录和服务地址由工具自己的配置管理。">
        <SelectField
          label="配置方式"
          value={nativeTool ? 'native_tool' : 'managed_account'}
          options={[
            { value: 'native_tool', label: '本机工具（推荐）' },
            { value: 'managed_account', label: '高级：指定服务账号' },
          ]}
          onChange={(value) =>
            onChange({
              configurationSource: value as HubCatEditorFormState['configurationSource'],
              ...(value === 'native_tool'
                ? {
                    accountRef: '',
                    defaultModel: '',
                    cliEffort: '',
                    cliConfigArgs: [],
                    codexCarrier: form.clientId === 'openai' ? 'app_server' : '',
                    ...(!['anthropic', 'openai', 'acp'].includes(form.clientId)
                      ? { clientId: 'anthropic', acpEnabled: false }
                      : {}),
                  }
                : {}),
            })
          }
        />
        {nativeTool ? (
          <>
            <SelectField label="本机工具" value={selected?.id ?? 'current'} options={options} onChange={choose} />
            {status ? (
              <p role="status" className="text-xs text-cafe-secondary">
                {status}
              </p>
            ) : null}
            {selected ? (
              <p className="text-xs text-cafe-secondary">
                {selected.installed ? '已发现安装；认证状态尚未验证。' : '尚未发现安装，请确认工具可以正常启动。'}
                {selected.configuredModel ? ` 用户配置中的模型：${selected.configuredModel}。` : ''}
                {selected.configuredEffort ? ` 用户配置中的强度：${selected.configuredEffort}。` : ''}
                实际默认值以工具启动后的配置为准。
              </p>
            ) : null}
            <p className="text-xs text-cafe-secondary">
              保存后，此角色不再使用应用内服务账号。留空的模型和强度跟随工具配置；原有 ACP 启动命令和 profile
              保留。下一次新对话生效。
            </p>
            <details className="rounded-lg bg-[var(--console-field-bg)] p-3">
              <summary className="cursor-pointer text-sm text-cafe">高级：此角色的模型与思考强度</summary>
              <div className="mt-3 space-y-3">
                <TextField
                  label="角色模型"
                  value={form.defaultModel}
                  onChange={(value) => onChange({ defaultModel: value })}
                  placeholder="留空：跟随工具"
                  suggestions={selected?.models ?? []}
                />
                <TextField
                  label="角色思考强度"
                  value={form.cliEffort}
                  onChange={(value) => onChange({ cliEffort: value })}
                  placeholder="留空：跟随工具"
                  suggestions={getCliEffortOptionsForProvider(form.clientId, form.defaultModel) ?? []}
                />
                <button
                  type="button"
                  className="text-xs text-cafe-accent"
                  onClick={() => onChange({ defaultModel: '', cliEffort: '' })}
                >
                  恢复跟随工具
                </button>
                <p className="text-xs text-cafe-secondary">
                  两项可以独立设置，也可输入工具支持的模型或别名。ACP 的模型选项会在建立会话时校验，不支持的覆盖会报错。
                </p>
              </div>
            </details>
          </>
        ) : null}
      </SectionCard>
      {!nativeTool ? children : null}
    </>
  );
}
