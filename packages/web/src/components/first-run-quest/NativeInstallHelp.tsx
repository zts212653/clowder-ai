import type { RuntimeChoice } from '../settings/members/member-runtime-draft';

export function NativeInstallHelp({ runtime }: { runtime: RuntimeChoice }) {
  const url =
    runtime.clientId === 'openai'
      ? 'https://github.com/openai/codex'
      : runtime.clientId === 'anthropic'
        ? 'https://code.claude.com/docs/en/quickstart'
        : runtime.label === 'DSH'
          ? 'https://github.com/deepseek-ai/deepseek-harness'
          : runtime.label === 'Pi'
            ? 'https://github.com/regadas/pi-acp'
            : runtime.clientId === 'kimi'
              ? 'https://github.com/MoonshotAI/kimi-cli'
              : runtime.clientId === 'opencode'
                ? 'https://opencode.ai/docs/'
                : null;
  return (
    <details className="ml-8 mt-2 text-sm text-cafe-secondary">
      <summary className="min-h-8 cursor-pointer text-cafe-accent">安装与检测帮助</summary>
      <div className="mt-2 space-y-2 leading-relaxed">
        <p>
          {runtime.discoveryStatus === 'acp_profile_missing'
            ? '已找到 DSH 程序，还需要配置 ACP profile，才能加入团队。'
            : runtime.discoveryStatus === 'adapter_missing'
              ? 'Pi 原生 RPC 与 ACP 是不同协议。安装 pi-acp 适配器后重新检测，或使用原手动接入入口配置已有适配器。'
              : `在运行猫咖服务的这台电脑上安装 ${runtime.label}，打开工具完成首次配置。`}
        </p>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="inline-block min-h-8 underline">
            查看 {runtime.label} {runtime.label === 'Pi' ? '适配器说明' : '官方安装说明'} ↗
          </a>
        )}
        <p>
          安装或配置完成后，点击上方“重新检测”。如果仍未发现，请检查工具是否在 PATH 中，以及猫咖服务能否访问其安装目录。
        </p>
      </div>
    </details>
  );
}
