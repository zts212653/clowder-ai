'use client';

import { AcpBootstrapDirectoryField } from './AcpBootstrapDirectoryField';

interface Profile {
  id: string;
  name: string;
  command: string;
  startupArgs: string[];
  mcpWhitelist?: string[];
  bootstrapRoot?: string;
}
const inputClass = 'w-full rounded-lg bg-[var(--console-field-bg)] px-3 py-2 text-sm text-cafe';
function decode(value: string): Profile[] | null {
  try {
    const profiles: unknown = JSON.parse(value || '[]');
    return Array.isArray(profiles) &&
      profiles.every(
        (profile) =>
          profile &&
          typeof profile.id === 'string' &&
          typeof profile.name === 'string' &&
          typeof profile.command === 'string' &&
          Array.isArray(profile.startupArgs) &&
          profile.startupArgs.every((arg: unknown) => typeof arg === 'string'),
      )
      ? profiles
      : null;
  } catch {
    return null;
  }
}
export function agentClientConfigurationError(value: string): string | undefined {
  const profiles = decode(value);
  if (!profiles || profiles.length > 32) return '请配置最多 32 个有效的 ACP client。';
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile.id)) return '客户端 ID 需使用小写字母、数字、点、短横线或下划线。';
    if (ids.has(profile.id)) return `客户端 ID 重复：${profile.id}`;
    ids.add(profile.id);
    if (!profile.name.trim() || !profile.command.trim()) return '请填写每个客户端的名称和启动命令。';
    if (
      profile.bootstrapRoot !== undefined &&
      (typeof profile.bootstrapRoot !== 'string' ||
        !/^(?:[a-z]:[\\/]|\/)/i.test(profile.bootstrapRoot) ||
        /[\u0000\r\n]/.test(profile.bootstrapRoot))
    )
      return '引导目录须为运行 Host 的电脑上的绝对路径，或清空后自动选择。';
  }
  return undefined;
}
export function PluginAgentClientsField({
  value,
  onChange,
  presets = [],
}: {
  value: string;
  onChange(value: string): void;
  presets?: Profile[];
}) {
  const profiles = decode(value);
  const validationError = agentClientConfigurationError(value);

  const update = (index: number, patch: Partial<Profile>) => {
    if (profiles)
      onChange(JSON.stringify(profiles.map((profile, i) => (i === index ? { ...profile, ...patch } : profile))));
  };
  if (!profiles)
    return (
      <div role="alert" className="space-y-2 text-sm text-cafe-secondary">
        <p>客户端配置格式无效。修复后保存；现有内容不会被自动覆盖。</p>
        <textarea
          className={inputClass}
          aria-label="修复 ACP 客户端配置"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    );
  return (
    <div className="space-y-3">
      {validationError && (
        <p role="alert" className="text-xs text-cafe-secondary">
          {validationError}
        </p>
      )}
      <p className="text-xs text-cafe-secondary">
        配置本机已安装的 ACP 入口，保存并启用插件后，在成员接入设置中选择。CLI 需提供 ACP 模式或已安装的 ACP 桥。
      </p>
      {profiles.map((profile, index) => (
        <fieldset key={profile.id} className="space-y-2 rounded-xl bg-[var(--console-card-bg)] p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs text-cafe-secondary">
              名称
              <input
                className={inputClass}
                aria-label={`客户端 ${index + 1} 名称`}
                value={profile.name}
                onChange={(event) => update(index, { name: event.target.value })}
              />
            </label>
            <label className="text-xs text-cafe-secondary">
              固定 ID（自动生成，改名不变）
              <input className={inputClass} aria-label={`客户端 ${index + 1} ID`} readOnly value={profile.id} />
            </label>
          </div>
          <label className="block text-xs text-cafe-secondary">
            可执行文件或命令
            <input
              className={inputClass}
              aria-label={`客户端 ${index + 1} 命令`}
              placeholder="C:\Program Files\Agent\agent.exe"
              value={profile.command}
              onChange={(event) => update(index, { command: event.target.value })}
            />
          </label>
          <label className="block text-xs text-cafe-secondary">
            启动参数（每行一个，可留空）
            <textarea
              className={inputClass}
              aria-label={`客户端 ${index + 1} 参数`}
              value={profile.startupArgs.join('\n')}
              onChange={(event) =>
                update(index, { startupArgs: event.target.value === '' ? [] : event.target.value.split('\n') })
              }
            />
          </label>
          <AcpBootstrapDirectoryField
            key={profile.id}
            label={`客户端 ${index + 1} 引导目录`}
            value={profile.bootstrapRoot ?? ''}
            onChange={(value) => update(index, { bootstrapRoot: value || undefined })}
          />
          <button
            type="button"
            className="text-xs text-cafe-secondary"
            onClick={() => {
              onChange(JSON.stringify(profiles.filter((_, i) => i !== index)));
            }}
          >
            移除此客户端
          </button>
        </fieldset>
      ))}

      <div className="flex flex-wrap gap-3">
        {[...presets, { id: 'custom', name: '自定义', command: '', startupArgs: [] }].map((preset) => (
          <button
            type="button"
            key={preset.id}
            disabled={profiles.length >= 32}
            className="rounded-lg bg-[var(--console-field-bg)] px-3 py-2 text-xs font-semibold text-cafe"
            onClick={() => {
              const kind = preset.id;
              // getRandomValues also works on an intranet HTTP page; randomUUID
              // is limited to secure contexts. This ID is persisted, never recomputed on rename.
              let id =
                kind === 'custom'
                  ? `client-${Array.from(crypto.getRandomValues(new Uint32Array(3)), (part) => part.toString(36)).join('-')}`
                  : kind;
              let suffix = 2;
              while (profiles.some((profile) => profile.id === id)) id = `${kind}-${suffix++}`;
              onChange(JSON.stringify([...profiles, { ...preset, id }]));
            }}
          >
            添加 {preset.name}
          </button>
        ))}
      </div>
    </div>
  );
}
