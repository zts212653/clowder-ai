'use client';
import { useAgentClientLibraries } from '@/hooks/useAgentClientLibraries';
import type { HubCatEditorFormState } from './hub-cat-editor.model';

export function PluginAgentClientPicker({
  form,
  onChange,
}: {
  form: HubCatEditorFormState;
  onChange(patch: Partial<HubCatEditorFormState>): void;
}) {
  const { libraries, loading, error } = useAgentClientLibraries();
  const clients = libraries.flatMap((library) => library.clients);
  const selected = clients.find((client) => client.ref === form.acpAgentProvider);
  return (
    <div className="space-y-2">
      <label className="block text-xs font-semibold text-cafe-secondary">
        插件 ACP client
        <select
          aria-label="插件 ACP client"
          className="mt-1 w-full rounded-lg bg-[var(--console-field-bg)] px-3 py-2 text-sm text-cafe"
          value={form.acpAgentProvider ?? ''}
          onChange={(event) =>
            onChange({
              acpAgentProvider: event.target.value || null,
              ...(event.target.value
                ? { configurationSource: 'native_tool', accountRef: '', acpCommand: '', acpStartupArgs: '' }
                : {}),
            })
          }
        >
          <option value="">{loading ? '正在读取插件配置…' : '手动配置 ACP 命令'}</option>
          {form.acpAgentProvider && !selected && (
            <option value={form.acpAgentProvider} disabled>
              当前绑定不可用：{form.acpAgentProvider}
            </option>
          )}
          {clients.map((client) => (
            <option key={client.ref} value={client.ref} disabled={!client.available}>
              {client.name}
              {client.available ? '' : '（请启用插件）'}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="text-xs text-cafe-secondary">
          {error}
        </p>
      )}
      {libraries
        .filter((library) => library.error)
        .map((library) => (
          <p key={library.pluginId} role="alert" className="text-xs text-cafe-secondary">
            {library.pluginId}: {library.error}
          </p>
        ))}
      {!loading && !clients.length && !error && !libraries.some((library) => library.error) && (
        <p className="text-xs text-cafe-secondary">在设置 → 插件中安装并配置 ACP 客户端目录，启用后即可选择。</p>
      )}
      {form.acpAgentProvider && (
        <p className="text-xs text-cafe-secondary">
          {selected?.available
            ? '启动配置由插件提供，认证使用客户端本机配置。保存插件配置后会释放旧连接并应用新配置。'
            : '当前 client 未激活，发送消息将显示不可用。请修复或启用对应插件。'}
        </p>
      )}
    </div>
  );
}
